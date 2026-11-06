/**
 * QZ Tray — silent thermal printing from the browser.
 * Install: https://qz.io/download/ — run QZ Tray on each POS PC.
 * First launch: allow this site in QZ Tray; for production use certificate signing (qz.io/docs/signing).
 */
import { QZ_TRAY_ENABLED_KEY } from "@/lib/storage-keys";

declare global {
  interface Window {
    qz?: {
      websocket: { connect: (o?: object) => Promise<void>; disconnect: () => void; isActive: () => boolean };
      printers: { find: (query?: string) => Promise<string[]>; getDefault: () => Promise<string> };
      configs: { create: (name: string, opts?: object) => object };
      print: (config: object, data: Array<{ type: string; format: string; flavor?: string; data: string }>) => Promise<void>;
      security: {
        setCertificatePromise: (fn: (resolve: (v: string) => void, reject: (e: Error) => void) => void) => void;
        setSignaturePromise: (fn: (toSign: string) => (resolve: (sig: string) => void, reject: (e: Error) => void) => void) => void;
      };
    };
  }
}

const QZ_CDN = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js";

export function isQzTrayEnabled(): boolean {
  try {
    return localStorage.getItem(QZ_TRAY_ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setQzTrayEnabled(on: boolean): void {
  try {
    localStorage.setItem(QZ_TRAY_ENABLED_KEY, on ? "1" : "0");
  } catch {
    // ignore
  }
}

function loadScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("No window"));
  if (window.qz) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = QZ_CDN;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Could not load QZ Tray script. Check network."));
    document.head.appendChild(s);
  });
}

/**
 * Connect to QZ Tray (localhost WebSocket). User may need to approve once in QZ Tray.
 * Unsigned sites: enable "Allow" in QZ Tray Site Manager for your POS URL.
 */
export async function qzConnect(): Promise<void> {
  await loadScript();
  const qz = window.qz;
  if (!qz) throw new Error("QZ Tray script not available");
  if (!qz.websocket.isActive()) {
    await qz.websocket.connect({ retries: 5, delay: 1 });
  }
}

export async function qzListPrinters(): Promise<string[]> {
  await qzConnect();
  const qz = window.qz!;
  return qz.printers.find();
}

export async function qzPrintRawBase64(printerName: string, base64: string): Promise<void> {
  if (!printerName?.trim()) throw new Error("No printer selected");
  await qzConnect();
  const qz = window.qz!;
  const config = qz.configs.create(printerName.trim(), { encoding: "null", rasterize: false });
  await qz.print(config, [{ type: "raw", format: "base64", data: base64 }]);
}

/** Print an HTML document through QZ without opening a browser window. */
export async function qzPrintHtml(printerName: string, html: string): Promise<void> {
  if (!printerName?.trim()) throw new Error("No printer selected");
  if (!isQzTrayEnabled()) throw new Error("Enable QZ Tray in Settings to print reports without a browser window.");
  await qzConnect();
  const qz = window.qz!;
  const config = qz.configs.create(printerName.trim(), { scaleContent: false });
  await qz.print(config, [{ type: "pixel", format: "html", flavor: "plain", data: html }]);
}
