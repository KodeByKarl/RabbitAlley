/** Soft capacity for the floor map — beyond this, call for system maintenance. */
export const MAX_FLOOR_TABLES = 40;

export function isFloorAtTableCapacity(tableCount: number): boolean {
  return Number(tableCount) >= MAX_FLOOR_TABLES;
}
