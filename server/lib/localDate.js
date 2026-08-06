/** Branch business calendar (Philippines). */
export const BRANCH_TIMEZONE = "Asia/Manila";

/**
 * Local YYYY-MM-DD for the branch timezone (not UTC).
 * Avoids "today" flipping a day early before 08:00 PH when using toISOString().
 */
export function localDateString(date = new Date(), timeZone = BRANCH_TIMEZONE) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
