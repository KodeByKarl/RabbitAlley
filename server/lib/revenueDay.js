/**
 * Shared revenue-day filter — same attribution as the Sales report:
 * - closed session → closed_at
 * - open session → opened_at
 * - no session → noSessionTsCol / noSessionDateCol
 *
 * Requires: LEFT JOIN table_sessions ts ON ts.id = o.session_id
 */
export const REVENUE_DAY_SESSION_JOIN = "LEFT JOIN table_sessions ts ON ts.id = o.session_id";

/**
 * @param {{ startHour: number|null, fromDate: string, toDate: string, noSessionTsCol?: string, noSessionDateCol?: string }} opts
 * @returns {{ sql: string, params: string[] }}
 */
export function buildRevenueDayFilter({
  startHour,
  fromDate,
  toDate,
  noSessionTsCol = "o.created_at",
  noSessionDateCol = "o.order_date",
}) {
  const params = [];
  let sql = "";
  if (startHour != null && !Number.isNaN(Number(startHour))) {
    const hourPad = String(Math.min(23, Math.max(0, parseInt(String(startHour), 10) || 0))).padStart(2, "0");
    sql = ` AND (
      (ts.closed_at IS NOT NULL AND ts.closed_at >= CONCAT(?, ' ', ?, ':00:00') AND ts.closed_at < CONCAT(DATE_ADD(?, INTERVAL 1 DAY), ' ', ?, ':00:00'))
      OR (ts.closed_at IS NULL AND ts.opened_at IS NOT NULL AND ts.opened_at >= CONCAT(?, ' ', ?, ':00:00') AND ts.opened_at < CONCAT(DATE_ADD(?, INTERVAL 1 DAY), ' ', ?, ':00:00'))
      OR (o.session_id IS NULL AND ${noSessionTsCol} >= CONCAT(?, ' ', ?, ':00:00') AND ${noSessionTsCol} < CONCAT(DATE_ADD(?, INTERVAL 1 DAY), ' ', ?, ':00:00'))
    )`;
    params.push(
      fromDate, hourPad, toDate, hourPad,
      fromDate, hourPad, toDate, hourPad,
      fromDate, hourPad, toDate, hourPad
    );
  } else {
    sql = ` AND (
      (ts.closed_at IS NOT NULL AND DATE(ts.closed_at) BETWEEN ? AND ?)
      OR (ts.closed_at IS NULL AND ts.opened_at IS NOT NULL AND DATE(ts.opened_at) BETWEEN ? AND ?)
      OR (o.session_id IS NULL AND ${noSessionDateCol} BETWEEN ? AND ?)
    )`;
    params.push(fromDate, toDate, fromDate, toDate, fromDate, toDate);
  }
  return { sql, params };
}

/**
 * Operational-day filter on a single timestamp column (e.g. void_log.voided_at).
 * @param {{ col: string, startHour: number|null, fromDate: string, toDate: string }} opts
 */
export function buildTimestampDayFilter({ col, startHour, fromDate, toDate }) {
  const params = [];
  let sql = "";
  if (startHour != null && !Number.isNaN(Number(startHour))) {
    const hourPad = String(Math.min(23, Math.max(0, parseInt(String(startHour), 10) || 0))).padStart(2, "0");
    sql = ` AND ${col} >= CONCAT(?, ' ', ?, ':00:00') AND ${col} < CONCAT(DATE_ADD(?, INTERVAL 1 DAY), ' ', ?, ':00:00')`;
    params.push(fromDate, hourPad, toDate, hourPad);
  } else {
    sql = ` AND DATE(${col}) BETWEEN ? AND ?`;
    params.push(fromDate, toDate);
  }
  return { sql, params };
}
