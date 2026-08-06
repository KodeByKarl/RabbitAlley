/**
 * Seed floor data for manual Transfer / Swap / Merge checks.
 *
 * Scenarios:
 *  - L1 + L2 occupied with distinct items  → Transfer = SWAP (1 step)
 *  - L3 occupied, L4 available             → Transfer = MOVE
 *  - C1 + C2 occupied                      → Merge into one bill (optional)
 *
 * Usage: node server/scripts/seed-transfer-swap.js
 * Login: MGR001 / password (or any manager with transfer_table_orders)
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const {
  DB_HOST = "localhost",
  DB_PORT = 3306,
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_DATABASE = "rabbit_alley_pos",
} = process.env;

const BRANCH_ID = 1;
const SEED_METHOD = "seed_transfer_swap";

function tsMinutesAgo(mins) {
  const d = new Date(Date.now() - mins * 60 * 1000);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function orderDateFromTs(ts) {
  return ts.slice(0, 10);
}

async function ensureTables(conn) {
  const tables = [
    ["L1", "L1", "Lounge"],
    ["L2", "L2", "Lounge"],
    ["L3", "L3", "Lounge"],
    ["L4", "L4", "Lounge"],
    ["C1", "C1", "Club"],
    ["C2", "C2", "Club"],
  ];
  for (const [id, name, area] of tables) {
    await conn.execute(
      `INSERT IGNORE INTO pos_tables (branch_id, id, name, area, status) VALUES (?, ?, ?, ?, 'available')`,
      [BRANCH_ID, id, name, area]
    );
  }
}

async function cleanPreviousSeed(conn) {
  const [oldOrders] = await conn.execute(
    "SELECT id, session_id FROM orders WHERE branch_id = ? AND payment_method = ?",
    [BRANCH_ID, SEED_METHOD]
  );
  if (!oldOrders.length) return;

  const oldIds = oldOrders.map((r) => Number(r.id));
  const placeholders = oldIds.map(() => "?").join(",");
  const sessionIds = [...new Set(oldOrders.map((r) => r.session_id).filter(Boolean))];

  await conn.execute(`DELETE FROM table_transfers WHERE order_id IN (${placeholders})`, oldIds).catch(() => {});
  await conn.execute(`DELETE FROM order_items WHERE order_id IN (${placeholders})`, oldIds);
  await conn.execute(`DELETE FROM orders WHERE id IN (${placeholders})`, oldIds);
  if (sessionIds.length) {
    const sPlaceholders = sessionIds.map(() => "?").join(",");
    await conn.execute(`DELETE FROM table_sessions WHERE id IN (${sPlaceholders})`, sessionIds).catch(() => {});
  }
}

async function openSession(conn, tableId, waiterId, openedMin) {
  const openedAt = tsMinutesAgo(openedMin);
  const [result] = await conn.execute(
    `INSERT INTO table_sessions (branch_id, table_id, waiter_id, opened_at, status)
     VALUES (?, ?, ?, ?, 'open')`,
    [BRANCH_ID, tableId, waiterId, openedAt]
  );
  return Number(result.insertId);
}

async function insertOrder(conn, { tableId, employeeId, createdMin, sessionId }) {
  const createdAt = tsMinutesAgo(createdMin);
  const orderDate = orderDateFromTs(createdAt);
  const [result] = await conn.execute(
    `INSERT INTO orders
      (branch_id, table_id, table_visit_id, session_id, status, payment_method, subtotal, discount, tax, total, employee_id, order_date, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'pending', ?, 0, 0, 0, 0, ?, ?, ?, ?)`,
    [BRANCH_ID, tableId, sessionId, SEED_METHOD, employeeId, orderDate, createdAt, createdAt]
  );
  const orderId = Number(result.insertId);
  await conn.execute(
    `UPDATE orders SET table_visit_id = ? WHERE id = ?`,
    [orderId, orderId]
  ).catch(() => {});
  return orderId;
}

async function insertItem(conn, { orderId, product, qty, department }) {
  const unitPrice = Number(product.price) || 150;
  const subtotal = unitPrice * qty;
  await conn.execute(
    `INSERT INTO order_items
      (order_id, product_id, product_sku, product_name, quantity, unit_price, discount, subtotal,
       department, sent_to_dept, is_complimentary, served_by, is_voided)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1, 0, NULL, 0)`,
    [
      orderId,
      product.id,
      product.sku,
      product.name,
      qty,
      unitPrice,
      subtotal,
      department,
    ]
  );
  return subtotal;
}

async function updateTotals(conn, orderId) {
  const [rows] = await conn.execute(
    `SELECT COALESCE(SUM(CASE WHEN COALESCE(is_voided, 0) = 0 THEN subtotal ELSE 0 END), 0) AS subtotal
     FROM order_items WHERE order_id = ?`,
    [orderId]
  );
  const subtotal = Number(rows[0]?.subtotal || 0);
  await conn.execute("UPDATE orders SET subtotal = ?, total = ? WHERE id = ?", [subtotal, subtotal, orderId]);
  return subtotal;
}

async function occupyTable(conn, tableId, orderId) {
  await conn.execute(
    `UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?`,
    [String(orderId), BRANCH_ID, tableId]
  );
}

async function freeTable(conn, tableId) {
  await conn.execute(
    `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
    [BRANCH_ID, tableId]
  );
}

async function seedParty(conn, { tableId, waiterId, product, qty, label, minsAgo, department }) {
  const sessionId = await openSession(conn, tableId, waiterId, minsAgo);
  const orderId = await insertOrder(conn, {
    tableId,
    employeeId: waiterId,
    createdMin: minsAgo,
    sessionId,
  });
  await insertItem(conn, { orderId, product, qty, department });
  const total = await updateTotals(conn, orderId);
  await occupyTable(conn, tableId, orderId);
  return { tableId, orderId, sessionId, total, label, qty, productName: product.name };
}

async function run() {
  let conn;
  try {
    conn = await mysql.createConnection({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_DATABASE,
    });

    await conn.beginTransaction();
    await ensureTables(conn);
    await cleanPreviousSeed(conn);

    // Reset scenario tables so floor state is clean for this seed
    for (const id of ["L1", "L2", "L3", "L4", "C1", "C2"]) {
      await freeTable(conn, id);
      await conn.execute(
        `UPDATE table_sessions SET status = 'closed', closed_at = NOW(), closed_by = 'seed_transfer_swap'
         WHERE branch_id = ? AND table_id = ? AND status = 'open'`,
        [BRANCH_ID, id]
      ).catch(() => {});
    }

    const [waiterRows] = await conn.execute(
      `SELECT employee_id FROM users
       WHERE branch_id = ? AND active = 1 AND employee_id LIKE 'WTR%'
       ORDER BY id LIMIT 1`,
      [BRANCH_ID]
    );
    const waiterId = waiterRows[0]?.employee_id || "WTR001";

    const [barProducts] = await conn.execute(
      `SELECT id, sku, name, price FROM products
       WHERE status = 'active' AND department = 'Bar' ORDER BY id LIMIT 2`
    );
    const [kitchenProducts] = await conn.execute(
      `SELECT id, sku, name, price FROM products
       WHERE status = 'active' AND department = 'Kitchen' ORDER BY id LIMIT 2`
    );

    const beer = barProducts[0] || { id: null, sku: "SEED-BEER", name: "Beer (seed)", price: 180 };
    const cocktail = barProducts[1] || beer;
    const fries = kitchenProducts[0] || { id: null, sku: "SEED-FRIES", name: "Fries (seed)", price: 120 };
    const wings = kitchenProducts[1] || fries;

    const parties = [];

    // SWAP pair — distinct items so you can verify bills stayed separate after swap
    parties.push(
      await seedParty(conn, {
        tableId: "L1",
        waiterId,
        product: beer,
        qty: 2,
        label: "Party A (swap source)",
        minsAgo: 40,
        department: "Bar",
      })
    );
    parties.push(
      await seedParty(conn, {
        tableId: "L2",
        waiterId,
        product: wings,
        qty: 3,
        label: "Party B (swap target)",
        minsAgo: 25,
        department: "Kitchen",
      })
    );

    // MOVE — L3 → L4 (L4 left empty)
    parties.push(
      await seedParty(conn, {
        tableId: "L3",
        waiterId,
        product: cocktail,
        qty: 1,
        label: "Party C (move source)",
        minsAgo: 15,
        department: "Bar",
      })
    );
    await freeTable(conn, "L4");

    // MERGE pair — optional check that Merge still combines into one bill
    parties.push(
      await seedParty(conn, {
        tableId: "C1",
        waiterId,
        product: fries,
        qty: 2,
        label: "Party D (merge source)",
        minsAgo: 30,
        department: "Kitchen",
      })
    );
    parties.push(
      await seedParty(conn, {
        tableId: "C2",
        waiterId,
        product: beer,
        qty: 4,
        label: "Party E (merge target)",
        minsAgo: 20,
        department: "Bar",
      })
    );

    await conn.commit();

    console.log("\n[seed-transfer-swap] Ready for manual check\n");
    console.log("Floor state:");
    for (const p of parties) {
      console.log(
        `  ${p.tableId}  occupied  order #${p.orderId}  ${p.qty}x ${p.productName}  (₱${p.total})  — ${p.label}`
      );
    }
    console.log("  L4  available  (empty — use as MOVE target)\n");
    console.log("How to test in POS → Transfer Table:");
    console.log("  1) SWAP: From L1 → To L2  (or L2 → L1). Open each table after — bills stay separate.");
    console.log("  2) MOVE: From L3 → To L4. L3 should become available; L4 has Party C.");
    console.log("  3) MERGE (optional): Merge Tables C1 into C2 — one combined bill on C2.\n");
    console.log(`Waiter on seed sessions: ${waiterId}`);
    console.log("Login with a user that has transfer_table_orders (e.g. MGR001 / password).\n");
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error("[seed-transfer-swap] Error:", err.message);
    process.exitCode = 1;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

run();
