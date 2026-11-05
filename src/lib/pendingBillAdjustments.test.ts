import { beforeEach, describe, expect, it } from "vitest";
import { loadPendingBillAdjustments, savePendingBillAdjustments, validatePendingDiscount } from "./pendingBillAdjustments";

const discount = { id: "15", name: "Promo", type: "Applied", value: "15%" };

describe("saved table discounts", () => {
  beforeEach(() => sessionStorage.clear());

  it("removes a deleted discount when S1 is reopened after visiting another table", () => {
    savePendingBillAdjustments("S1", {
      appliedDiscount: discount, selectedPaymentMethod: "cash", useSplitPayment: false,
      splitPayments: [], chargeCustomerName: "", splitChargeNames: {},
    });
    expect(loadPendingBillAdjustments("S2")).toBeNull();
    const saved = loadPendingBillAdjustments("S1")!;
    const appliedDiscount = validatePendingDiscount(saved.appliedDiscount, []);
    expect(appliedDiscount).toBeNull();
    savePendingBillAdjustments("S1", { ...saved, appliedDiscount });
    expect(loadPendingBillAdjustments("S1")?.appliedDiscount).toBeNull();
  });

  it("preserves an approved unchanged discount", () => {
    expect(validatePendingDiscount(discount, [{ ...discount, status: "approved" }])).toEqual(discount);
  });

  it.each(["pending", "rejected"])("removes a %s discount", (status) => {
    expect(validatePendingDiscount(discount, [{ ...discount, status }])).toBeNull();
  });

  it("requires reapplication after the discount amount changes", () => {
    expect(validatePendingDiscount(discount, [{ ...discount, value: "20%", status: "approved" }])).toBeNull();
  });

  it("preserves a manually authorized exact amount without a catalog entry", () => {
    const exact = { ...discount, id: "exact_amount", value: "100" };
    expect(validatePendingDiscount(exact, [])).toEqual(exact);
  });
});
