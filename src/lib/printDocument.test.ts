import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printDocument } from "./printDocument";
import { emptyPrinterAssignments, savePrinterAssignmentsLocal } from "./storage-keys";
import { setQzTrayEnabled } from "./qzTray";

describe("silent document printing", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    savePrinterAssignmentsLocal({ ...emptyPrinterAssignments(), payment_receipt: "Cashier" });
    vi.spyOn(window, "open").mockImplementation(() => { throw new Error("Unexpected popup"); });
    vi.spyOn(window, "print").mockImplementation(() => { throw new Error("Unexpected print dialog"); });
    window.qz = {
      websocket: { isActive: () => true },
      configs: { create: vi.fn().mockReturnValue({ printer: "Cashier" }) },
      print: vi.fn().mockResolvedValue(undefined),
    } as unknown as NonNullable<Window["qz"]>;
  });

  afterEach(() => {
    expect(window.open).not.toHaveBeenCalled();
    expect(window.print).not.toHaveBeenCalled();
    delete window.qz;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends the complete report to the configured printer without a popup", async () => {
    const html = "<html><body>Report with ₱ totals</body></html>";
    await printDocument(html);
    expect(window.qz!.configs.create).toHaveBeenCalledWith("Cashier", { scaleContent: false });
    expect(window.qz!.print).toHaveBeenCalledExactlyOnceWith({ printer: "Cashier" }, [
      { type: "pixel", format: "html", flavor: "plain", data: html },
    ]);
  });

  it("reports printer failure without falling back to a browser window", async () => {
    vi.mocked(window.qz!.print).mockRejectedValue(new Error("Printer offline"));
    await expect(printDocument("<p>Report</p>")).rejects.toThrow("Printer offline");
  });

  it("requires a configured printer", async () => {
    savePrinterAssignmentsLocal(emptyPrinterAssignments());
    await expect(printDocument("<p>Report</p>")).rejects.toThrow("printer not set");
    expect(window.qz!.print).not.toHaveBeenCalled();
  });

  it("explains how to enable silent printing when QZ is disabled", async () => {
    setQzTrayEnabled(false);
    await expect(printDocument("<p>Report</p>")).rejects.toThrow("Enable QZ Tray");
    expect(window.qz!.print).not.toHaveBeenCalled();
  });
});
