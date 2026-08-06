/**
 * First-class table sessions: one continuous customer occupancy of a table.
 * Orders link via orders.session_id. Soft table_visit_id is kept for compatibility.
 */

const LEGACY_GAP_MS = 4 * 60 * 60 * 1000;
const PAID_GAP_MS = 60 * 1000;

export async function ensureTableSessionsSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS table_sessions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      branch_id INT UNSIGNED NOT NULL DEFAULT 1,
      table_id VARCHAR(16) NOT NULL,
      waiter_id VARCHAR(32) DEFAULT NULL,
      opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at TIMESTAMP NULL DEFAULT NULL,
      status ENUM('open','closed') NOT NULL DEFAULT 'open',
      closed_by VARCHAR(128) DEFAULT NULL,
      migrated_legacy TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_table_sessions_branch_table (branch_id, table_id, status),
      KEY idx_table_sessions_opened (branch_id, opened_at),
      KEY idx_table_sessions_closed (branch_id, closed_at),
      KEY idx_table_sessions_waiter (branch_id, waiter_id)
    )
  `);
  await db.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS session_id BIGINT UNSIGNED DEFAULT NULL").catch(() => {});
  await db.execute("ALTER TABLE orders ADD INDEX IF NOT EXISTS idx_orders_session (session_id)").catch(() => {});
  // MySQL < 8.0.29 may not support ADD INDEX IF NOT EXISTS — try plain add and ignore duplicate
  try {
    await db.execute("ALTER TABLE orders ADD KEY idx_orders_session (session_id)");
  } catch {
    // already exists
  }
  await db.execute("ALTER TABLE receipt_snapshots ADD COLUMN IF NOT EXISTS session_id BIGINT UNSIGNED DEFAULT NULL").catch(() => {});
  try {
    await db.execute("ALTER TABLE receipt_snapshots ADD KEY idx_receipt_snapshots_session (branch_id, session_id)");
  } catch {
    // already exists
  }
}

export async function getOpenSession(db, branchId, tableId) {
  if (!tableId) return null;
  const [rows] = await db.execute(
    `SELECT id, branch_id, table_id, waiter_id, opened_at, closed_at, status
     FROM table_sessions
     WHERE branch_id = ? AND table_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [branchId, tableId]
  );
  return rows[0] || null;
}

function normalizeEmployeeId(employeeId) {
  return String(employeeId || "").trim().toUpperCase();
}

async function getWaiterDisplayName(db, branchId, employeeId) {
  const emp = normalizeEmployeeId(employeeId);
  if (!emp) return null;
  const [rows] = await db.execute(
    `SELECT COALESCE(NULLIF(TRIM(nickname), ''), name) AS displayName
     FROM users WHERE branch_id = ? AND UPPER(employee_id) = ? AND active = 1 LIMIT 1`,
    [branchId, emp]
  );
  return rows[0]?.displayName || null;
}

async function throwTableInUseByOther(db, branchId, ownerEmployeeId) {
  const name = await getWaiterDisplayName(db, branchId, ownerEmployeeId);
  const err = new Error(
    name ? `This table is being handled by ${name}.` : "This table is in use by another waiter."
  );
  err.status = 403;
  throw err;
}

/**
 * Floor waiter opens a table: create or attach to the open session.
 * Blocks if another waiter's session or pending orders own this table.
 */
