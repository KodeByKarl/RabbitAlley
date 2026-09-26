/**
 * Floor servers take orders; cashiers/managers open any table (including ones
 * claimed by another waiter).
 *
 * Pure floor staff = can create orders, cannot accept payments, and is not a
 * supervisory role. Administrator / Operations Staff always bypass table locks.
 */
export function isFloorWaiter(
  hasPermission: (name: string) => boolean,
  role?: string | null
): boolean {
  const roleName = String(role || "").trim().toLowerCase();
  if (roleName === "administrator" || roleName === "operations staff") {
    return false;
  }
  if (
    hasPermission("accept_payments") ||
    hasPermission("manage_settings") ||
    hasPermission("approve_discounts") ||
    hasPermission("approve_voids") ||
    hasPermission("manage_staff")
  ) {
    return false;
  }
  return hasPermission("create_orders");
}
