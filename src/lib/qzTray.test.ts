import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isQzTrayEnabled, qzPrintRawBase64, setQzTrayEnabled } from "./qzTray";
import { buildCustomerReceipt } from "../../server/lib/receiptEscPos.js";

describe("QZ receipt printing", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  afterEach(() => { delete window.qz; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("defaults to QZ while preserving an explicit server LAN selection", () => {
    expect(isQzTrayEnabled()).toBe(true);
    setQzTrayEnabled(false);
    expect(isQzTrayEnabled()).toBe(false);
    setQzTrayEnabled(true);
    expect(isQzTrayEnabled()).toBe(true);
  });

  it("sends a long receipt as one raw job with one cut after the total and footer", async () => {
    const buffer = buildCustomerReceipt({
      orderNumber: "LONG-REPRINT", date: "Nov 06, 2026", time: "12:42 AM",
      table: "A10", cashier: "Staff", isReprint: true,
      items: Array.from({ length: 150 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, subtotal: 100 })),
      subtotal: 15000, serviceCharge: 0, tax: 0, total: 15000,
      paymentMethod: "cash", amountPaid: 15000, change: 0,
    });
    const cut = Buffer.from([0x1d, 0x56, 65, 0]);
    expect(buffer.indexOf(cut)).toBe(buffer.length - cut.length);
    expect(buffer.indexOf(cut)).toBe(buffer.lastIndexOf(cut));
    expect(buffer.toString("latin1")).toContain("Item 149");
    expect(buffer.toString("latin1")).toContain("TOTAL:");
    expect(buffer.toString("latin1")).toContain("NOT A DUPLICATE");

    const print = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockReturnValue({ printer: "Receipt" });
    window.qz = {
      websocket: { isActive: () => true }, configs: { create }, print,
    } as unknown as NonNullable<Window["qz"]>;
    const browserPrint = vi.spyOn(window, "print").mockImplementation(() => {});
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    await qzPrintRawBase64("Receipt", buffer.toString("base64"));
    expect(print).toHaveBeenCalledExactlyOnceWith({ printer: "Receipt" }, [
      { type: "raw", format: "base64", data: buffer.toString("base64") },
    ]);
    expect(browserPrint).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports QZ failure without opening the browser print dialog", async () => {
    window.qz = {
      websocket: { isActive: () => true }, configs: { create: () => ({}) },
      print: vi.fn().mockRejectedValue(new Error("Printer offline")),
    } as unknown as NonNullable<Window["qz"]>;
    const browserPrint = vi.spyOn(window, "print").mockImplementation(() => {});
    await expect(qzPrintRawBase64("Receipt", "YWJj")).rejects.toThrow("Printer offline");
    expect(browserPrint).not.toHaveBeenCalled();
  });
});
