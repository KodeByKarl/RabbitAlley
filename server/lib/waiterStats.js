async function queryWithVoidFallback(db, sqlWithVoid, sqlWithout, params) {
  try {
    const [rows] = await db.execute(sqlWithVoid, params);
    return rows;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      const [rows] = await db.execute(sqlWithout, params);
      return rows;
    }
    throw e;
  }
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Today's LD performance for one staff member (matches payroll: qty × commission_rate).
 * served_by on order_items is users.id; falls back to order.employee_id when unset.
 */
export async function getWaiterDayStats(db, branchId, userId, workDate) {
  const uid = Number(userId);
  if (!Number.isFinite(uid) || uid <= 0) return null;

  const [userRows] = await db.execute(
    `SELECT id, employee_id, commission_rate, incentive_rate FROM users WHERE id = ? AND branch_id = ? AND active = 1`,
    [uid, branchId]
  );
  if (!userRows.length) return null;

  const employeeId = userRows[0].employee_id || "";
  const commissionRate = Number(userRows[0].commission_rate || 0);
  const incentiveRate = Number(userRows[0].incentive_rate || 0);
  const attribution = `(oi.served_by = ? OR (oi.served_by IS NULL AND o.employee_id = ?))`;
  const dateParams = [branchId, workDate, uid, employeeId];

  const allRows = await queryWithVoidFallback(
    db,
    `SELECT COALESCE(SUM(CASE WHEN o.status = 'paid' THEN oi.quantity ELSE 0 END), 0) AS ldCountPaid,
            COALESCE(SUM(CASE WHEN o.status = 'pending' THEN oi.quantity ELSE 0 END), 0) AS ldCountOpen,
            COALESCE(SUM(CASE WHEN o.status = 'paid' THEN oi.subtotal ELSE 0 END), 0) AS ldAmountPaid,
            COALESCE(SUM(oi.quantity), 0) AS ldCountAll
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.branch_id = ? AND o.order_date = ?
       AND o.status IN ('pending','paid') AND oi.department = 'LD'
       AND COALESCE(oi.is_voided, 0) = 0
       AND COALESCE(oi.is_complimentary, 0) = 0
       AND ${attribution}`,
    `SELECT COALESCE(SUM(CASE WHEN o.status = 'paid' THEN oi.quantity ELSE 0 END), 0) AS ldCountPaid,
            COALESCE(SUM(CASE WHEN o.status = 'pending' THEN oi.quantity ELSE 0 END), 0) AS ldCountOpen,
            COALESCE(SUM(CASE WHEN o.status = 'paid' THEN oi.subtotal ELSE 0 END), 0) AS ldAmountPaid,
            COALESCE(SUM(oi.quantity), 0) AS ldCountAll
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.branch_id = ? AND o.order_date = ?
       AND o.status IN ('pending','paid') AND oi.department = 'LD'
       AND ${attribution}`,
    dateParams
  );

  const ldCountPaid = Number(allRows[0]?.ldCountPaid || 0);
  const ldAmountPaid = round2(allRows[0]?.ldAmountPaid || 0);
  const ldCountOpen = Number(allRows[0]?.ldCountOpen || 0);
  const ldCountAll = Number(allRows[0]?.ldCountAll || 0);

  return {
    ldCountPaid,
    ldCountOpen,
    ldAmountPaid,
    commissionRate,
    incentiveRate,
    ldCommission: round2(ldCountAll * commissionRate),
    ldIncentive: round2(ldCountAll * incentiveRate),
  };
}
