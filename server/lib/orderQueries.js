/** Map a joined order_items row to API item shape. */
import { getOpenSession, appendLivePendingSessionFilter, closeStaleOpenSessionIfNeeded } from "./tableSessions.js";

export function mapOrderItemRow(i) {
  return {
    id: String(i.id),
    productId: String(i.product_id || i.id),
    name: i.product_name,
    quantity: i.quantity,
    unitPrice: Number(i.unit_price),
    discount: Number(i.discount),
    subtotal: Number(i.subtotal),
    department: i.department,
    sentToDept: !!i.sent_to_dept,
    isComplimentary: !!i.is_complimentary,
    servedBy: i.served_by ? String(i.served_by) : null,
    servedByName: i.served_by_name || null,
    specialRequest: i.special_request ?? null,
    isVoided: !!i.is_voided,
    voidedByName: i.voided_by_name || null,
  };
}

const ITEM_SELECT_FULL = `oi.id, oi.order_id, oi.product_id, oi.product_name, oi.quantity, oi.unit_price, oi.discount, oi.subtotal,
  oi.department, oi.sent_to_dept, oi.is_complimentary, oi.served_by, oi.special_request, oi.is_voided, oi.voided_by_name, u.name AS served_by_name`;

const ITEM_SELECT_LEGACY = `oi.id, oi.order_id, oi.product_id, oi.product_name, oi.quantity, oi.unit_price, oi.discount, oi.subtotal,
  oi.department, oi.sent_to_dept, oi.is_complimentary, oi.served_by, u.name AS served_by_name`;

/**
 * Load all items for multiple orders in one query (avoids N+1).
 * @returns {Map<string, object[]>} orderId -> items[]
 */
export async function fetchOrderItemsByOrderIds(db, orderIds) {
  const map = new Map();
  if (!orderIds.length) return map;

  const placeholders = orderIds.map(() => "?").join(",");
  let rows;
  try {
    [rows] = await db.execute(
      `SELECT ${ITEM_SELECT_FULL}
       FROM order_items oi
       LEFT JOIN users u ON u.id = oi.served_by
       WHERE oi.order_id IN (${placeholders})
       ORDER BY oi.order_id, oi.id`,
      orderIds
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [rows] = await db.execute(
      `SELECT ${ITEM_SELECT_LEGACY}
       FROM order_items oi
       LEFT JOIN users u ON u.id = oi.served_by
       WHERE oi.order_id IN (${placeholders})
       ORDER BY oi.order_id, oi.id`,
      orderIds
    );
    rows = (rows || []).map((r) => ({
      ...r,
      special_request: null,
      is_voided: 0,
      voided_by_name: null,
    }));
  }

  for (const row of rows || []) {
    const key = String(row.order_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(mapOrderItemRow(row));
  }
  return map;
}

export function mapOrderHeaderRow(o, items) {
  return {
    id: String(o.id),
    orderNumber: o.order_number ? String(o.order_number) : String(o.id),
    tableId: o.table_id,
    status: o.status,
    subtotal: Number(o.subtotal),
    discount: Number(o.discount),
    tax: Number(o.tax),
    total: Number(o.total),
    employeeId: o.employee_id,
    orderDate: o.order_date,
    voidedAt: o.voided_at || null,
    voidedBy: o.voided_by != null ? String(o.voided_by) : null,
    voidedByName: o.voided_by_name || null,
    items,
  };
}

const ORDER_HEADER_SELECT = `id, table_id, status, subtotal, discount, tax, total, employee_id, order_date, voided_at, voided_by, voided_by_name, order_number`;

const ORDER_HEADER_SELECT_LEGACY = `id, table_id, status, subtotal, discount, tax, total, employee_id, order_date`;

export async function fetchPendingOrdersForTable(db, tableId, branchId) {
  await closeStaleOpenSessionIfNeeded(db, branchId, tableId);
  const session = await getOpenSession(db, branchId, tableId);
  const live = appendLivePendingSessionFilter(session);
  try {
    const [orders] = await db.execute(
      `SELECT ${ORDER_HEADER_SELECT} FROM orders
       WHERE table_id = ? AND status = 'pending' AND branch_id = ? AND voided_at IS NULL
       ${live.sql}
       ORDER BY id`,
      [tableId, branchId, ...live.params]
    );
    return orders;
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    const [orders] = await db.execute(
      `SELECT ${ORDER_HEADER_SELECT_LEGACY} FROM orders
       WHERE table_id = ? AND status = 'pending' AND branch_id = ?
       ${live.sql}
       ORDER BY id`,
      [tableId, branchId, ...live.params]
    );
    return (orders || []).map((o) => ({ ...o, order_number: null, voided_at: null, voided_by: null, voided_by_name: null }));
  }
}
