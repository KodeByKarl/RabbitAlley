/**
 * Pending discount / payment-method (card surcharge) for an open table session.
 * Survives Bill Summary print and re-opening the payment modal.
 * Cleared only on successful payment or explicit remove.
 */

export type PendingDiscount = { id: string; name: string; type: string; value: string };

/** Keep only the exact approved discount that staff originally authorized. */
export function validatePendingDiscount(
  discount: PendingDiscount | null,
  discounts: Array<PendingDiscount & { status: string }>
): PendingDiscount | null {
  if (!discount || discount.id === "exact_amount") return discount;
  return discounts.some((d) =>
    String(d.id) === String(discount.id) && d.status === "approved" &&
    d.value === discount.value && d.type === discount.type
  ) ? discount : null;
}

export type PendingBillAdjustments = {
  appliedDiscount: PendingDiscount | null;
  selectedPaymentMethod: string;
  useSplitPayment: boolean;
  splitPayments: Array<{ amount: string; method: string }>;
  chargeCustomerName: string;
  splitChargeNames: Record<string, string>;
};

function storageKey(tableId: string) {
  return `pos_pending_bill_${tableId}`;
}

const defaultSplits = () => [
  { amount: "", method: "cash" },
  { amount: "", method: "gcash" },
];

export function loadPendingBillAdjustments(tableId: string | undefined): PendingBillAdjustments | null {
  if (!tableId || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(storageKey(tableId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingBillAdjustments;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      appliedDiscount: parsed.appliedDiscount ?? null,
      selectedPaymentMethod: parsed.selectedPaymentMethod || "cash",
      useSplitPayment: !!parsed.useSplitPayment,
      splitPayments: Array.isArray(parsed.splitPayments) && parsed.splitPayments.length >= 2
        ? parsed.splitPayments
        : defaultSplits(),
      chargeCustomerName: parsed.chargeCustomerName || "",
      splitChargeNames: parsed.splitChargeNames && typeof parsed.splitChargeNames === "object"
        ? parsed.splitChargeNames
        : {},
    };
  } catch {
    return null;
  }
}

export function savePendingBillAdjustments(
  tableId: string | undefined,
  data: PendingBillAdjustments
): void {
  if (!tableId || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(storageKey(tableId), JSON.stringify(data));
  } catch {
    // quota / private mode
  }
}

export function clearPendingBillAdjustments(tableId: string | undefined): void {
  if (!tableId || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(storageKey(tableId));
  } catch {
    // ignore
  }
}