export async function claimTableForWaiter(db, branchId, tableId, employeeId) {
  const emp = normalizeEmployeeId(employeeId);
  if (!emp) {
    const err = new Error("Employee ID required");
    err.status = 400;
    throw err;
  }

  const session = await getOpenSession(db, branchId, tableId);
  if (session) {
    const owner = normalizeEmployeeId(session.waiter_id);
    if (owner && owner !== emp) {
      await throwTableInUseByOther(db, branchId, owner);
    }
    if (!owner) {
      await db.execute(`UPDATE table_sessions SET waiter_id = ? WHERE id = ?`, [emp, session.id]);
    }
    return Number(session.id);
  }

  let pending;
  try {
    [pending] = await db.execute(
      `SELECT employee_id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ORDER BY id LIMIT 1`,
      [branchId, tableId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT employee_id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending'
       ORDER BY id LIMIT 1`,
      [branchId, tableId]
    );
  }
  if (pending.length) {
    const orderEmp = normalizeEmployeeId(pending[0].employee_id);
    if (orderEmp && orderEmp !== emp) {
      await throwTableInUseByOther(db, branchId, orderEmp);
    }
  }

  return openSession(db, { branchId, tableId, waiterId: emp });
}

/** Verify the waiter still owns this table (session or pending orders). */
export async function assertWaiterOwnsTable(db, branchId, tableId, employeeId) {
  const emp = normalizeEmployeeId(employeeId);
  if (!emp) {
    const err = new Error("Employee ID required");
    err.status = 400;
    throw err;
  }

  const session = await getOpenSession(db, branchId, tableId);
  if (session) {
    const owner = normalizeEmployeeId(session.waiter_id);
    if (owner && owner !== emp) {
      await throwTableInUseByOther(db, branchId, owner);
    }
    return;
  }

  let pending;
  try {
    [pending] = await db.execute(
      `SELECT employee_id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       LIMIT 1`,
      [branchId, tableId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT employee_id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' LIMIT 1`,
      [branchId, tableId]
    );
  }
  if (pending.length) {
    const orderEmp = normalizeEmployeeId(pending[0].employee_id);
    if (orderEmp && orderEmp !== emp) {
      await throwTableInUseByOther(db, branchId, orderEmp);
    }
  }
}

/** Floor waiters take orders; cashiers/managers open any table for payment. */
export function isFloorWaiter(authUser) {
  if (!authUser?.permissions) return false;
  const perms = authUser.permissions;
  return perms.includes("create_orders") && !perms.includes("accept_payments");
}

/**
 * Release a claim when the waiter leaves without sending any orders.
 * No-op if there are pending orders or another waiter owns the session.
 */
export async function releaseTableClaimIfIdle(db, branchId, tableId, employeeId) {
  const emp = normalizeEmployeeId(employeeId);
  if (!emp || !tableId) return { released: false };

  const session = await getOpenSession(db, branchId, tableId);
  if (!session) return { released: false };

  const owner = normalizeEmployeeId(session.waiter_id);
  if (owner && owner !== emp) return { released: false };

  let pending;
  try {
    [pending] = await db.execute(
      `SELECT id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       LIMIT 1`,
      [branchId, tableId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' LIMIT 1`,
      [branchId, tableId]
    );
  }
  if (pending.length) return { released: false };

  await closeSession(db, session.id, { closedBy: `waiter:${emp}:release` });
  return { released: true };
}

/** Open a new session for a fresh seating (table was available). */
export async function openSession(db, { branchId, tableId, waiterId = null }) {
  const [result] = await db.execute(
    `INSERT INTO table_sessions (branch_id, table_id, waiter_id, opened_at, status, migrated_legacy)
     VALUES (?, ?, ?, NOW(), 'open', 0)`,
    [branchId, tableId, waiterId || null]
  );
  return Number(result.insertId);
}

/** Attach an order to a session and keep table_visit_id in sync (anchor = session's first order or session id mapping). */
export async function attachOrderToSession(db, orderId, sessionId, visitAnchorOrderId = null) {
  const visitId = visitAnchorOrderId != null ? visitAnchorOrderId : orderId;
  try {
    await db.execute(`UPDATE orders SET session_id = ?, table_visit_id = ? WHERE id = ?`, [
      sessionId,
      visitId,
      orderId,
    ]);
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        await db.execute(`UPDATE orders SET session_id = ? WHERE id = ?`, [sessionId, orderId]);
      } catch (e2) {
        if (e2.code !== "ER_BAD_FIELD_ERROR") throw e2;
      }
      return;
    }
    throw e;
  }
}

/**
 * Ensure the table has an open session and attach the order.
 * Reuses an existing open session when present (including waiter claim before first order).
 * Opens a new session only when none exists.
 */
