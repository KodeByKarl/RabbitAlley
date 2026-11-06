import { qzPrintHtml } from "@/lib/qzTray";
import { getPrinterForJob } from "@/lib/storage-keys";

/** Reports and payslips use the configured cashier receipt printer. */
export async function printDocument(html: string): Promise<void> {
  const printer = getPrinterForJob("payment_receipt");
  if (!printer) throw new Error("Payment receipt printer not set. Configure it in Settings.");
  await qzPrintHtml(printer, html);
}
