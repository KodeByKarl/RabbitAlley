/**
 * One payout row per employee for a date range.
 * Prefers an exact period_from/period_to match; otherwise the latest nested period.
 */
export const LATEST_PAYOUT_PER_USER_JOIN = `JOIN (
    SELECT p2.user_id AS userId,
      COALESCE(
        MAX(CASE WHEN p2.period_from = ? AND p2.period_to = ? THEN p2.id END),
        MAX(p2.id)
      ) AS id
    FROM payouts p2
    JOIN users u2 ON u2.id = p2.user_id AND u2.branch_id = ?
    WHERE p2.period_from >= ? AND p2.period_to <= ?
    GROUP BY p2.user_id
  ) latest ON latest.id = p.id`;

/** Params after the outer `users.branch_id = ?` bind. prefer* is exact period; range* is the nested date window. */
export function latestPayoutPerUserParams(branchId, preferFrom, preferTo, rangeFrom = preferFrom, rangeTo = preferTo) {
  return [preferFrom, preferTo, branchId, rangeFrom, rangeTo];
}

/** One row per employee even if overlapping payout periods exist. */
export function dedupePayrollRows(rows) {
  const byUser = new Map();
  for (const r of rows || []) {
    const emp = String(r.employeeId ?? r.employee_id ?? "").trim().toUpperCase();
    const key = emp || String(r.userId ?? r.id);
    const prev = byUser.get(key);
    if (!prev || Number(r.id) > Number(prev.id)) byUser.set(key, r);
  }
  return [...byUser.values()];
}

export async function ensurePayoutsSchema(db) {
  try {
    await db.execute(`
      DELETE p FROM payouts p
      INNER JOIN payouts keep
        ON p.user_id = keep.user_id
       AND p.period_from = keep.period_from
       AND p.period_to = keep.period_to
       AND p.id < keep.id
    `);
  } catch {
    // table may not exist yet
  }
  try {
    await db.execute("ALTER TABLE payouts ADD UNIQUE KEY uk_payouts_user_period (user_id, period_from, period_to)");
  } catch {
    // already exists or table missing
  }
}

/** Parse incentives_breakdown JSON array and sum manual line amounts. */
export function sumIncentivesBreakdown(breakdown) {
  if (!breakdown) return 0;
  try {
    const b = typeof breakdown === "string" ? JSON.parse(breakdown) : breakdown;
    return Array.isArray(b) ? b.reduce((s, x) => s + Number(x.amount || 0), 0) : 0;
  } catch {
    return 0;
  }
}

/** Gross = allowance + commission + incentives + manual breakdown + adjustments. */
export function computePayslipGross(row) {
  const allowance = Number(row.allowance ?? 0);
  const commission = Number(row.commission ?? 0);
  const incentives = Number(row.incentives ?? 0);
  const adjustments = Number(row.adjustments ?? 0);
  const breakdownSum = sumIncentivesBreakdown(row.incentives_breakdown ?? row.incentivesBreakdown);
  return allowance + commission + incentives + breakdownSum + adjustments;
}

export function computePayslipNet(row) {
  return computePayslipGross(row) - Number(row.deductions ?? 0);
}
