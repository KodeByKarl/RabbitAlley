/**
 * Product pricing: multiple price entries per SKU/product (inventory identity stays on products).
 */
import { localDateString } from "./localDate.js";

const AREAS = ["Lounge", "Club", "LD"];

export async function ensureProductPricingSchema(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS product_prices (
      id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      product_id INT UNSIGNED NOT NULL,
      label VARCHAR(64) NOT NULL DEFAULT 'Regular',
      area VARCHAR(20) DEFAULT NULL,
      price DECIMAL(10,2) NOT NULL DEFAULT 0,
      effective_from DATE DEFAULT NULL,
      effective_to DATE DEFAULT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_product_prices_product (product_id),
      KEY idx_product_prices_area (product_id, area),
      CONSTRAINT fk_product_prices_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `).catch(async (e) => {
    if (e.code === "ER_CANNOT_ADD_FOREIGN" || e.code === "ER_NO_REFERENCED_ROW_2") {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS product_prices (
          id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          product_id INT UNSIGNED NOT NULL,
          label VARCHAR(64) NOT NULL DEFAULT 'Regular',
          area VARCHAR(20) DEFAULT NULL,
          price DECIMAL(10,2) NOT NULL DEFAULT 0,
          effective_from DATE DEFAULT NULL,
          effective_to DATE DEFAULT NULL,
          is_default TINYINT(1) NOT NULL DEFAULT 0,
          active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_product_prices_product (product_id),
          KEY idx_product_prices_area (product_id, area)
        )
      `);
      return;
    }
    if (e.code !== "ER_TABLE_EXISTS_ERROR") throw e;
  });

  await db.execute("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_sku VARCHAR(64) DEFAULT NULL").catch(() => {});
  await db.execute("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_price_id INT UNSIGNED DEFAULT NULL").catch(() => {});
  try {
    await db.execute("ALTER TABLE order_items ADD KEY idx_order_items_sku (product_sku)");
  } catch {
    // exists
  }
}

function todayStr() {
  return localDateString();
}

function isEffective(row, onDate) {
  const d = onDate || todayStr();
  if (row.effective_from && String(row.effective_from).slice(0, 10) > d) return false;
  if (row.effective_to && String(row.effective_to).slice(0, 10) < d) return false;
  return true;
}

export function mapPriceRow(r) {
  return {
    id: String(r.id),
    productId: String(r.product_id),
    label: r.label || "Regular",
    area: r.area || null,
    price: Number(r.price),
    effectiveFrom: r.effective_from ? String(r.effective_from).slice(0, 10) : null,
    effectiveTo: r.effective_to ? String(r.effective_to).slice(0, 10) : null,
    isDefault: !!r.is_default,
    active: r.active == null ? true : !!r.active,
  };
}

export async function listPricesForProducts(db, productIds) {
  if (!productIds.length) return {};
  const placeholders = productIds.map(() => "?").join(",");
  let rows;
  try {
    [rows] = await db.execute(
      `SELECT id, product_id, label, area, price, effective_from, effective_to, is_default, active
       FROM product_prices WHERE product_id IN (${placeholders}) AND active = 1
       ORDER BY is_default DESC, id`,
      productIds
    );
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") return {};
    throw e;
  }
  const map = {};
  for (const r of rows || []) {
    const key = String(r.product_id);
    if (!map[key]) map[key] = [];
    map[key].push(mapPriceRow(r));
  }
  return map;
}

/** Prices applicable for area + date (area-specific first, then non-area defaults). */
export function filterApplicablePrices(prices, area, onDate) {
  const list = (prices || []).filter((p) => p.active !== false && isEffective(p, onDate));
  if (!list.length) return [];
  if (area) {
    const areaMatches = list.filter((p) => p.area === area);
    if (areaMatches.length) return areaMatches;
  }
  const noArea = list.filter((p) => !p.area);
  if (noArea.length) return noArea;
  return list;
}

export function resolvePriceFromVariants(prices, area, onDate, preferredPriceId) {
  const applicable = filterApplicablePrices(prices, area, onDate);
  if (preferredPriceId) {
    const hit = applicable.find((p) => String(p.id) === String(preferredPriceId));
    if (hit) return hit;
    const any = (prices || []).find((p) => String(p.id) === String(preferredPriceId));
    if (any && isEffective(any, onDate)) return any;
  }
  if (!applicable.length) return null;
  const def = applicable.find((p) => p.isDefault);
  return def || applicable[0];
}