export async function ensureSessionForOrder(db, { branchId, tableId, orderId, waiterId, isFreshSeating: _isFreshSeating }) {
  if (!tableId) return null;

  const session = await getOpenSession(db, branchId, tableId);

  let sessionId;
  let visitAnchor;
  if (!session) {
    sessionId = await openSession(db, { branchId, tableId, waiterId });
    visitAnchor = orderId;
  } else {
    sessionId = Number(session.id);
    if (waiterId && !session.waiter_id) {
      await db.execute(`UPDATE table_sessions SET waiter_id = ? WHERE id = ?`, [waiterId, sessionId]);
    }
    const [anchorRows] = await db.execute(
      `SELECT MIN(id) AS anchor FROM orders WHERE session_id = ? AND voided_at IS NULL`,
      [sessionId]
    );
    visitAnchor = anchorRows[0]?.anchor != null ? Number(anchorRows[0].anchor) : orderId;
  }

  await attachOrderToSession(db, orderId, sessionId, visitAnchor);

  // Keep all non-voided pending on this session sharing the same visit anchor
  try {
    await db.execute(
      `UPDATE orders SET table_visit_id = ?, session_id = ?
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL`,
      [visitAnchor, sessionId, branchId, tableId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
  }

  return sessionId;
}

export async function closeSession(db, sessionId, { closedBy = null } = {}) {
  if (!sessionId) return;
  await db.execute(
    `UPDATE table_sessions
     SET status = 'closed', closed_at = COALESCE(closed_at, NOW()), closed_by = COALESCE(?, closed_by)
     WHERE id = ? AND status = 'open'`,
    [closedBy, sessionId]
  );
}

/** Close all open sessions for a table (pay-all / vacate). */
export async function closeOpenSessionForTable(db, branchId, tableId, { closedBy = null } = {}) {
  const [result] = await db.execute(
    `UPDATE table_sessions
     SET status = 'closed', closed_at = COALESCE(closed_at, NOW()), closed_by = COALESCE(?, closed_by)
     WHERE branch_id = ? AND table_id = ? AND status = 'open'`,
    [closedBy, branchId, tableId]
  );
  return result.affectedRows > 0 ? result.affectedRows : null;
}

/**
 * If no non-voided pending orders remain on the table, vacate it and close the session.
 * Returns true if the table was vacated.
 */
export async function vacateTableIfIdle(db, branchId, tableId, { closedBy = null } = {}) {
  if (!tableId) return false;
  let pending;
  try {
    [pending] = await db.execute(
      `SELECT id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       LIMIT 1`,
      [branchId, tableId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' LIMIT 1`,
      [branchId, tableId]
    );
  }
  if (pending.length) return false;

  await closeOpenSessionForTable(db, branchId, tableId, { closedBy });
  await db.execute(
    `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
    [branchId, tableId]
  );
  return true;
}

/**
 * Move an open session (and its pending orders' session link) from one table to another.
 * Used by transfer when the target has no active orders.
 */
export async function transferOpenSession(db, branchId, fromTable, toTable) {
  const source = await getOpenSession(db, branchId, fromTable);
  const target = await getOpenSession(db, branchId, toTable);

  if (source && !target) {
    await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [toTable, source.id]);
    await db.execute(
      `UPDATE orders SET table_id = ? WHERE branch_id = ? AND session_id = ? AND status = 'pending'`,
      [toTable, branchId, source.id]
    );
    return Number(source.id);
  }

  if (source && target) {
    // Attach source orders to target session, close source
    await db.execute(
      `UPDATE orders SET session_id = ?, table_id = ? WHERE branch_id = ? AND session_id = ? AND status = 'pending'`,
      [target.id, toTable, branchId, source.id]
    );
    await closeSession(db, source.id, { closedBy: "system:transfer" });
    return Number(target.id);
  }

  if (!source && target) {
    return Number(target.id);
  }

  // No sessions — open one on target for any pending orders there
  const [pending] = await db.execute(
    `SELECT id, employee_id FROM orders
     WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
     ORDER BY id`,
    [branchId, toTable]
  );
  if (!pending.length) return null;
  const sessionId = await openSession(db, {
    branchId,
    tableId: toTable,
    waiterId: pending[0].employee_id || null,
  });
  const visitAnchor = Number(pending[0].id);
  for (const o of pending) {
    await attachOrderToSession(db, o.id, sessionId, visitAnchor);
  }
  return sessionId;
}

/**
 * Swap open sessions between two tables (each party keeps its own session/bill).
 * Call after pending orders have already had their table_id values exchanged.
 * Uses a temporary table_id so both open sessions never collide on the same table.
 */
export async function swapOpenSessions(db, branchId, tableA, tableB) {
  const sessionA = await getOpenSession(db, branchId, tableA);
  const sessionB = await getOpenSession(db, branchId, tableB);

  if (!sessionA && !sessionB) return { sessionOnA: null, sessionOnB: null };

  const tempTableId = `__swap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (sessionA && sessionB) {
    await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [tempTableId, sessionA.id]);
    await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [tableA, sessionB.id]);
    await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [tableB, sessionA.id]);
    return { sessionOnA: Number(sessionB.id), sessionOnB: Number(sessionA.id) };
  }

  if (sessionA && !sessionB) {
    await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [tableB, sessionA.id]);
    return { sessionOnA: null, sessionOnB: Number(sessionA.id) };
  }

  // sessionB only
  await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [tableA, sessionB.id]);
  return { sessionOnA: Number(sessionB.id), sessionOnB: null };
}

/**
 * Merge source table's open session into target's open session.
 */
export async function mergeSessions(db, branchId, sourceTableId, targetTableId) {
  const source = await getOpenSession(db, branchId, sourceTableId);
  let target = await getOpenSession(db, branchId, targetTableId);

  if (!target) {
    if (source) {
      await db.execute(`UPDATE table_sessions SET table_id = ? WHERE id = ?`, [targetTableId, source.id]);
      return Number(source.id);
    }
    return null;
  }

  if (source && Number(source.id) !== Number(target.id)) {
    await db.execute(
      `UPDATE orders SET session_id = ? WHERE session_id = ?`,
      [target.id, source.id]
    );
    await closeSession(db, source.id, { closedBy: "system:merge" });
  }
  return Number(target.id);
}

