/** Capacity limit for the floor map. */
export const MAX_FLOOR_TABLES = 40;

/**
 * Real number of floor tables. The tables API LEFT JOINs table_sessions, so a table
 * with more than one open session comes back as several rows; count unique ids only.
 */
export function countFloorTables(tables: ReadonlyArray<{ id: string }>): number {
  return new Set(tables.map((t) => t.id)).size;
}

export function isFloorAtTableCapacity(tableCount: number): boolean {
  return Number(tableCount) >= MAX_FLOOR_TABLES;
}
