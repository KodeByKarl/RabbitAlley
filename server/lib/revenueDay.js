/**
 * Shared revenue-day filter — same attribution as the Sales report:
 * - closed session → closed_at
 * - open session → opened_at
 * - no session → noSessionTsCol / noSessionDateCol
 *
 * Requires: LEFT JOIN table_sessions ts ON ts.id = o.session_id
 *
 * Operational hour (e.g. 17):
 * - Aug 10 → Aug 10 17:00 to Aug 11 17:00 (one night)
 * - Aug 10–Aug 11 → same window (to is the end boundary, not a second night)
 * - Aug 10–Aug 12 → Aug 10 17:00 to Aug 12 17:00 (two nights)
 */
export const REVENUE_DAY_SESSION_JOIN = "LEFT JOIN table_sessions ts ON ts.id = o.session_id";

/** Add days to YYYY-MM-DD without timezone shift. */
export function addDaysYmd(ymd, days) {
  const [y, m, d] = String(ymd || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return String(ymd || "").slice(0, 10);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return dt.toISOString().slice(0, 10);
}

/**
 * Exclusive end date of the operational window (the calendar date at startHour when the window stops).
 * Same from/to → next calendar date. Range → `to` itself.
 */
export function operationalExclusiveEndDate(fromDate, toDate) {
  const from = String(fromDate || "").slice(0, 10);
  const to = String(toDate || fromDate || "").slice(0, 10);
  return from === to ? addDaysYmd(from, 1) : to;
}

/**
 * Stored payout period for an operational window.
 * A single night (Aug 10, or Aug 10–Aug 11 with hour 17) is stored as Aug 10–Aug 10
 * so overlapping date picks do not create duplicate employee rows.
 */
export function preferredPayoutPeriod(fromDate, toDate, startHour) {
  const from = String(fromDate || "").slice(0, 10);
  const to = String(toDate || fromDate || "").slice(0, 10);
  if (startHour != null && !Number.isNaN(Number(startHour))) {
    const end = operationalExclusiveEndDate(from, to);
    if (end === addDaysYmd(from, 1)) {
      return { periodFrom: from, periodTo: from };
    }
  }
  return { periodFrom: from, periodTo: to };
}

/**
 * Session attribution PLUS order created_at must both fall in the operational window.
 * Prevents old orders on a long-lived session from appearing on a later report date.
 */
export function buildRevenueDayAndCreatedFilter(opts) {
  const session = buildRevenueDayFilter(opts);
  const created = buildTimestampDayFilter({
    col: "o.created_at",
    startHour: opts.startHour,
    fromDate: opts.fromDate,
    toDate: opts.toDate,
  });
  return {
    sql: `${session.sql}${created.sql}`,
    params: [...session.params, ...created.params],
  };
}

function padHour(startHour) {
  return String(Math.min(23, Math.max(0, parseInt(String(startHour), 10) || 0))).padStart(2, "0");
}

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
    const hourPad = padHour(startHour);
    const endDate = operationalExclusiveEndDate(fromDate, toDate);
    sql = ` AND (
      (ts.closed_at IS NOT NULL AND ts.closed_at >= CONCAT(?, ' ', ?, ':00:00') AND ts.closed_at < CONCAT(?, ' ', ?, ':00:00'))
      OR (ts.closed_at IS NULL AND ts.opened_at IS NOT NULL AND ts.opened_at >= CONCAT(?, ' ', ?, ':00:00') AND ts.opened_at < CONCAT(?, ' ', ?, ':00:00'))
      OR (o.session_id IS NULL AND ${noSessionTsCol} >= CONCAT(?, ' ', ?, ':00:00') AND ${noSessionTsCol} < CONCAT(?, ' ', ?, ':00:00'))
    )`;
    params.push(
      fromDate, hourPad, endDate, hourPad,
      fromDate, hourPad, endDate, hourPad,
      fromDate, hourPad, endDate, hourPad
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
    const hourPad = padHour(startHour);
    const endDate = operationalExclusiveEndDate(fromDate, toDate);
    sql = ` AND ${col} >= CONCAT(?, ' ', ?, ':00:00') AND ${col} < CONCAT(?, ' ', ?, ':00:00')`;
    params.push(fromDate, hourPad, endDate, hourPad);
  } else {
    sql = ` AND DATE(${col}) BETWEEN ? AND ?`;
    params.push(fromDate, toDate);
  }
  return { sql, params };
}
