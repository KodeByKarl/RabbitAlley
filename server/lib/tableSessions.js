/**
 * First-class table sessions: one continuous customer occupancy of a table.
 * Orders link via orders.session_id. Soft table_visit_id is kept for compatibility.
 */

import { BRANCH_TIMEZONE, localDateString } from "./localDate.js";
import { addDaysYmd } from "./revenueDay.js";

const LEGACY_GAP_MS = 4 * 60 * 60 * 1000;
const PAID_GAP_MS = 60 * 1000;
/** Fallback age cap if last activity is still inside tonight's window. */
export const STALE_SESSION_MS = 20 * 60 * 60 * 1000;
export const LIVE_PENDING_HOURS = 20;
/** Idle waiter claim (open session, no pending orders) older than this is cleared on floor load. */
export const IDLE_CLAIM_MS = 15 * 60 * 1000;
/**
 * Nightclub day-break (matches payroll/sales operational hour 17).
 * Occupancy from before tonight's 5pm Manila window is leftover and must not
 * reappear when waiters log in for the new seating.
 */
export const FLOOR_DAY_START_HOUR = 17;

function manilaHour(date) {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: BRANCH_TIMEZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const hour = parseInt(hourStr, 10);
  return Number.isFinite(hour) && hour === 24 ? 0 : hour;
}

/** Instant of the current floor night start (today 17:00 Manila, or yesterday 17:00 if before 17:00). */
export function getFloorWindowStart(now = new Date(), startHour = FLOOR_DAY_START_HOUR) {
  const ymd = localDateString(now);
  const hour = manilaHour(now);
  const startYmd = hour < startHour ? addDaysYmd(ymd, -1) : ymd;
  const hh = String(Math.min(23, Math.max(0, startHour))).padStart(2, "0");
  return new Date(`${startYmd}T${hh}:00:00+08:00`);
}

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

/**
 * Pending lines that belong to tonight's seating only.
 * Excludes leftover tabs from earlier nights even if they still have this session_id.
 */
export function appendLivePendingSessionFilter(session) {
  const floorStart = getFloorWindowStart();
  const liveCap = new Date(Date.now() - LIVE_PENDING_HOURS * 60 * 60 * 1000);
  const unsessionedMin = new Date(Math.max(floorStart.getTime(), liveCap.getTime()));
  if (session) {
    const openedMs = toMs(session.opened_at);
    const openedFloor = openedMs ? openedMs - 60 * 60 * 1000 : floorStart.getTime();
    const minCreated = new Date(Math.max(openedFloor, unsessionedMin.getTime()));
    return {
      sql: ` AND (
        (session_id = ? AND created_at >= ?)
        OR ((session_id IS NULL OR session_id = 0) AND created_at >= ?)
      )`,
      params: [Number(session.id), minCreated, unsessionedMin],
    };
  }
  return {
    sql: ` AND (session_id IS NULL OR session_id = 0) AND created_at >= ?`,
    params: [unsessionedMin],
  };
}

/** Pending order ids for the current seating only (excludes leftover tabs from earlier nights). */
export async function fetchLivePendingOrderIds(db, branchId, tableId) {
  await closeStaleOpenSessionIfNeeded(db, branchId, tableId);
  const session = await getOpenSession(db, branchId, tableId);
  const live = appendLivePendingSessionFilter(session);
  try {
    const [rows] = await db.execute(
      `SELECT id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}
       ORDER BY id`,
      [branchId, tableId, ...live.params]
    );
    return (rows || []).map((r) => r.id);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    const [rows] = await db.execute(
      `SELECT id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending'
       ${live.sql}
       ORDER BY id`,
      [branchId, tableId, ...live.params]
    );
    return (rows || []).map((r) => r.id);
  }
}

