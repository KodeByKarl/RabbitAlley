import { localDateString } from "./localDate.js";

/** Human-readable order number: YYYYMMDD-0001 (per branch, per calendar day). */
export async function allocateOrderNumber(conn, branchId, orderDate) {
  const dateStr = String(orderDate || localDateString());
  await conn.execute(
    `INSERT INTO order_number_sequences (branch_id, seq_date, last_seq)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE last_seq = last_seq + 1`,
    [branchId, dateStr]
  );
  const [rows] = await conn.execute(
    `SELECT last_seq FROM order_number_sequences WHERE branch_id = ? AND seq_date = ?`,
    [branchId, dateStr]
  );
  const seq = Number(rows[0]?.last_seq || 1);
  const datePart = dateStr.replace(/-/g, "");
  return `${datePart}-${String(seq).padStart(4, "0")}`;
}

export function formatOrderDisplayNumber(order) {
  if (!order) return "";
  if (order.orderNumber) return String(order.orderNumber);
  if (order.order_number) return String(order.order_number);
  if (order.id != null && order.id !== "") return String(order.id);
  return "";
}
