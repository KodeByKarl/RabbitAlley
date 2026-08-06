/**
 * Immutable void audit log — one row per voided line item.
 */

const MIN_REASON_LEN = 3;

export function normalizeVoidReason(reason) {
  const text = String(reason ?? "").trim();
  if (text.length < MIN_REASON_LEN) {
    const err = new Error(`Void reason is required (at least ${MIN_REASON_LEN} characters)`);
    err.status = 400;
    throw err;
  }
  return text.slice(0, 512);
}

export async function ensureVoidLogSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS void_log (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      branch_id INT UNSIGNED NOT NULL DEFAULT 1,
      void_type ENUM('item','order','payment') NOT NULL DEFAULT 'item',
      order_id INT UNSIGNED DEFAULT NULL,
      order_item_id INT UNSIGNED DEFAULT NULL,
      product_id INT UNSIGNED DEFAULT NULL,
      product_sku VARCHAR(64) DEFAULT NULL,
      product_name VARCHAR(128) NOT NULL,
      quantity INT UNSIGNED NOT NULL DEFAULT 1,
      unit_price DECIMAL(10,2) NOT NULL DEFAULT 0,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      table_id VARCHAR(16) DEFAULT NULL,
      session_id BIGINT UNSIGNED DEFAULT NULL,
      voided_by INT UNSIGNED DEFAULT NULL,
      voided_by_name VARCHAR(128) DEFAULT NULL,
      voided_by_employee_id VARCHAR(32) DEFAULT NULL,
      voided_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      reason VARCHAR(512) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      KEY idx_void_log_branch_time (branch_id, voided_at),
      KEY idx_void_log_voided_by (branch_id, voided_by),
      KEY idx_void_log_table (branch_id, table_id),
      KEY idx_void_log_product (product_sku),
      KEY idx_void_log_order (order_id)
    )
  `);
}

/**
 * Insert void_log rows for the given order_item ids (must not yet be voided, or already selected for void).
 * Snapshots qty/amount/name before totals are cleared.
 */
export async function logVoidsForOrderItems(db, {
  branchId,
  orderItemIds,
  voidType = "item",
  reason,
  manager,
  employeeId = null,
}) {
  const ids = (orderItemIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return 0;
  const reasonText = normalizeVoidReason(reason);
  const placeholders = ids.map(() => "?").join(",");

  let rows;
  try {
    [rows] = await db.execute(
      `SELECT oi.id AS orderItemId, oi.order_id AS orderId, oi.product_id AS productId,
              oi.product_sku AS productSku, oi.product_name AS productName,
              oi.quantity, oi.unit_price AS unitPrice, oi.subtotal AS amount,
              o.table_id AS tableId, o.session_id AS sessionId, o.branch_id AS branchId
       FROM order_items oi
       INNER JOIN orders o ON o.id = oi.order_id
       WHERE oi.id IN (${placeholders}) AND COALESCE(oi.is_voided, 0) = 0`,
      ids
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [rows] = await db.execute(
      `SELECT oi.id AS orderItemId, oi.order_id AS orderId, oi.product_id AS productId,
              NULL AS productSku, oi.product_name AS productName,
              oi.quantity, oi.unit_price AS unitPrice, oi.subtotal AS amount,
              o.table_id AS tableId, NULL AS sessionId, o.branch_id AS branchId
       FROM order_items oi
       INNER JOIN orders o ON o.id = oi.order_id
       WHERE oi.id IN (${placeholders})`,
      ids
    );
  }

  let inserted = 0;
  for (const r of rows || []) {
    const qty = Math.max(1, Number(r.quantity) || 1);
    const unitPrice = Number(r.unitPrice) || 0;
    const amount = Number(r.amount) || unitPrice * qty;
    await db.execute(
      `INSERT INTO void_log
        (branch_id, void_type, order_id, order_item_id, product_id, product_sku, product_name,
         quantity, unit_price, amount, table_id, session_id,
         voided_by, voided_by_name, voided_by_employee_id, voided_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        r.branchId ?? branchId,
        voidType,
        r.orderId,
        r.orderItemId,
        r.productId || null,
        r.productSku || null,
        r.productName || "Item",
        qty,
        unitPrice,
        amount,
        r.tableId || null,
        r.sessionId != null ? Number(r.sessionId) : null,
        manager?.id ?? null,
        manager?.name || null,
        employeeId || null,
        reasonText,
      ]
    );
    inserted += 1;
  }
  return inserted;
}

/** Log all non-voided lines on an order (full order void). */
export async function logVoidsForOrder(db, {
  branchId,
  orderId,
  reason,
  manager,
  employeeId = null,
}) {
  let itemIds;
  try {
    const [rows] = await db.execute(
      `SELECT id FROM order_items WHERE order_id = ? AND COALESCE(is_voided, 0) = 0`,
      [orderId]
    );
    itemIds = (rows || []).map((r) => r.id);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    const [rows] = await db.execute(`SELECT id FROM order_items WHERE order_id = ?`, [orderId]);
    itemIds = (rows || []).map((r) => r.id);
  }
  return logVoidsForOrderItems(db, {
    branchId,
    orderItemIds: itemIds,
    voidType: "order",
    reason,
    manager,
    employeeId,
  });
}