export async function closeStaleOpenSessionIfNeeded(db, branchId, tableId, { maxAgeMs = STALE_SESSION_MS } = {}) {
  const session = await getOpenSession(db, branchId, tableId);
  if (!session) return { closed: false, session: null };
  let lastMs = toMs(session.opened_at);
  try {
    const [rows] = await db.execute(
      `SELECT MAX(created_at) AS lastAt FROM orders WHERE session_id = ?`,
      [session.id]
    );
    const activity = toMs(rows[0]?.lastAt);
    if (activity) lastMs = Math.max(lastMs, activity);
  } catch {
    // orders.session_id may be missing on very old DBs
  }
  const floorStartMs = getFloorWindowStart().getTime();
  const insideTonight = lastMs >= floorStartMs;
  const insideAgeCap = Date.now() - lastMs < maxAgeMs;
  if (insideTonight && insideAgeCap) {
    return { closed: false, session };
  }
  await closeSession(db, session.id, { closedBy: "system:stale-session" });
  await db.execute(
    `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
    [branchId, tableId]
  );
  return { closed: true, session: null };
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

  await closeStaleOpenSessionIfNeeded(db, branchId, tableId);
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

  const live = appendLivePendingSessionFilter(null);
  let pending;
  try {
    [pending] = await db.execute(
      `SELECT employee_id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}
       ORDER BY id LIMIT 1`,
      [branchId, tableId, ...live.params]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT employee_id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending'
       ${live.sql}
       ORDER BY id LIMIT 1`,
      [branchId, tableId, ...live.params]
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

  await closeStaleOpenSessionIfNeeded(db, branchId, tableId);
  const session = await getOpenSession(db, branchId, tableId);
  if (session) {
    const owner = normalizeEmployeeId(session.waiter_id);
    if (owner && owner !== emp) {
      await throwTableInUseByOther(db, branchId, owner);
    }
    return;
  }

  const live = appendLivePendingSessionFilter(null);
  let pending;
  try {
    [pending] = await db.execute(
      `SELECT employee_id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}
       LIMIT 1`,
      [branchId, tableId, ...live.params]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT employee_id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' ${live.sql} LIMIT 1`,
      [branchId, tableId, ...live.params]
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
  const roleName = String(authUser.roleName || authUser.role || "").trim().toLowerCase();
  if (roleName === "administrator" || roleName === "operations staff") {
    return false;
  }
  const perms = authUser.permissions;
  if (
    perms.includes("accept_payments") ||
    perms.includes("manage_settings") ||
    perms.includes("approve_discounts") ||
    perms.includes("approve_voids") ||
    perms.includes("manage_staff")
  ) {
    return false;
  }
  return perms.includes("create_orders");
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

  const live = appendLivePendingSessionFilter(session);
  let pending;
  try {
    [pending] = await db.execute(
      `SELECT id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}
       LIMIT 1`,
      [branchId, tableId, ...live.params]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' ${live.sql} LIMIT 1`,
      [branchId, tableId, ...live.params]
    );
  }
  if (pending.length) return { released: false };

  await closeSession(db, session.id, { closedBy: `waiter:${emp}:release` });
  await db.execute(
    `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
    [branchId, tableId]
  );
  return { released: true };
}

/**
 * Clear ghost "In use" tables on the POS floor:
 * - Occupied / open session with no live pending → vacate (except fresh idle claims still drafting).
 * - Stale open sessions past STALE_SESSION_MS → closed.
 * Tonight's unpaid tabs stay visible until paid.
 */
export async function reconcileFloorTables(db, branchId) {
  if (!branchId) return { vacated: 0 };

  let candidates;
  try {
    [candidates] = await db.execute(
      `SELECT pt.id AS tableId, pt.status AS tableStatus, ts.id AS sessionId,
              ts.waiter_id AS waiterId, ts.opened_at AS sessionOpenedAt
       FROM pos_tables pt
       LEFT JOIN table_sessions ts
         ON ts.branch_id = pt.branch_id AND ts.table_id = pt.id AND ts.status = 'open'
       WHERE pt.branch_id = ?
         AND (pt.status = 'occupied' OR ts.id IS NOT NULL)`,
      [branchId]
    );
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") return { vacated: 0 };
    throw e;
  }

  let vacated = 0;
  const now = Date.now();
  for (const row of candidates || []) {
    const tableId = row.tableId;
    if (!tableId) continue;

    await closeStaleOpenSessionIfNeeded(db, branchId, tableId);
    const session = await getOpenSession(db, branchId, tableId);
    const live = appendLivePendingSessionFilter(session);
    let pending;
    try {
      [pending] = await db.execute(
        `SELECT id FROM orders
         WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
         ${live.sql}
         LIMIT 1`,
        [branchId, tableId, ...live.params]
      );
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
      [pending] = await db.execute(
        `SELECT id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' ${live.sql} LIMIT 1`,
        [branchId, tableId, ...live.params]
      );
    }
    if (pending.length) continue;

    // Fresh idle claim (waiter still drafting cart) — leave locked briefly.
    if (session && session.waiter_id) {
      const age = now - toMs(session.opened_at);
      if (age >= 0 && age < IDLE_CLAIM_MS) continue;
    }

    const didVacate = await vacateTableIfIdle(db, branchId, tableId, {
      closedBy: "system:floor-reconcile",
    });
    if (didVacate) vacated += 1;
  }
  return { vacated };
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

  await closeStaleOpenSessionIfNeeded(db, branchId, tableId);
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
      `SELECT MIN(id) AS anchor FROM orders
       WHERE session_id = ? AND voided_at IS NULL
         AND created_at >= GREATEST(DATE_SUB(?, INTERVAL 1 HOUR), DATE_SUB(NOW(), INTERVAL ${LIVE_PENDING_HOURS} HOUR))`,
      [sessionId, session.opened_at]
    );
    visitAnchor = anchorRows[0]?.anchor != null ? Number(anchorRows[0].anchor) : orderId;
  }

  await attachOrderToSession(db, orderId, sessionId, visitAnchor);

  // Keep visit id in sync for this seating only — never pull leftover pending from other nights.
  try {
    await db.execute(
      `UPDATE orders SET table_visit_id = ?
       WHERE session_id = ? AND status = 'pending' AND voided_at IS NULL
         AND created_at >= DATE_SUB((SELECT opened_at FROM table_sessions WHERE id = ?), INTERVAL 1 HOUR)`,
      [visitAnchor, sessionId, sessionId]
    );
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        await db.execute(
          `UPDATE orders SET table_visit_id = ? WHERE session_id = ? AND status = 'pending'`,
          [visitAnchor, sessionId]
        );
      } catch (e2) {
        if (e2.code !== "ER_BAD_FIELD_ERROR") throw e2;
      }
    } else if (e.code !== "ER_NO_SUCH_TABLE") {
      throw e;
    }
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
  const session = await getOpenSession(db, branchId, tableId);
  const live = appendLivePendingSessionFilter(session);
  let pending;
  try {
    [pending] = await db.execute(
      `SELECT id FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}
       LIMIT 1`,
      [branchId, tableId, ...live.params]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [pending] = await db.execute(
      `SELECT id FROM orders WHERE branch_id = ? AND table_id = ? AND status = 'pending' ${live.sql} LIMIT 1`,
      [branchId, tableId, ...live.params]
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
      `UPDATE orders SET table_id = ?
       WHERE branch_id = ? AND (session_id = ? OR table_id = ?) AND status = 'pending'`,
      [toTable, branchId, source.id, fromTable]
    );
    return Number(source.id);
  }

  if (source && target) {
    if (new Date(source.opened_at) < new Date(target.opened_at)) {
      await db.execute(`UPDATE table_sessions SET opened_at = ? WHERE id = ?`, [source.opened_at, target.id]);
    }
    await db.execute(
      `UPDATE orders SET session_id = ?, table_id = ?
       WHERE branch_id = ? AND (session_id = ? OR table_id = ?) AND status = 'pending'`,
      [target.id, toTable, branchId, source.id, fromTable]
    );
    await closeSession(db, source.id, { closedBy: "system:transfer" });
    return Number(target.id);
  }

  if (!source && target) {
    await db.execute(
      `UPDATE orders SET session_id = ?, table_id = ?
       WHERE branch_id = ? AND table_id = ? AND status = 'pending'`,
      [target.id, toTable, branchId, fromTable]
    );
    return Number(target.id);
  }

  // No sessions — open one on target for this seating's pending only
  const liveTarget = appendLivePendingSessionFilter(null);
  const [pending] = await db.execute(
    `SELECT id, employee_id, created_at FROM orders
     WHERE branch_id = ? AND (table_id = ? OR table_id = ?) AND status = 'pending' AND voided_at IS NULL
     ${liveTarget.sql}
     ORDER BY id`,
    [branchId, fromTable, toTable, ...liveTarget.params]
  );
  if (!pending.length) return null;
  const sessionId = await openSession(db, {
    branchId,
    tableId: toTable,
    waiterId: pending[0].employee_id || null,
  });
  if (pending[0].created_at) {
    await db.execute(`UPDATE table_sessions SET opened_at = ? WHERE id = ?`, [pending[0].created_at, sessionId]);
  }
  const visitAnchor = Number(pending[0].id);
  for (const o of pending) {
    await attachOrderToSession(db, o.id, sessionId, visitAnchor);
    await db.execute(`UPDATE orders SET table_id = ? WHERE id = ?`, [toTable, o.id]);
  }
  return sessionId;
}