export async function replaceProductPrices(db, productId, pricesInput, basePrice) {
  const prices = Array.isArray(pricesInput) ? pricesInput : [];
  await db.execute("DELETE FROM product_prices WHERE product_id = ?", [productId]);

  const rows = [];
  if (prices.length === 0) {
    rows.push({
      label: "Regular",
      area: null,
      price: Number(basePrice) || 0,
      effectiveFrom: null,
      effectiveTo: null,
      isDefault: true,
    });
  } else {
    let hasDefault = false;
    for (const p of prices) {
      const label = String(p.label || p.area || "Regular").trim().slice(0, 64) || "Regular";
      const area = p.area && AREAS.includes(String(p.area)) ? String(p.area) : null;
      const isDefault = !!p.isDefault && !hasDefault;
      if (isDefault) hasDefault = true;
      rows.push({
        label,
        area,
        price: Math.max(0, Number(p.price) || 0),
        effectiveFrom: p.effectiveFrom || p.effective_from || null,
        effectiveTo: p.effectiveTo || p.effective_to || null,
        isDefault,
      });
    }
    if (!hasDefault && rows.length) rows[0].isDefault = true;
  }

  for (const r of rows) {
    await db.execute(
      `INSERT INTO product_prices (product_id, label, area, price, effective_from, effective_to, is_default, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [productId, r.label, r.area, r.price, r.effectiveFrom, r.effectiveTo, r.isDefault ? 1 : 0]
    );
  }

  // Keep legacy product_area_prices in sync for older code paths
  try {
    await db.execute("DELETE FROM product_area_prices WHERE product_id = ?", [productId]);
    for (const r of rows) {
      if (r.area && AREAS.includes(r.area)) {
        await db.execute(
          "INSERT INTO product_area_prices (product_id, area, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)",
          [productId, r.area, r.price]
        );
      }
    }
  } catch {
    // table may not exist
  }

  // products.price = default variant
  const def = rows.find((r) => r.isDefault) || rows[0];
  if (def) {
    await db.execute("UPDATE products SET price = ? WHERE id = ?", [def.price, productId]);
  }

  return listPricesForProducts(db, [productId]).then((m) => m[String(productId)] || []);
}

/** Build prices array from legacy pricesByArea + base price (for create/update payloads). */
export function pricesFromLegacyPayload(body) {
  if (Array.isArray(body.prices) && body.prices.length) {
    return body.prices.map((p) => ({
      label: p.label,
      area: p.area || null,
      price: Number(p.price) || 0,
      effectiveFrom: p.effectiveFrom || p.effective_from || null,
      effectiveTo: p.effectiveTo || p.effective_to || null,
      isDefault: !!p.isDefault,
    }));
  }
  const rows = [];
  const base = Number(body.price) || 0;
  rows.push({ label: "Regular", area: null, price: base, isDefault: true });
  const pba = body.pricesByArea || {};
  for (const area of AREAS) {
    if (pba[area] != null && pba[area] !== "" && Number(pba[area]) >= 0) {
      rows.push({ label: area, area, price: Number(pba[area]), isDefault: false });
    }
  }
  return rows;
}

export function pricesByAreaFromList(prices) {
  const out = { Lounge: undefined, Club: undefined, LD: undefined };
  for (const p of prices || []) {
    if (p.area && AREAS.includes(p.area)) out[p.area] = Number(p.price);
  }
  return out;
}

/**
 * Backfill product_prices from products.price + product_area_prices.
 * Idempotent: only products with zero price rows.
 */
export async function migrateProductPrices(db) {
  await ensureProductPricingSchema(db);
  const [products] = await db.execute("SELECT id, price FROM products");
  let created = 0;
  for (const p of products || []) {
    const [existing] = await db.execute("SELECT id FROM product_prices WHERE product_id = ? LIMIT 1", [p.id]);
    if (existing.length) continue;
    const prices = [{ label: "Regular", area: null, price: Number(p.price) || 0, isDefault: true }];
    try {
      const [ap] = await db.execute("SELECT area, price FROM product_area_prices WHERE product_id = ?", [p.id]);
      for (const row of ap || []) {
        if (AREAS.includes(row.area)) {
          prices.push({ label: row.area, area: row.area, price: Number(row.price) || 0, isDefault: false });
        }
      }
    } catch {
      // no area table
    }
    await replaceProductPrices(db, p.id, prices, p.price);
    created += prices.length;
  }

  // Snapshot SKU on historical lines
  let skuBackfill = 0;
  try {
    const [r] = await db.execute(
      `UPDATE order_items oi
       INNER JOIN products p ON p.id = oi.product_id
       SET oi.product_sku = p.sku
       WHERE oi.product_sku IS NULL AND oi.product_id IS NOT NULL`
    );
    skuBackfill = r.affectedRows || 0;
  } catch {
    // columns may not exist yet
  }

  return { priceRowsCreated: created, skuLinesBackfilled: skuBackfill };
}
