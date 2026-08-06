/**
 * Inventory stock per product/SKU — one stock bucket regardless of price variant used.
 */

export async function ensureProductStockSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS product_stock (
      product_id INT UNSIGNED NOT NULL PRIMARY KEY,
      qty_on_hand DECIMAL(12,3) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_product_stock_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `).catch(async (e) => {
    if (e.code === "ER_CANNOT_ADD_FOREIGN" || e.code === "ER_NO_REFERENCED_ROW_2") {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS product_stock (
          product_id INT UNSIGNED NOT NULL PRIMARY KEY,
          qty_on_hand DECIMAL(12,3) NOT NULL DEFAULT 0,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
      return;
    }
    if (e.code !== "ER_TABLE_EXISTS_ERROR") throw e;
  });
}

export async function ensureStockRow(db, productId, initialQty = 0) {
  if (!productId) return;
  await db.execute(
    `INSERT INTO product_stock (product_id, qty_on_hand) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE product_id = product_id`,
    [productId, Number(initialQty) || 0]
  );
}

export async function getStockMap(db, productIds) {
  if (!productIds.length) return {};
  try {
    const placeholders = productIds.map(() => "?").join(",");
    const [rows] = await db.execute(
      `SELECT product_id, qty_on_hand FROM product_stock WHERE product_id IN (${placeholders})`,
      productIds
    );
    const map = {};
    for (const r of rows || []) map[String(r.product_id)] = Number(r.qty_on_hand);
    return map;
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") return {};
    throw e;
  }
}

/** delta: negative to consume, positive to restore */
export async function adjustStock(db, productId, delta) {
  if (!productId || !delta) return;
  await ensureStockRow(db, productId, 0);
  await db.execute(
    `UPDATE product_stock SET qty_on_hand = qty_on_hand + ? WHERE product_id = ?`,
    [Number(delta), productId]
  );
}

/** Consume stock for punched items (qty sold). */
export async function consumeStockForItems(db, items) {
  for (const item of items || []) {
    const pid = item.productId || item.product_id;
    const qty = Number(item.quantity || 0);
    if (!pid || qty <= 0) continue;
    await adjustStock(db, pid, -qty);
  }
}

/**
 * Deduct stock for non-voided lines on paid orders (inventory = consumed/sold only).
 */
export async function consumeStockForPaidOrderIds(db, orderIds) {
  const ids = (orderIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  let rows;
  try {
    [rows] = await db.execute(
      `SELECT product_id AS productId, quantity FROM order_items
       WHERE order_id IN (${placeholders}) AND COALESCE(is_voided,0) = 0 AND product_id IS NOT NULL`,
      ids
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [rows] = await db.execute(
      `SELECT product_id AS productId, quantity FROM order_items
       WHERE order_id IN (${placeholders}) AND product_id IS NOT NULL`,
      ids
    );
  }
  await consumeStockForItems(db, rows || []);
}

/**
 * Restore stock for non-voided lines on orders whose payment is being voided
 * (inventory was consumed at pay time).
 */
export async function restoreStockForPaidOrderIds(db, orderIds) {
  const ids = (orderIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return;
  const placeholders = ids.map(() => "?").join(",");
  let rows;
  try {
    [rows] = await db.execute(
      `SELECT product_id AS productId, quantity FROM order_items
       WHERE order_id IN (${placeholders}) AND COALESCE(is_voided,0) = 0 AND product_id IS NOT NULL`,
      ids
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [rows] = await db.execute(
      `SELECT product_id AS productId, quantity FROM order_items
       WHERE order_id IN (${placeholders}) AND product_id IS NOT NULL`,
      ids
    );
  }
  await restoreStockForItems(db, rows || []);
}

/** Restore stock (voids). */
export async function restoreStockForItems(db, items) {
  for (const item of items || []) {
    const pid = item.productId || item.product_id;
    const qty = Number(item.quantity || 0);
    if (!pid || qty <= 0) continue;
    await adjustStock(db, pid, qty);
  }
}

export async function setStockQty(db, productId, qty) {
  if (!productId) return;
  await db.execute(
    `INSERT INTO product_stock (product_id, qty_on_hand) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE qty_on_hand = VALUES(qty_on_hand)`,
    [productId, Number(qty) || 0]
  );
}

export async function migrateProductStock(db) {
  await ensureProductStockSchema(db);
  const [products] = await db.execute("SELECT id FROM products");
  let created = 0;
  for (const p of products || []) {
    const [ex] = await db.execute("SELECT product_id FROM product_stock WHERE product_id = ?", [p.id]);
    if (ex.length) continue;
    await ensureStockRow(db, p.id, 0);
    created += 1;
  }
  return { stockRowsCreated: created };
}