/**
 * Swap open sessions between two tables (each party keeps its own session/bill).
 * Call after pending orders have already had their table_id values exchanged.
 * Uses a single CASE UPDATE (no temp table_id — fits VARCHAR(16)).
 */
export async function swapOpenSessions(db, branchId, tableA, tableB) {
  const sessionA = await getOpenSession(db, branchId, tableA);
  const sessionB = await getOpenSession(db, branchId, tableB);

  if (!sessionA && !sessionB) return { sessionOnA: null, sessionOnB: null };

  if (sessionA && sessionB) {
    await db.execute(
      `UPDATE table_sessions
       SET table_id = CASE id
         WHEN ? THEN ?
         WHEN ? THEN ?
         ELSE table_id
       END
       WHERE id IN (?, ?)`,
      [sessionA.id, tableB, sessionB.id, tableA, sessionA.id, sessionB.id]
    );
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
      await db.execute(
        `UPDATE orders SET table_id = ? WHERE branch_id = ? AND (session_id = ? OR table_id = ?) AND status = 'pending'`,
        [targetTableId, branchId, source.id, sourceTableId]
      );
      return Number(source.id);
    }
    const [pending] = await db.execute(
      `SELECT id, employee_id, created_at FROM orders WHERE branch_id = ? AND (table_id = ? OR table_id = ?) AND status = 'pending'`,
      [branchId, sourceTableId, targetTableId]
    );
    if (!pending.length) return null;
    const newSessionId = await openSession(db, {
      branchId,
      tableId: targetTableId,
      waiterId: pending[0].employee_id || null,
    });
    if (pending[0].created_at) {
      await db.execute(`UPDATE table_sessions SET opened_at = ? WHERE id = ?`, [pending[0].created_at, newSessionId]);
    }
    for (const o of pending) {
      await attachOrderToSession(db, o.id, newSessionId, Number(pending[0].id));
      await db.execute(`UPDATE orders SET table_id = ? WHERE id = ?`, [targetTableId, o.id]);
    }
    return newSessionId;
  }

  if (source && Number(source.id) !== Number(target.id)) {
    if (new Date(source.opened_at) < new Date(target.opened_at)) {
      await db.execute(`UPDATE table_sessions SET opened_at = ? WHERE id = ?`, [source.opened_at, target.id]);
    }
    await db.execute(
      `UPDATE orders SET session_id = ?, table_id = ?
       WHERE branch_id = ? AND (session_id = ? OR table_id = ?) AND status = 'pending'`,
      [target.id, targetTableId, branchId, source.id, sourceTableId]
    );
    await closeSession(db, source.id, { closedBy: "system:merge" });
  } else {
    await db.execute(
      `UPDATE orders SET session_id = ?, table_id = ?
       WHERE branch_id = ? AND table_id = ? AND status = 'pending'`,
      [target.id, targetTableId, branchId, sourceTableId]
    );
  }

  return Number(target.id);
}