function toMs(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Best-effort backfill: create table_sessions from orders.table_visit_id / legacy gaps,
 * and set orders.session_id. Idempotent for orders that already have session_id.
 */
export async function migrateLegacySessions(db, { branchId = null } = {}) {
  await ensureTableSessionsSchema(db);

  let orderSql = `
    SELECT id, branch_id, table_id, table_visit_id, session_id, status, employee_id,
           created_at, updated_at, voided_at
    FROM orders
    WHERE session_id IS NULL AND table_id IS NOT NULL AND table_id != ''
  `;
  const params = [];
  if (branchId != null) {
    orderSql += ` AND branch_id = ?`;
    params.push(branchId);
  }
  orderSql += ` ORDER BY branch_id, table_id, created_at, id`;

  const [orders] = await db.execute(orderSql, params);
  if (!orders.length) return { sessionsCreated: 0, ordersLinked: 0 };

  // Group by branch+table
  const byTable = new Map();
  for (const o of orders) {
    const key = `${o.branch_id}::${o.table_id}`;
    if (!byTable.has(key)) byTable.set(key, []);
    byTable.get(key).push(o);
  }

  let sessionsCreated = 0;
  let ordersLinked = 0;

  for (const group of byTable.values()) {
    // Build visit segments using table_visit_id when present, else time-gap heuristics
    const segments = [];
    let current = null;

    for (let i = 0; i < group.length; i++) {
      const o = group[i];
      const visitId = o.table_visit_id != null && o.table_visit_id !== "" ? Number(o.table_visit_id) : null;

      if (visitId != null && Number.isFinite(visitId) && visitId > 0) {
        if (!current || current.visitKey !== `v:${visitId}`) {
          current = { visitKey: `v:${visitId}`, orders: [] };
          segments.push(current);
        }
        current.orders.push(o);
        continue;
      }

      // Legacy null visit-id path
      if (!current || current.visitKey.startsWith("v:")) {
        current = { visitKey: `l:${o.id}`, orders: [] };
        segments.push(current);
        current.orders.push(o);
        continue;
      }

      const prev = current.orders[current.orders.length - 1];
      const prevT = toMs(prev.created_at);
      const curT = toMs(o.created_at);
      const prevStatus = String(prev.status || "").toLowerCase();
      const curStatus = String(o.status || "").toLowerCase();
      const paidToPending = prevStatus === "paid" && curStatus === "pending";
      const paidGap = prevStatus === "paid" && curStatus === "paid" && curT - prevT > PAID_GAP_MS;
      const longGap = curT - prevT > LEGACY_GAP_MS;

      if (paidToPending || paidGap || longGap) {
        current = { visitKey: `l:${o.id}`, orders: [] };
        segments.push(current);
      }
      current.orders.push(o);
    }

    for (const seg of segments) {
      const first = seg.orders[0];
      const last = seg.orders[seg.orders.length - 1];
      const allPaidOrVoided = seg.orders.every(
        (o) => String(o.status).toLowerCase() === "paid" || o.voided_at != null
      );
      const anyPending = seg.orders.some(
        (o) => String(o.status).toLowerCase() === "pending" && o.voided_at == null
      );
      const status = anyPending ? "open" : "closed";
      const openedAt = first.created_at;
      const closedAt = status === "closed" ? last.updated_at || last.created_at : null;
      const waiterId = first.employee_id || null;
      const isLegacy = seg.visitKey.startsWith("l:");

      // Avoid duplicate open sessions on same table
      if (status === "open") {
        const existing = await getOpenSession(db, first.branch_id, first.table_id);
        if (existing) {
          for (const o of seg.orders) {
            await attachOrderToSession(db, o.id, existing.id, Number(seg.orders[0].id));
            ordersLinked += 1;
          }
          continue;
        }
      }

      const [ins] = await db.execute(
        `INSERT INTO table_sessions
          (branch_id, table_id, waiter_id, opened_at, closed_at, status, migrated_legacy, closed_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          first.branch_id,
          first.table_id,
          waiterId,
          openedAt,
          closedAt,
          status,
          isLegacy ? "migrated_legacy" : "migrated_visit",
        ]
      );
      const sessionId = Number(ins.insertId);
      sessionsCreated += 1;
      const visitAnchor = Number(seg.orders[0].id);
      for (const o of seg.orders) {
        await attachOrderToSession(db, o.id, sessionId, visitAnchor);
        ordersLinked += 1;
      }
    }
  }

  return { sessionsCreated, ordersLinked };
}
