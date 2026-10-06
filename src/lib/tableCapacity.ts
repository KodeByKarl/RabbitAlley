/** Capacity limit for the floor map. */
export const MAX_FLOOR_TABLES = 40;

export function isFloorAtTableCapacity(tableCount: number): boolean {
  return Number(tableCount) >= MAX_FLOOR_TABLES;
}