/**
 * Automatically recover any pending orders that were left attached to closed sessions or unlinked.
 * Moves them to their table's current open session (or opens a new session for the table).
 */
export async function reconcileOrphanedPendingOrders(db, branchId = 1) {
  try {
    // Only tonight's orphans — leftover pending from earlier nights must not re-open tables on waiter login.
    const floorStart = getFloorWindowStart();
    let orphans;
    try {
      [orphans] = await db.execute(
        `
      SELECT o.id, o.table_id, o.session_id, o.created_at, o.employee_id, ts.status as session_status
      FROM orders o
      LEFT JOIN table_sessions ts ON ts.id = o.session_id
      WHERE o.branch_id = ? AND o.status = 'pending'
        AND o.voided_at IS NULL
        AND (o.session_id IS NULL OR ts.status = 'closed')
        AND o.created_at >= ?
    `,
        [branchId, floorStart]
      );
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
      [orphans] = await db.execute(
        `
      SELECT o.id, o.table_id, o.session_id, o.created_at, o.employee_id, ts.status as session_status
      FROM orders o
      LEFT JOIN table_sessions ts ON ts.id = o.session_id
      WHERE o.branch_id = ? AND o.status = 'pending'
        AND (o.session_id IS NULL OR ts.status = 'closed')
        AND o.created_at >= ?
    `,
        [branchId, floorStart]
      );
    }

    if (!orphans || !orphans.length) return;

    for (const orphan of orphans) {
      if (!orphan.table_id) continue;
      const targetSessionId = await ensureSessionForOrder(db, {
        branchId,
        tableId: orphan.table_id,
        orderId: orphan.id,
        waiterId: orphan.employee_id || null,
      });
      if (targetSessionId) {
        const [targetSess] = await db.execute(`SELECT opened_at FROM table_sessions WHERE id = ?`, [targetSessionId]);
        if (targetSess[0] && new Date(orphan.created_at) < new Date(targetSess[0].opened_at)) {
          await db.execute(`UPDATE table_sessions SET opened_at = ? WHERE id = ?`, [orphan.created_at, targetSessionId]);
        }
        await db.execute(`UPDATE orders SET session_id = ? WHERE id = ?`, [targetSessionId, orphan.id]);
        await db.execute(
          `UPDATE pos_tables SET status = 'occupied', current_order_id = COALESCE(current_order_id, ?) WHERE branch_id = ? AND id = ?`,
          [orphan.id, branchId, orphan.table_id]
        );
      }
    }
  } catch (err) {
    if (err.code !== "ER_NO_SUCH_TABLE" && err.code !== "ER_BAD_FIELD_ERROR") {
      console.error("Reconcile orphaned orders error:", err);
    }
  }
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