/**
 * Audit log when a completed payment is voided (order returns to pending; items stay non-voided).
 * Uses void_type = 'payment' so Void Report can distinguish from item/order voids.
 */
export async function logPaymentVoidForOrder(db, {
  branchId,
  orderId,
  reason,
  manager,
  employeeId = null,
}) {
  let itemIds;
  try {
    const [rows] = await db.execute(
      `SELECT id FROM order_items WHERE order_id = ? AND COALESCE(is_voided, 0) = 0`,
      [orderId]
    );
    itemIds = (rows || []).map((r) => r.id);
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    const [rows] = await db.execute(`SELECT id FROM order_items WHERE order_id = ?`, [orderId]);
    itemIds = (rows || []).map((r) => r.id);
  }
  if (!itemIds.length) {
    // Still record a single audit row when the paid order has no live lines.
    const reasonText = normalizeVoidReason(reason || "Payment void");
    const [orders] = await db.execute(
      `SELECT id, table_id AS tableId, session_id AS sessionId, branch_id AS branchId, total
       FROM orders WHERE id = ?`,
      [orderId]
    );
    const o = orders[0];
    if (!o) return 0;
    await db.execute(
      `INSERT INTO void_log
        (branch_id, void_type, order_id, order_item_id, product_id, product_sku, product_name,
         quantity, unit_price, amount, table_id, session_id,
         voided_by, voided_by_name, voided_by_employee_id, voided_at, reason)
       VALUES (?, 'payment', ?, NULL, NULL, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [
        o.branchId ?? branchId,
        orderId,
        "PAYMENT VOID",
        Number(o.total) || 0,
        Number(o.total) || 0,
        o.tableId || null,
        o.sessionId != null ? Number(o.sessionId) : null,
        manager?.id ?? null,
        manager?.name || null,
        employeeId || null,
        reasonText,
      ]
    );
    return 1;
  }
  return logVoidsForOrderItems(db, {
    branchId,
    orderItemIds: itemIds,
    voidType: "payment",
    reason: reason || "Payment void",
    manager,
    employeeId,
  });
}

/**
 * Backfill void_log from existing voided order_items (reason = legacy placeholder).
 */
export async function backfillLegacyVoids(db) {
  await ensureVoidLogSchema(db);
  const [existing] = await db.execute("SELECT COUNT(*) AS c FROM void_log");
  if (Number(existing[0]?.c || 0) > 0) {
    // Only insert items not already logged
  }

  let rows;
  try {
    [rows] = await db.execute(
      `SELECT oi.id AS orderItemId, oi.order_id AS orderId, oi.product_id AS productId,
              oi.product_sku AS productSku, oi.product_name AS productName,
              oi.quantity, oi.unit_price AS unitPrice, oi.subtotal AS amount,
              oi.voided_by AS voidedBy, oi.voided_by_name AS voidedByName, oi.voided_at AS voidedAt,
              o.table_id AS tableId, o.session_id AS sessionId, o.branch_id AS branchId
       FROM order_items oi
       INNER JOIN orders o ON o.id = oi.order_id
       WHERE COALESCE(oi.is_voided, 0) = 1
         AND NOT EXISTS (SELECT 1 FROM void_log vl WHERE vl.order_item_id = oi.id)`
    );
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE" || e.code === "ER_BAD_FIELD_ERROR") return { inserted: 0 };
    throw e;
  }

  let inserted = 0;
  for (const r of rows || []) {
    const qty = Math.max(1, Number(r.quantity) || 1);
    const unitPrice = Number(r.unitPrice) || 0;
    const amount = Number(r.amount) || unitPrice * qty;
    await db.execute(
      `INSERT INTO void_log
        (branch_id, void_type, order_id, order_item_id, product_id, product_sku, product_name,
         quantity, unit_price, amount, table_id, session_id,
         voided_by, voided_by_name, voided_by_employee_id, voided_at, reason)
       VALUES (?, 'item', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, COALESCE(?, NOW()), ?)`,
      [
        r.branchId || 1,
        r.orderId,
        r.orderItemId,
        r.productId || null,
        r.productSku || null,
        r.productName || "Item",
        qty,
        unitPrice,
        amount,
        r.tableId || null,
        r.sessionId != null ? Number(r.sessionId) : null,
        r.voidedBy || null,
        r.voidedByName || "—",
        r.voidedAt || null,
        "— (legacy, no reason recorded)",
      ]
    );
    inserted += 1;
  }
  return { inserted };
}
