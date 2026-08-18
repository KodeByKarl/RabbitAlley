import { Fragment, useCallback, useEffect, useMemo, useState, memo } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  tableStickyHeaderRowClassName,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { StatCard } from "@/components/dashboard/StatCard";
import { FileText, FileSpreadsheet, File, Filter, Calculator, ShoppingBag, DollarSign, Percent, Receipt, Users, CheckCircle, Printer, Download, Plus, ChevronDown, ChevronRight, X, Eye, MapPin, Clock, CreditCard, Package, Search, Ban } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency } from "@/lib/utils";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

type ReportTab = "sales" | "products" | "voids" | "payroll";

interface VoidReportRow {
  id: string;
  voidType: string;
  productName: string;
  productSku: string | null;
  quantity: number;
  amount: number;
  tableId: string | null;
  tableName: string;
  tableArea: string | null;
  sessionId: number | null;
  voidedByName: string;
  voidedByEmployeeId: string | null;
  voidedAtDisplay: string;
  reason: string;
}

interface ProductReportRow {
  sku: string;
  productName: string;
  category?: string;
  productId: string | null;
  quantity: number;
  revenue: number;
  stockQty: number | null;
  variants: Array<{
    priceId: string | null;
    label: string;
    unitPrice: number;
    quantity: number;
    revenue: number;
  }>;
}

interface OrderRow {
  id: string;
  tableId?: string | null;
  area: string;
  table: string;
  employee: string;
  subtotal: number;
  discount: number;
  complimentary: number;
  tax: number;
  cardSurcharge: number;
  total: number;
  status: string;
  time: string;
  visitAnchorOrderId?: number;
  sessionId?: number | null;
  paymentMethod?: string | null;
}

interface SalesGroupRow {
  groupId: string;
  visitAnchorOrderId: number;
  sessionId?: number | null;
  sessionLabel: string;
  area: string;
  table: string;
  tableId: string | null;
  orderCount: number;
  employee: string;
  waiter?: string;
  openedAt?: string | null;
  closedAt?: string | null;
  sessionStatus?: string;
  paymentMethod?: string;
  migratedLegacy?: boolean;
  subtotal: number;
  discount: number;
  complimentary: number;
  tax: number;
  cardSurcharge: number;
  total: number;
  status: string;
  time: string;
  orders: OrderRow[];
}

export interface BreakdownItem {
  title: string;
  amount: number;
}

interface PayrollRow {
  id: string;
  employeeId: string;
  name: string;
  timeIn?: string | null;
  budget: number;
  commission: number;
  /** LD drink qty on paid orders only (legacy; commission uses paid + pending after compute) */
  ldCount?: number;
  /** LD drink qty including open (pending) orders — realtime floor count */
  ldCountRealtime?: number;
  /** Total LD sales amount (sum of LD drink prices for this lady) */
  ldAmount?: number;
  incentives: number;
  adjustments: number;
  deductions: number;
  incentivesBreakdown?: BreakdownItem[] | null;
  adjustmentsBreakdown?: BreakdownItem[] | null;
  deductionsBreakdown?: BreakdownItem[] | null;
  netPayout: number;
  status: string;
  approvedBy: string | null;
}

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Manila",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());


/** Format period (dateFrom, dateTo) as "Salary Slip for July 2025" */
function getSalarySlipMonthYear(dateFrom: string, dateTo: string): string {
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const d = dateTo ? new Date(dateTo) : new Date(dateFrom);
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

/** Convert number to words for "Amount in Words" (e.g. 53500 -> "Fifty Three Thousand Five Hundred") */
function numberToWords(n: number): string {
  const int = Math.round(Math.abs(n));
  if (int === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const teens = ["Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  function to99(x: number): string {
    if (x < 10) return ones[x];
    if (x < 20) return teens[x - 10];
    const t = Math.floor(x / 10), o = x % 10;
    return tens[t] + (o ? " " + ones[o] : "");
  }
  function to999(x: number): string {
    if (x < 100) return to99(x);
    const h = Math.floor(x / 100), r = x % 100;
    return ones[h] + " Hundred" + (r ? " " + to99(r) : "");
  }
  if (int < 1000) return to999(int);
  if (int < 1_000_000) {
    const th = Math.floor(int / 1000), r = int % 1000;
    return to999(th) + " Thousand" + (r ? " " + to999(r) : "");
  }
  const m = Math.floor(int / 1_000_000), r = int % 1_000_000;
  return to999(m) + " Million" + (r ? " " + numberToWords(r) : "");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function payslipBreakdownSum(items?: BreakdownItem[] | null): number {
  return Array.isArray(items) ? items.reduce((s, x) => s + (x.amount ?? 0), 0) : 0;
}

type PayslipLine = { label: string; amount: number };

function payslipIncentiveLines(row: PayrollRow): PayslipLine[] {
  const lines: PayslipLine[] = [];
  if (row.incentives > 0) lines.push({ label: "LD Incentives", amount: row.incentives });
  if (Array.isArray(row.incentivesBreakdown)) {
    for (const item of row.incentivesBreakdown) {
      lines.push({ label: item.title || "Incentive", amount: item.amount });
    }
  }
  return lines;
}

function payslipAdjustmentLines(row: PayrollRow): PayslipLine[] {
  if (Array.isArray(row.adjustmentsBreakdown) && row.adjustmentsBreakdown.length > 0) {
    return row.adjustmentsBreakdown.map((item) => ({ label: item.title || "Adjustment", amount: item.amount }));
  }
  if (row.adjustments !== 0) return [{ label: "Adjustments", amount: row.adjustments }];
  return [];
}

function payslipDeductionLines(row: PayrollRow): PayslipLine[] {
  if (Array.isArray(row.deductionsBreakdown) && row.deductionsBreakdown.length > 0) {
    return row.deductionsBreakdown.map((item) => ({ label: item.title || "Deduction", amount: item.amount }));
  }
  if (row.deductions > 0) return [{ label: "Deductions", amount: row.deductions }];
  return [];
}

function payslipIncentiveSubtotal(row: PayrollRow): number {
  return row.incentives + payslipBreakdownSum(row.incentivesBreakdown);
}

function payslipAdjustmentSubtotal(row: PayrollRow): number {
  return Array.isArray(row.adjustmentsBreakdown) && row.adjustmentsBreakdown.length > 0
    ? payslipBreakdownSum(row.adjustmentsBreakdown)
    : row.adjustments;
}

function payslipDeductionSubtotal(row: PayrollRow): number {
  return Array.isArray(row.deductionsBreakdown) && row.deductionsBreakdown.length > 0
    ? payslipBreakdownSum(row.deductionsBreakdown)
    : row.deductions;
}

function payslipGroupSectionHtml(lines: PayslipLine[], subtotal: number): string {
  const itemRows =
    lines.length > 0
      ? lines
          .map(
            (item) =>
              `<div class="row"><span class="label">${escapeHtml(item.label)}</span><span class="value">${item.amount.toFixed(2)}</span></div>`
          )
          .join("")
      : `<div class="row"><span class="label">—</span><span class="value">0.00</span></div>`;
  return `${itemRows}<div class="row group-total"><span class="label">Total</span><span class="value">${subtotal.toFixed(2)}</span></div>`;
}

function drawPayslipGroupSection(
  doc: jsPDF,
  left: number,
  right: number,
  y: number,
  title: string,
  lines: PayslipLine[],
  subtotal: number
): number {
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.text(title, left, y);
  doc.setFont("helvetica", "normal");
  y += 6;
  doc.setFontSize(10);
  const items = lines.length > 0 ? lines : [{ label: "—", amount: 0 }];
  for (const item of items) {
    const label = item.label.length > 42 ? `${item.label.slice(0, 41)}…` : item.label;
    doc.text(label, left, y);
    doc.text(item.amount.toFixed(2), right, y, { align: "right" });
    y += 5;
  }
  y += 1;
  for (let x = left; x < right; x += 3) doc.line(x, y, Math.min(x + 2, right), y);
  y += 4;
  doc.setFont("helvetica", "bold");
  doc.text("Total", left, y);
  doc.text(subtotal.toFixed(2), right, y, { align: "right" });
  doc.setFont("helvetica", "normal");
  return y + 8;
}

interface PayrollTableRowProps {
  row: PayrollRow;
  onNameClick: (row: PayrollRow) => void;
  onUpdateBreakdown: (row: PayrollRow, field: "incentives" | "adjustments" | "deductions", breakdown: BreakdownItem[]) => void;
  onApprove: (row: PayrollRow) => void;
  onPrintPayslip: (row: PayrollRow) => void;
  onDownloadPayslipPdf: (row: PayrollRow) => void;
  onPrintPayslipThermal: (row: PayrollRow) => void;
}

interface PayrollLdDetail {
  name: string;
  totalLdAll: number;
  ownLdCount: number;
  incentiveRate: number;
  incentives: number;
  tables: Array<{ tableCode: string; ldCount: number }>;
}

function BreakdownCell({
  total,
  breakdown,
  field,
  onUpdate,
  variant,
  disabled,
}: {
  total: number;
  breakdown: BreakdownItem[] | null | undefined;
  field: "incentives" | "adjustments" | "deductions";
  onUpdate: (b: BreakdownItem[]) => void;
  variant: "incentive" | "adjustment" | "deduction";
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addAmount, setAddAmount] = useState("");
  const items = Array.isArray(breakdown) && breakdown.length > 0 ? breakdown : total !== 0 ? [{ title: "Other", amount: total }] : [];
  const variantCls = variant === "incentive" ? "text-green-600" : variant === "deduction" ? "text-destructive" : "";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex items-center justify-end gap-1 w-full min-w-[88px] px-2 py-1.5 rounded-md text-right font-medium hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
            variantCls
          )}
        >
          <span>{formatCurrency(total)}</span>
          {items.length > 0 && <ChevronDown className="w-3 h-3 opacity-60" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3">
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {field === "incentives" ? "Incentives" : field === "adjustments" ? "Adjustments" : "Deductions"} breakdown
          </p>
          <div className="space-y-1.5 max-h-32 overflow-y-auto">
            {items.map((item, i) => (
              <div key={i} className="flex items-center justify-between text-sm py-1 border-b border-border/50 last:border-0">
                <span className="truncate text-muted-foreground">{item.title || "—"}</span>
                <div className="flex items-center gap-1">
                  <span className={cn("font-medium tabular-nums", variant === "deduction" && "text-destructive")}>
                    {formatCurrency(item.amount)}
                  </span>
                  {!disabled && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        const next = [...items];
                        next.splice(i, 1);
                        onUpdate(next.map((x) => ({ title: x.title, amount: x.amount })));
                      }}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {!disabled && (
            <div className="space-y-2 pt-2 border-t">
              <div className="flex gap-2">
                <Input
                  placeholder="Title"
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  className="h-8 text-sm"
                />
                <Input
                  type="number"
                  placeholder="Amount"
                  value={addAmount}
                  onChange={(e) => setAddAmount(e.target.value)}
                  className="h-8 w-20 text-sm"
                />
              </div>
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={() => {
                  const amt = parseFloat(addAmount) || 0;
                  if (!addTitle.trim() && amt === 0) return;
                  const base = Array.isArray(breakdown) && breakdown.length > 0 ? breakdown : (total ? [{ title: "Other", amount: total }] : []);
                  onUpdate([...base, { title: addTitle.trim() || "Other", amount: amt }]);
                  setAddTitle("");
                  setAddAmount("");
                }}
              >
                <Plus className="w-4 h-4 mr-1" />
                Add {field === "incentives" ? "incentive" : field === "adjustments" ? "adjustment" : "deduction"}
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const PayrollTableRow = memo(function PayrollTableRow({
  row,
  onNameClick,
  onUpdateBreakdown,
  onApprove,
  onPrintPayslip,
  onDownloadPayslipPdf,
  onPrintPayslipThermal,
}: PayrollTableRowProps) {
  const disabled = row.status === "approved";
  const otherIncentivesTotal = Array.isArray(row.incentivesBreakdown) ? row.incentivesBreakdown.reduce((s, x) => s + (x.amount ?? 0), 0) : 0;
  return (
    <TableRow>
      <TableCell className="font-medium">
        <button
          type="button"
          onClick={() => onNameClick(row)}
          className="text-left text-primary hover:underline font-medium"
          title="View LD count per table"
        >
          {row.name}
        </button>
      </TableCell>
      <TableCell className="font-mono text-xs">{row.employeeId}</TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground text-sm">{row.timeIn ?? "—"}</TableCell>
      <TableCell className="text-right">{formatCurrency(row.budget)}</TableCell>
      <TableCell className="text-center font-semibold tabular-nums">{row.ldCountRealtime ?? row.ldCount ?? 0}</TableCell>
      <TableCell className="text-right">{formatCurrency(row.commission)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatCurrency(row.incentives)}</TableCell>
      <TableCell className="p-1">
        <BreakdownCell
          total={otherIncentivesTotal}
          breakdown={row.incentivesBreakdown}
          field="incentives"
          variant="incentive"
          disabled={disabled}
          onUpdate={(b) => onUpdateBreakdown(row, "incentives", b)}
        />
      </TableCell>
      <TableCell className="p-1">
        <BreakdownCell
          total={row.adjustments}
          breakdown={row.adjustmentsBreakdown}
          field="adjustments"
          variant="adjustment"
          disabled={disabled}
          onUpdate={(b) => onUpdateBreakdown(row, "adjustments", b)}
        />
      </TableCell>
      <TableCell className="p-1">
        <BreakdownCell
          total={row.deductions}
          breakdown={row.deductionsBreakdown}
          field="deductions"
          variant="deduction"
          disabled={disabled}
          onUpdate={(b) => onUpdateBreakdown(row, "deductions", b)}
        />
      </TableCell>
      <TableCell className="text-right font-semibold">{formatCurrency(row.netPayout)}</TableCell>
      <TableCell>
        <Badge className={cn(
          row.status === "approved"
            ? "bg-success/20 text-success border-success/30"
            : "bg-warning/20 text-warning border-warning/30"
        )}>
          {row.status}
        </Badge>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1 items-center">
          {row.status === "draft" && (
            <Button size="sm" className="bg-success hover:bg-success/90" onClick={() => onApprove(row)}>
              Approve
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => onPrintPayslip(row)} title="Print (browser)">
            <Printer className="w-3 h-3" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => onDownloadPayslipPdf(row)} title="Download PDF">
            <Download className="w-3 h-3" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => onPrintPayslipThermal(row)} title="Print to thermal">
            Thermal
          </Button>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground text-sm">{row.approvedBy ?? "—"}</TableCell>
    </TableRow>
  );
});

export default function Reports() {
  const { user, hasPermission } = useAuth();
  const canViewVoids = hasPermission("approve_voids") || hasPermission("view_audit_logs");
  const canReprintFinalBill =
    hasPermission("print_receipts") ||
    hasPermission("approve_discounts") ||
    hasPermission("manage_settings") ||
    hasPermission("view_reports");
  const [activeTab, setActiveTab] = useState<ReportTab>("sales");
  const [dateFrom, setDateFrom] = useState(today);
  const [dateTo, setDateTo] = useState(today);
  const [salesGroups, setSalesGroups] = useState<SalesGroupRow[]>([]);
  const [salesSummary, setSalesSummary] = useState({
    totalOrders: 0,
    totalSessions: 0,
    paidOrders: 0,
    totalSales: 0,
    totalDiscounts: 0,
    totalComplimentary: 0,
    totalTax: 0,
    totalCardSurcharge: 0,
    openTabsCount: 0,
    openTabsTotal: 0,
  });
  const [productRows, setProductRows] = useState<ProductReportRow[]>([]);
  const [productSummary, setProductSummary] = useState({
    totalSkus: 0,
    totalQuantity: 0,
    totalRevenue: 0,
  });
  const [filterProductSku, setFilterProductSku] = useState("");
  const [filterProductCategory, setFilterProductCategory] = useState("All");
  const [filterProductTableId, setFilterProductTableId] = useState("");
  const [filterProductSessionId, setFilterProductSessionId] = useState("");
  const [productSortBy, setProductSortBy] = useState<"quantity" | "revenue" | "sku" | "name">("revenue");
  const [productSortDir, setProductSortDir] = useState<"asc" | "desc">("desc");
  const [productCategories, setProductCategories] = useState<string[]>([]);
  const [expandedProductSkus, setExpandedProductSkus] = useState<Record<string, boolean>>({});
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [productPrintOpen, setProductPrintOpen] = useState(false);
  const [productPrintStep, setProductPrintStep] = useState<"preparing" | "printing" | "done">("preparing");
  const [voidRows, setVoidRows] = useState<VoidReportRow[]>([]);
  const [voidSummary, setVoidSummary] = useState({
    totalVoids: 0,
    totalQuantity: 0,
    totalAmount: 0,
    listed: 0,
    truncated: false,
  });
  const [loadingVoids, setLoadingVoids] = useState(false);
  const [filterVoidStaff, setFilterVoidStaff] = useState("");
  const [filterVoidProduct, setFilterVoidProduct] = useState("");
  const [filterVoidTableId, setFilterVoidTableId] = useState("");
  const [voidSearch, setVoidSearch] = useState("");
  const [voidPrintOpen, setVoidPrintOpen] = useState(false);
  const [voidPrintStep, setVoidPrintStep] = useState<"preparing" | "printing" | "done">("preparing");
  const [payroll, setPayroll] = useState<PayrollRow[]>([]);
  const [payrollSummary, setPayrollSummary] = useState({
    totalEmployees: 0,
    totalPayout: 0,
    totalIncentives: 0,
    totalDeductions: 0,
    totalLd: 0,
    totalLdPaid: 0,
    totalLdOpen: 0,
    openLdTables: [] as Array<{ tableId: string; tableCode?: string; ldCount: number }>,
  });
  const [payrollSearch, setPayrollSearch] = useState("");
  const [payrollStatusFilter, setPayrollStatusFilter] = useState("All");
  const [payrollSortBy, setPayrollSortBy] = useState<"name" | "netPayout" | "timeIn">("name");
  const [payrollSortDir, setPayrollSortDir] = useState<"asc" | "desc">("asc");
  const [payrollLdDetail, setPayrollLdDetail] = useState<PayrollLdDetail | null>(null);
  const [payrollLdDetailLoading, setPayrollLdDetailLoading] = useState(false);

  const filteredPayroll = useMemo(() => {
    const q = payrollSearch.trim().toLowerCase();
    const rows = payroll.filter((row) => {
      const matchesSearch =
        !q ||
        (row.name || "").toLowerCase().includes(q) ||
        (row.employeeId || "").toLowerCase().includes(q);
      const matchesStatus =
        payrollStatusFilter === "All" ||
        (row.status || "").toLowerCase() === payrollStatusFilter.toLowerCase();
      return matchesSearch && matchesStatus;
    });
    const dir = payrollSortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (payrollSortBy === "netPayout") return (a.netPayout - b.netPayout) * dir;
      if (payrollSortBy === "timeIn") {
        const aTime = a.timeIn || "";
        const bTime = b.timeIn || "";
        return aTime.localeCompare(bTime) * dir;
      }
      return (a.name || "").localeCompare(b.name || "") * dir;
    });
  }, [payroll, payrollSearch, payrollStatusFilter, payrollSortBy, payrollSortDir]);

  const displayPayrollSummary = useMemo(() => {
    const isFiltered = !!payrollSearch.trim() || payrollStatusFilter !== "All";
    if (!isFiltered) return payrollSummary;
    return filteredPayroll.reduce(
      (acc, row) => ({
        totalEmployees: acc.totalEmployees + 1,
        totalPayout: acc.totalPayout + row.netPayout,
        totalIncentives: acc.totalIncentives + row.incentives,
        totalDeductions: acc.totalDeductions + row.deductions,
        totalLd: acc.totalLd + (row.ldCountRealtime ?? row.ldCount ?? 0),
        totalLdPaid: acc.totalLdPaid + (row.ldCount ?? 0),
        totalLdOpen: acc.totalLdOpen,
        openLdTables: acc.openLdTables,
      }),
      { totalEmployees: 0, totalPayout: 0, totalIncentives: 0, totalDeductions: 0, totalLd: 0, totalLdPaid: 0, totalLdOpen: 0, openLdTables: payrollSummary.openLdTables }
    );
  }, [payrollSearch, payrollStatusFilter, payrollSummary, filteredPayroll]);
  const [loadingSales, setLoadingSales] = useState(false);
  const [loadingPayroll, setLoadingPayroll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [computeModalOpen, setComputeModalOpen] = useState(false);
  const [computeProgress, setComputeProgress] = useState(0);
  const [computeStep, setComputeStep] = useState("");
  const [orderDetail, setOrderDetail] = useState<Awaited<ReturnType<typeof api.orders.detail>> | null>(null);
  const [orderDetailLoading, setOrderDetailLoading] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>({});
  const [orderDetailsById, setOrderDetailsById] = useState<Record<string, Awaited<ReturnType<typeof api.orders.detail>>>>({});
  const [loadingOrderIds, setLoadingOrderIds] = useState<Record<string, boolean>>({});
  const [dayStartHour, setDayStartHour] = useState<number | "">("");
  const [filterTableId, setFilterTableId] = useState("");
  const [filterWaiterId, setFilterWaiterId] = useState("");
  const [filterSessionId, setFilterSessionId] = useState("");

  const orderIdFromCode = useCallback((code: string) => code.replace(/^ORD-/, ""), []);

  const loadSalesStable = useCallback(async () => {
    if (dateFrom > dateTo) return;
    setLoadingSales(true);
    setError(null);
    try {
      const hour = dayStartHour === "" ? undefined : Number(dayStartHour);
      const res = await api.reports.sales(dateFrom, dateTo, hour, {
        tableId: filterTableId.trim() || undefined,
        waiterId: filterWaiterId.trim() || undefined,
        sessionId: filterSessionId.trim() || undefined,
      });
      const list = res.list as OrderRow[];
      const groups = (res.groups ?? list.map((o) => ({
        groupId: o.sessionId != null ? `session-${o.sessionId}` : `solo-${o.id}`,
        visitAnchorOrderId: o.visitAnchorOrderId ?? 0,
        sessionId: o.sessionId ?? null,
        sessionLabel:
          o.sessionId != null
            ? `${o.table} · session #${o.sessionId}`
            : `${o.table} · visit #${o.visitAnchorOrderId ?? o.id}`,
        area: o.area,
        table: o.table,
        tableId: o.tableId ?? null,
        orderCount: 1,
        employee: o.employee,
        waiter: o.employee,
        paymentMethod: o.paymentMethod ?? "—",
        subtotal: o.subtotal,
        discount: o.discount,
        complimentary: o.complimentary,
        tax: o.tax,
        cardSurcharge: o.cardSurcharge,
        total: o.total,
        status: o.status,
        time: o.time,
        orders: [o],
      }))) as SalesGroupRow[];
      setSalesGroups(groups);
      setExpandedGroups({});
      setExpandedOrders({});
      setOrderDetailsById({});
      setLoadingOrderIds({});
      setSalesSummary({
        totalOrders: res.summary.totalOrders ?? 0,
        totalSessions: res.summary.totalSessions ?? 0,
        paidOrders: res.summary.paidOrders ?? 0,
        totalSales: res.summary.totalSales ?? 0,
        totalDiscounts: res.summary.totalDiscounts ?? 0,
        totalComplimentary: res.summary.totalComplimentary ?? 0,
        totalTax: res.summary.totalTax ?? 0,
        totalCardSurcharge: res.summary.totalCardSurcharge ?? 0,
        openTabsCount: res.summary.openTabsCount ?? 0,
        openTabsTotal: res.summary.openTabsTotal ?? 0,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load sales report");
    } finally {
      setLoadingSales(false);
    }
  }, [dateFrom, dateTo, dayStartHour, filterTableId, filterWaiterId, filterSessionId]);

  const loadProductsReport = useCallback(async () => {
    if (dateFrom > dateTo) return;
    setLoadingProducts(true);
    setError(null);
    try {
      const hour = dayStartHour === "" ? undefined : Number(dayStartHour);
      const res = await api.reports.products(dateFrom, dateTo, hour, {
        sku: filterProductSku.trim() || undefined,
        category: filterProductCategory !== "All" ? filterProductCategory : undefined,
        tableId: filterProductTableId.trim() || undefined,
        sessionId: filterProductSessionId.trim() || undefined,
        sortBy: productSortBy,
        sortDir: productSortDir,
      });
      setProductRows(res.list || []);
      setProductSummary(res.summary || { totalSkus: 0, totalQuantity: 0, totalRevenue: 0 });
      setExpandedProductSkus({});
      const cats = [
        ...new Set((res.list || []).map((r) => r.category).filter((c): c is string => !!c && c !== "—")),
      ].sort();
      if (cats.length) {
        setProductCategories((prev) => [...new Set([...prev, ...cats])].sort());
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load product report");
    } finally {
      setLoadingProducts(false);
    }
  }, [
    dateFrom,
    dateTo,
    dayStartHour,
    filterProductSku,
    filterProductCategory,
    filterProductTableId,
    filterProductSessionId,
    productSortBy,
    productSortDir,
  ]);

  useEffect(() => {
    if (activeTab !== "products") return;
    api.products
      .list()
      .then((list) => {
        const cats = [...new Set(list.map((p) => p.category).filter(Boolean))].sort();
        setProductCategories(cats);
      })
      .catch(() => {});
  }, [activeTab]);

  const startProductReportPrint = useCallback(() => {
    if (!productRows.length) {
      toast.error("No product data to print");
      return;
    }
    setProductPrintOpen(true);
    setProductPrintStep("preparing");
    (async () => {
      await new Promise((r) => setTimeout(r, 400));
      setProductPrintStep("printing");
      const rowsHtml = productRows
        .map(
          (r) =>
            `<tr>
              <td style="font-family:monospace;font-size:10px">${r.sku}</td>
              <td>${r.productName}</td>
              <td style="text-align:right">${r.quantity}</td>
              <td style="text-align:right">₱${r.revenue.toFixed(2)}</td>
              <td style="text-align:right">${r.stockQty == null ? "—" : r.stockQty}</td>
            </tr>`
        )
        .join("");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Product Report</title>
        <style>
          body{font-family:system-ui,sans-serif;font-size:12px;padding:16px;color:#111}
          h1{font-size:16px;margin:0 0 4px}
          .meta{color:#555;font-size:11px;margin-bottom:12px}
          table{width:100%;border-collapse:collapse}
          th,td{border:1px solid #ccc;padding:4px 6px}
          th{background:#f3f4f6;text-align:left}
          tfoot td{font-weight:700;background:#f9fafb}
          .note{margin-top:10px;font-size:10px;color:#666}
        </style></head><body>
        <h1>Product Report — Consumed / Sold</h1>
        <div class="meta">${dateFrom} to ${dateTo} · Paid transactions only · Grouped by SKU</div>
        <table>
          <thead><tr><th>SKU</th><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:right">Revenue</th><th style="text-align:right">Stock</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot><tr><td colspan="2">TOTAL</td><td style="text-align:right">${productSummary.totalQuantity}</td><td style="text-align:right">₱${productSummary.totalRevenue.toFixed(2)}</td><td></td></tr></tfoot>
        </table>
        <p class="note">Excludes open/unpaid orders and voided items. Printed ${new Date().toLocaleString()}.</p>
        </body></html>`;
      try {
        await api.reports.savePrint({ type: "product-report", html });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save to prints folder");
      }
      const win = window.open("", "_blank", "width=800,height=900");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 200);
      }
      await new Promise((r) => setTimeout(r, 2000));
      setProductPrintStep("done");
      await new Promise((r) => setTimeout(r, 1200));
      toast.success("Product report saved & printed");
      setProductPrintOpen(false);
    })();
  }, [productRows, productSummary, dateFrom, dateTo]);

  const loadVoidsReport = useCallback(async () => {
    if (!canViewVoids || dateFrom > dateTo) return;
    setLoadingVoids(true);
    setError(null);
    try {
      const hour = dayStartHour === "" ? undefined : Number(dayStartHour);
      const res = await api.reports.voids(
        dateFrom,
        dateTo,
        {
          staffName: filterVoidStaff.trim() || undefined,
          product: filterVoidProduct.trim() || undefined,
          tableId: filterVoidTableId.trim() || undefined,
          q: voidSearch.trim() || undefined,
        },
        hour
      );
      setVoidRows(res.list || []);
      setVoidSummary(
        res.summary || { totalVoids: 0, totalQuantity: 0, totalAmount: 0, listed: 0, truncated: false }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load void report");
      setVoidRows([]);
    } finally {
      setLoadingVoids(false);
    }
  }, [canViewVoids, dateFrom, dateTo, dayStartHour, filterVoidStaff, filterVoidProduct, filterVoidTableId, voidSearch]);

  const startVoidReportPrint = useCallback(() => {
    if (!voidRows.length) {
      toast.error("No void data to print");
      return;
    }
    setVoidPrintOpen(true);
    setVoidPrintStep("preparing");
    (async () => {
      await new Promise((r) => setTimeout(r, 400));
      setVoidPrintStep("printing");
      const rowsHtml = voidRows
        .map(
          (r) =>
            `<tr>
              <td style="font-size:10px;white-space:nowrap">${r.voidedAtDisplay}</td>
              <td>${r.productName}</td>
              <td style="text-align:right">${r.quantity}</td>
              <td style="text-align:right">₱${r.amount.toFixed(2)}</td>
              <td>${r.voidedByName}</td>
              <td>${r.reason}</td>
              <td>${r.tableArea ? `${r.tableArea} ` : ""}${r.tableName}${r.sessionId != null ? ` · #${r.sessionId}` : ""}</td>
            </tr>`
        )
        .join("");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Void Report</title>
        <style>
          body{font-family:system-ui,sans-serif;font-size:11px;padding:16px;color:#111}
          h1{font-size:16px;margin:0 0 4px}
          .meta{color:#555;font-size:11px;margin-bottom:12px}
          table{width:100%;border-collapse:collapse}
          th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top}
          th{background:#f3f4f6;text-align:left}
          tfoot td{font-weight:700;background:#f9fafb}
          .note{margin-top:10px;font-size:10px;color:#666}
        </style></head><body>
        <h1>Void Report</h1>
        <div class="meta">${dateFrom} to ${dateTo} · ${voidSummary.totalVoids} void(s) · Manager confidential</div>
        <table>
          <thead><tr><th>Date/Time</th><th>Item</th><th style="text-align:right">Qty</th><th style="text-align:right">Amount</th><th>Voided By</th><th>Reason</th><th>Table / Session</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
          <tfoot><tr><td colspan="2">TOTAL</td><td style="text-align:right">${voidSummary.totalQuantity}</td><td style="text-align:right">₱${voidSummary.totalAmount.toFixed(2)}</td><td colspan="3"></td></tr></tfoot>
        </table>
        <p class="note">Printed ${new Date().toLocaleString()}.</p>
        </body></html>`;
      try {
        await api.reports.savePrint({ type: "void-report", html });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save to prints folder");
      }
      const win = window.open("", "_blank", "width=900,height=900");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.focus();
        setTimeout(() => win.print(), 200);
      }
      await new Promise((r) => setTimeout(r, 2000));
      setVoidPrintStep("done");
      await new Promise((r) => setTimeout(r, 1200));
      toast.success("Void report saved & printed");
      setVoidPrintOpen(false);
    })();
  }, [voidRows, voidSummary, dateFrom, dateTo]);

  const ensureOrderDetail = useCallback(async (orderCode: string) => {
    const orderId = orderIdFromCode(orderCode);
    if (orderDetailsById[orderId] || loadingOrderIds[orderId]) return;
    setLoadingOrderIds((prev) => ({ ...prev, [orderId]: true }));
    try {
      const detail = await api.orders.detail(orderId);
      setOrderDetailsById((prev) => ({ ...prev, [orderId]: detail }));
    } catch {
      toast.error(`Failed to load order #${orderId}`);
    } finally {
      setLoadingOrderIds((prev) => ({ ...prev, [orderId]: false }));
    }
  }, [loadingOrderIds, orderDetailsById, orderIdFromCode]);

  const loadPayrollStable = useCallback(async () => {
    if (dateFrom > dateTo) return;
    setLoadingPayroll(true);
    setError(null);
    try {
      const hour = dayStartHour === "" ? undefined : Number(dayStartHour);
      const rawPayroll = await api.reports.payroll(dateFrom, dateTo, hour);
      const list = Array.isArray(rawPayroll) ? rawPayroll : rawPayroll.rows;
      const serverTotalLdRealtime = Array.isArray(rawPayroll)
        ? null
        : (typeof rawPayroll.totalLdQtyRealtime === "number" ? rawPayroll.totalLdQtyRealtime : null);
      const serverTotalLdPaid = Array.isArray(rawPayroll)
        ? null
        : (typeof rawPayroll.totalLdQtyPaid === "number" ? rawPayroll.totalLdQtyPaid : null);
      const serverTotalLdOpen = Array.isArray(rawPayroll)
        ? null
        : (typeof rawPayroll.totalLdQtyOpen === "number" ? rawPayroll.totalLdQtyOpen : null);
      const serverOpenLdTables = Array.isArray(rawPayroll) ? [] : (rawPayroll.openLdTables ?? []);
      const seenEmployees = new Set<string>();
      const mappedPayroll = list.flatMap((p) => {
        const empKey = String(p.employeeId || "").trim().toUpperCase() || String(p.id);
        if (seenEmployees.has(empKey)) return [];
        seenEmployees.add(empKey);
        const incB = (p as { incentivesBreakdown?: BreakdownItem[] }).incentivesBreakdown ?? null;
        const otherInc = Array.isArray(incB) ? incB.reduce((s, x) => s + (x.amount ?? 0), 0) : 0;
        const budget = Number(p.allowance ?? 0);
        const ldCount = Number((p as { ldCount?: number }).ldCount ?? 0);
        const ldCountRealtime = Number((p as { ldCountRealtime?: number }).ldCountRealtime ?? ldCount);
        const commission = Number(p.commission ?? 0);
        const incentives = Number(p.incentives ?? 0);
        const adjustments = Number(p.adjustments ?? 0);
        const deductions = Number(p.deductions ?? 0);
        const netPayout =
          typeof (p as { netPayout?: number }).netPayout === "number"
            ? Number((p as { netPayout?: number }).netPayout)
            : budget + commission + incentives + otherInc + adjustments - deductions;
        return [{
          id: p.id,
          employeeId: p.employeeId ?? "",
          name: p.name,
          timeIn: (p as { timeIn?: string | null }).timeIn ?? null,
          budget,
          commission,
          ldCount,
          ldCountRealtime,
          ldAmount: Number((p as { ldAmount?: number }).ldAmount ?? 0),
          incentives,
          adjustments,
          deductions,
          incentivesBreakdown: incB,
          adjustmentsBreakdown: (p as { adjustmentsBreakdown?: BreakdownItem[] }).adjustmentsBreakdown ?? null,
          deductionsBreakdown: (p as { deductionsBreakdown?: BreakdownItem[] }).deductionsBreakdown ?? null,
          netPayout,
          status: p.status ?? "draft",
          approvedBy: p.approvedBy ?? null,
        }];
      });
      setPayroll(mappedPayroll);
      const summary = mappedPayroll.reduce(
        (acc, row) => {
          const calculatedPayout = row.netPayout;
          return {
            totalEmployees: acc.totalEmployees + 1,
            totalPayout: acc.totalPayout + calculatedPayout,
            totalIncentives: acc.totalIncentives + row.incentives,
            totalDeductions: acc.totalDeductions + row.deductions,
            totalLd: acc.totalLd + (row.ldCountRealtime ?? row.ldCount ?? 0),
            totalLdPaid: acc.totalLdPaid + (row.ldCount ?? 0),
            totalLdOpen: acc.totalLdOpen,
            openLdTables: acc.openLdTables,
          };
        },
        {
          totalEmployees: 0,
          totalPayout: 0,
          totalIncentives: 0,
          totalDeductions: 0,
          totalLd: 0,
          totalLdPaid: 0,
          totalLdOpen: 0,
          openLdTables: [] as Array<{ tableId: string; tableCode?: string; ldCount: number }>,
        }
      );
      if (serverTotalLdRealtime != null && !Number.isNaN(serverTotalLdRealtime)) {
        summary.totalLd = serverTotalLdRealtime;
      }
      if (serverTotalLdPaid != null && !Number.isNaN(serverTotalLdPaid)) {
        summary.totalLdPaid = serverTotalLdPaid;
      }
      if (serverTotalLdOpen != null && !Number.isNaN(serverTotalLdOpen)) {
        summary.totalLdOpen = serverTotalLdOpen;
      }
      summary.openLdTables = serverOpenLdTables;
      setPayrollSummary(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load payroll report");
    } finally {
      setLoadingPayroll(false);
    }
  }, [dateFrom, dateTo, dayStartHour]);

  useEffect(() => {
    if (activeTab === "sales") loadSalesStable();
    else if (activeTab === "products") loadProductsReport();
    else if (activeTab === "voids") loadVoidsReport();
    else if (activeTab === "payroll") loadPayrollStable();
  }, [activeTab, dateFrom, dateTo, loadSalesStable, loadProductsReport, loadVoidsReport, loadPayrollStable]);

  const handleViewOrder = useCallback(async (orderId: string) => {
    const normalizedOrderId = orderIdFromCode(orderId);
    setOrderDetailLoading(true);
    setOrderDetail(null);
    try {
      const detail = await api.orders.detail(normalizedOrderId);
      setOrderDetail(detail);
    } catch {
      toast.error("Failed to load order details");
    } finally {
      setOrderDetailLoading(false);
    }
  }, [orderIdFromCode]);

  const printFinalBillReceipts = useCallback(
    (
      entries: Array<{
        orderId: string;
        receipt: {
          orderNumber?: string;
          date?: string;
          time?: string;
          table?: string;
          cashier?: string;
          businessName?: string;
          businessAddress?: string;
          businessContact?: string;
          receiptFooter?: string;
          vatTin?: string;
          serviceLabel?: string;
          taxLabel?: string;
          items?: Array<{ name: string; quantity: number; subtotal: number }>;
          subtotal?: number;
          complimentary?: number;
          discount?: number;
          serviceCharge?: number;
          tax?: number;
          cardSurcharge?: number;
          total?: number;
          paymentMethod?: string;
          originalPaymentMethod?: string | null;
          amountPaid?: number;
          change?: number;
          isReprint?: boolean;
        };
      }>
    ) => {
    if (!entries.length) return;
    const w = window.open("", "_blank", "width=420,height=980,scrollbars=yes");
    if (!w) return;
    const sections = entries.map(({ receipt, orderId }) => {
      const payRaw = receipt.originalPaymentMethod || receipt.paymentMethod || "";
      const payLabel = payRaw && !/^reprint$/i.test(payRaw) ? String(payRaw).toUpperCase() : "—";
      const rows = (receipt.items || [])
        .map((item) => `
          <tr>
            <td>${escapeHtml(item.quantity)}x ${escapeHtml(item.name)}</td>
            <td class="num">₱${Number(item.subtotal || 0).toFixed(2)}</td>
          </tr>
        `)
        .join("");
      return `
        <section class="receipt">
          <div class="center bold">${escapeHtml(receipt.businessName || "RABBIT ALLEY")}</div>
          ${receipt.businessAddress ? `<div class="center">${escapeHtml(receipt.businessAddress)}</div>` : ""}
          ${receipt.businessContact ? `<div class="center">${escapeHtml(receipt.businessContact)}</div>` : ""}
          <hr />
          <div class="center bold">OFFICIAL RECEIPT</div>
          <div class="center reprint">** REPRINT COPY **</div>
          <hr />
          <div>Order: ${escapeHtml(receipt.orderNumber || orderId)}</div>
          <div>Date: ${escapeHtml(receipt.date)} ${escapeHtml(receipt.time)}</div>
          <div>Table: ${escapeHtml(receipt.table)}</div>
          <div>Cashier: ${escapeHtml(receipt.cashier)}</div>
          <hr />
          <table><tbody>${rows}</tbody></table>
          <hr />
          <div class="line"><span>Subtotal</span><span>₱${Number(receipt.subtotal || 0).toFixed(2)}</span></div>
          ${receipt.complimentary ? `<div class="line"><span>Less Compli</span><span>-₱${Number(receipt.complimentary).toFixed(2)}</span></div>` : ""}
          ${receipt.discount ? `<div class="line"><span>Discount</span><span>-₱${Number(receipt.discount).toFixed(2)}</span></div>` : ""}
          <div class="line"><span>${escapeHtml(receipt.serviceLabel || "Service")}</span><span>₱${Number(receipt.serviceCharge || 0).toFixed(2)}</span></div>
          <div class="line"><span>${escapeHtml(receipt.taxLabel || "Tax")}</span><span>₱${Number(receipt.tax || 0).toFixed(2)}</span></div>
          ${receipt.cardSurcharge ? `<div class="line"><span>Card Fee</span><span>₱${Number(receipt.cardSurcharge).toFixed(2)}</span></div>` : ""}
          <hr />
          <div class="line bold"><span>TOTAL</span><span>₱${Number(receipt.total || 0).toFixed(2)}</span></div>
          <div class="line"><span>Payment</span><span>${escapeHtml(payLabel)}</span></div>
          <div class="line"><span>Amount Paid</span><span>₱${Number(receipt.amountPaid || receipt.total || 0).toFixed(2)}</span></div>
          <div class="line"><span>Change</span><span>₱${Number(receipt.change || 0).toFixed(2)}</span></div>
          ${receipt.receiptFooter ? `<div class="center footer">${escapeHtml(receipt.receiptFooter)}</div>` : ""}
          ${receipt.vatTin ? `<div class="center">VAT TIN: ${escapeHtml(receipt.vatTin)}</div>` : ""}
          <div class="center reprint footer">** REPRINT — NOT A DUPLICATE **</div>
        </section>
      `;
    }).join("");
    w.document.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Receipt Reprint</title>
          <style>
            @page { size: 80mm auto; margin: 3mm 2mm 8mm 2mm; }
            body { margin: 0; padding: 0; font-family: 'Courier New', monospace; font-size: 11px; color: #000; background: #fff; }
            .receipt { width: 76mm; margin: 0 auto 8mm; padding: 5px 3px; page-break-after: always; }
            .receipt:last-child { page-break-after: auto; }
            .center { text-align: center; }
            .bold { font-weight: 700; }
            .reprint { margin-top: 2px; font-weight: 700; }
            .line { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
            table { width: 100%; border-collapse: collapse; }
            td { padding: 1px 0; vertical-align: top; }
            td.num { text-align: right; white-space: nowrap; }
            hr { border: none; border-top: 1px dashed #000; margin: 6px 0; }
            .footer { margin-top: 6px; }
          </style>
        </head>
        <body>${sections}</body>
      </html>
    `);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 250);
  }, []);

  const handlePrintTransaction = useCallback(async (group: SalesGroupRow) => {
    if (!canReprintFinalBill) {
      toast.error("Only Cashier or Manager can reprint the final bill");
      return;
    }
    if (group.status !== "paid") {
      toast.info("Final bill reprint is available once the transaction is paid.");
      return;
    }
    try {
      const orderIds = group.orders.map((order) => orderIdFromCode(order.id));
      const { receipts } = await api.orders.reprintFinalBills(orderIds, "sales_report");
      printFinalBillReceipts(receipts);
      toast.success(
        `Final bill reprint: ${receipts.length} receipt${receipts.length > 1 ? "s" : ""}`
      );
      return;
    } catch (e) {
      const err = e as Error & { data?: { code?: string } };
      if (err.data?.code === "ORDER_UNPAID") {
        toast.error("Complete payment before reprinting the final bill");
        return;
      }
      toast.error(err.message || "No final bill on file for this transaction");
    }
  }, [canReprintFinalBill, orderIdFromCode, printFinalBillReceipts]);

  const handleFilter = useCallback(() => {
    if (dateFrom > dateTo) {
      toast.error("From date must be before or equal to To date");
      return;
    }
    if (activeTab === "sales") loadSalesStable();
    else if (activeTab === "products") loadProductsReport();
    else if (activeTab === "voids") loadVoidsReport();
    else loadPayrollStable();
    toast.success(`Filtered from ${dateFrom} to ${dateTo}`);
  }, [activeTab, dateFrom, dateTo, loadSalesStable, loadProductsReport, loadVoidsReport, loadPayrollStable]);

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExport = useCallback((format: "PDF" | "Excel" | "CSV") => {
    const fromTo = `${dateFrom}_to_${dateTo}`;
    try {
      if (activeTab === "sales") {
        if (format === "CSV") {
          const headers = ["Session #", "Transaction", "Orders", "Area", "Table", "Waiter", "Payment", "Subtotal", "Discount", "Complimentary", "Tax", "Card Surcharge", "Total", "Status", "Time"];
          const rows = salesGroups.map((g) => [
            g.sessionId ?? g.visitAnchorOrderId ?? "",
            g.sessionLabel || g.groupId,
            g.orderCount,
            g.area,
            g.table,
            g.waiter || g.employee,
            g.paymentMethod ?? "",
            g.subtotal,
            g.discount,
            g.complimentary,
            g.tax,
            g.cardSurcharge,
            g.total,
            g.status,
            g.time,
          ]);
          const csv = [headers.join(","), ...rows.map((r) => r.map((c) => (typeof c === "string" && c.includes(",") ? `"${c}"` : c)).join(","))].join("\n");
          const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
          downloadBlob(blob, `sales_report_${fromTo}.csv`);
        } else if (format === "Excel") {
          const ws = XLSX.utils.json_to_sheet(
            salesGroups.map((g) => ({
              "Session #": g.sessionId ?? g.visitAnchorOrderId ?? "",
              Transaction: g.sessionLabel || g.groupId,
              Orders: g.orderCount,
              Area: g.area,
              Table: g.table,
              Waiter: g.waiter || g.employee,
              Payment: g.paymentMethod ?? "",
              Subtotal: g.subtotal,
              Discount: g.discount,
              Complimentary: g.complimentary,
              Tax: g.tax,
              "Card Surcharge": g.cardSurcharge,
              Total: g.total,
              Status: g.status,
              Time: g.time,
            }))
          );
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "Sales");
          XLSX.writeFile(wb, `sales_report_${fromTo}.xlsx`);
        } else {
          const doc = new jsPDF({ orientation: "landscape" });
          doc.setFontSize(14);
          doc.text(`Sales Report ${dateFrom} to ${dateTo}`, 14, 12);
          doc.setFontSize(10);
          doc.text(
            `Sessions: ${salesSummary.totalSessions}  |  Order lines: ${salesSummary.totalOrders}  |  Total Sales: ₱${salesSummary.totalSales.toFixed(2)}  |  Open Tabs: ₱${salesSummary.openTabsTotal.toFixed(2)}  |  Discount: ₱${salesSummary.totalDiscounts.toFixed(2)}  |  Tax: ₱${salesSummary.totalTax.toFixed(2)}`,
            14,
            20
          );
          autoTable(doc, {
            startY: 24,
            head: [["Session #", "Transaction", "Orders", "Area", "Table", "Waiter", "Payment", "Subtotal", "Discount", "Complimentary", "Tax", "Card Surcharge", "Total", "Status", "Time"]],
            body: salesGroups.map((g) => [
              String(g.sessionId ?? g.visitAnchorOrderId ?? ""),
              g.sessionLabel || g.groupId,
              String(g.orderCount),
              g.area,
              g.table,
              g.waiter || g.employee,
              g.paymentMethod ?? "",
              g.subtotal.toFixed(2),
              g.discount.toFixed(2),
              g.complimentary.toFixed(2),
              g.tax.toFixed(2),
              g.cardSurcharge.toFixed(2),
              g.total.toFixed(2),
              g.status,
              g.time,
            ]),
          });
          const summaryY = ((doc as unknown) as { lastAutoTable?: { finalY: number } }).lastAutoTable
            ? ((doc as unknown) as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10
            : 100;
          doc.setFont("helvetica", "bold");
          doc.setFontSize(11);
          doc.text(`TOTAL: ₱${salesSummary.totalSales.toFixed(2)}`, 14, summaryY);
          doc.text(`TOTAL DISCOUNT: ₱${salesSummary.totalDiscounts.toFixed(2)}`, 14, summaryY + 7);
          doc.text(`TOTAL COMPLIMENTARY: ₱${salesSummary.totalComplimentary.toFixed(2)}`, 14, summaryY + 14);
          doc.text(`TOTAL CARD SURCHARGE: ₱${salesSummary.totalCardSurcharge.toFixed(2)}`, 14, summaryY + 21);
          doc.setFont("helvetica", "normal");
          doc.save(`sales_report_${fromTo}.pdf`);
        }
      } else {
        const payrollExport = filteredPayroll;
        const payrollExportSummary = displayPayrollSummary;
        if (format === "CSV") {
          const otherInc = (p: PayrollRow) => Array.isArray(p.incentivesBreakdown) ? p.incentivesBreakdown.reduce((s, x) => s + x.amount, 0) : 0;
          const headers = ["Employee ID", "Name", "Time In", "Budget", "Total LD (incl. open)", "LD comm.", "Incentives", "Other Incentives", "Adjustments", "Deductions", "Net Payout", "Status", "Approved By"];
          const rows = payrollExport.map((p) => [
            p.employeeId,
            p.name,
            p.timeIn ?? "",
            p.budget,
            p.ldCountRealtime ?? p.ldCount ?? 0,
            p.commission,
            p.incentives,
            otherInc(p),
            p.adjustments,
            p.deductions,
            p.netPayout.toFixed(2),
            p.status,
            p.approvedBy ?? "",
          ]);
          const csv = [headers.join(","), ...rows.map((r) => r.map((c) => (typeof c === "string" && c.includes(",") ? `"${c}"` : c)).join(","))].join("\n");
          const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
          downloadBlob(blob, `payroll_report_${fromTo}.csv`);
        } else if (format === "Excel") {
          const otherInc = (p: PayrollRow) => Array.isArray(p.incentivesBreakdown) ? p.incentivesBreakdown.reduce((s, x) => s + x.amount, 0) : 0;
          const ws = XLSX.utils.json_to_sheet(
            payrollExport.map((p) => ({
              "Employee ID": p.employeeId,
              Name: p.name,
              "Time In": p.timeIn ?? "",
              Budget: p.budget,
              "Total LD (incl. open)": p.ldCountRealtime ?? p.ldCount ?? 0,
              "LD comm.": p.commission,
              Incentives: p.incentives,
              "Other Incentives": otherInc(p),
              Adjustments: p.adjustments,
              Deductions: p.deductions,
              "Net Payout": p.netPayout,
              Status: p.status,
              "Approved By": p.approvedBy ?? "",
            }))
          );
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, ws, "Payroll");
          XLSX.writeFile(wb, `payroll_report_${fromTo}.xlsx`);
        } else {
          const doc = new jsPDF({ orientation: "landscape" });
          doc.setFontSize(14);
          doc.text(`Payroll Report ${dateFrom} to ${dateTo}`, 14, 12);
          doc.setFontSize(10);
          doc.text(`Employees: ${payrollExportSummary.totalEmployees}  |  Total Payout: ₱${payrollExportSummary.totalPayout.toFixed(2)}  |  Incentives: ₱${payrollExportSummary.totalIncentives.toFixed(2)}  |  Deductions: ₱${payrollExportSummary.totalDeductions.toFixed(2)}`, 14, 20);
          const otherInc = (p: PayrollRow) => Array.isArray(p.incentivesBreakdown) ? p.incentivesBreakdown.reduce((s, x) => s + x.amount, 0) : 0;
          autoTable(doc, {
            startY: 24,
            head: [["Employee ID", "Name", "Time In", "Budget", "LD (open)", "Comm (₱)", "Incent", "Other Inc", "Adj", "Ded", "Net", "Status"]],
            body: payrollExport.map((p) => [
              p.employeeId,
              p.name,
              p.timeIn ?? "—",
              p.budget.toFixed(2),
              String(p.ldCountRealtime ?? p.ldCount ?? 0),
              p.commission.toFixed(2),
              p.incentives.toFixed(2),
              otherInc(p).toFixed(2),
              p.adjustments.toFixed(2),
              p.deductions.toFixed(2),
              p.netPayout.toFixed(2),
              p.status,
            ]),
          });
          doc.save(`payroll_report_${fromTo}.pdf`);
        }
      }
      toast.success(`Exported as ${format}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to export as ${format}`);
    }
  }, [activeTab, dateFrom, dateTo, salesGroups, salesSummary, filteredPayroll, displayPayrollSummary]);

  const handleComputePayouts = useCallback(async () => {
    setComputeModalOpen(true);
    setComputeProgress(0);
    setComputeStep("Initializing...");

    try {
      // Show progress steps while API computes
      const progressSteps = [
        { progress: 10, label: "Loading employee data..." },
        { progress: 30, label: "Calculating commissions..." },
        { progress: 50, label: "Processing incentives..." },
        { progress: 70, label: "Checking quotas..." },
      ];

      for (const step of progressSteps) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        setComputeProgress(step.progress);
        setComputeStep(step.label);
      }

      // Call the API to compute payouts
      setComputeStep("Computing payouts...");
      const hour = dayStartHour === "" ? undefined : Number(dayStartHour);
      const result = await api.reports.computePayouts(dateFrom, dateTo, hour);
      
      setComputeProgress(90);
      setComputeStep("Finalizing...");
      await new Promise((resolve) => setTimeout(resolve, 300));

      setComputeProgress(100);
      setComputeStep("Complete!");

      await loadPayrollStable();

      await new Promise((resolve) => setTimeout(resolve, 800));
      setComputeModalOpen(false);
      
      if (result.computed > 0) {
        toast.success(`Computed payouts for ${result.computed} staff members`);
      } else {
        toast.info("No staff members found to compute payouts");
      }
    } catch {
      setComputeModalOpen(false);
      toast.error("Failed to compute payouts");
    }
  }, [dateFrom, dateTo, dayStartHour, loadPayrollStable]);

  const handleApprove = useCallback(async (row: PayrollRow) => {
    try {
      await api.reports.approvePayout(row.id, user?.id);
      toast.success(`${row.name} payout approved`);
      loadPayrollStable();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to approve");
    }
  }, [user?.id, loadPayrollStable]);

  const handlePrintPayslip = useCallback((row: PayrollRow) => {
    const printWindow = window.open("", "_blank", "width=520,height=680");
    if (!printWindow) return;

    const dateTimeIn = `${dateFrom} to ${dateTo}`;
    const ldCountLive = row.ldCountRealtime ?? row.ldCount ?? 0;
    const totalPayout = row.netPayout;
    const generatedAt = new Date().toLocaleString();

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payslip - ${row.name}</title>
        <style>
          @page { size: auto; margin: 12mm; }
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', system-ui, sans-serif; font-size: 13px; margin: 0; padding: 24px; color: #000; max-width: 400px; margin: 0 auto; }
          .receipt { border: 1px solid #000; }
          .header { padding: 16px 24px; text-align: center; border-bottom: 1px dashed #000; }
          .company { font-size: 18px; font-weight: 700; margin: 0 0 2px 0; color: #000; }
          .tagline { font-size: 11px; margin: 0; color: #000; }
          .doc-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 6px; color: #000; }
          .section { padding: 12px 24px; }
          .section-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; color: #000; }
          .divider { border: none; border-top: 1px dashed #000; margin: 10px 0; }
          .row { display: flex; justify-content: space-between; align-items: baseline; margin: 4px 0; gap: 16px; }
          .label { font-size: 12px; color: #000; }
          .value { font-weight: 500; text-align: right; color: #000; }
          .total-block { padding: 12px 24px; margin: 0 24px 12px; border: 1px solid #000; }
          .total-row { display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-weight: 700; color: #000; }
          .footer { padding: 12px 24px; text-align: center; font-size: 11px; color: #000; border-top: 1px dashed #000; }
          .footer-row { margin: 3px 0; }
          .group-total { margin-top: 6px; padding-top: 6px; border-top: 1px dashed #000; font-weight: 600; }
        </style>
      </head>
      <body>
        <div class="receipt">
          <div class="header">
            <p class="company">RABBIT ALLEY</p>
            <p class="tagline">Bar & Restaurant</p>
            <p class="doc-title">Payslip Receipt</p>
          </div>
          <div class="section">
            <div class="section-title">Employee</div>
            <div class="row"><span class="label">Name</span><span class="value">${row.name}</span></div>
            <div class="row"><span class="label">Employee No.</span><span class="value">${row.employeeId}</span></div>
            <div class="row"><span class="label">Date and time in</span><span class="value">${dateTimeIn}</span></div>
          </div>
          <hr class="divider" />
          <div class="section">
            <div class="section-title">Earnings</div>
            <div class="row"><span class="label">Budget</span><span class="value">${row.budget.toFixed(2)}</span></div>
            <div class="row"><span class="label">LD count (incl. open)</span><span class="value">${ldCountLive}</span></div>
            <div class="row"><span class="label">Commission</span><span class="value">${row.commission.toFixed(2)}</span></div>
          </div>
          <hr class="divider" />
          <div class="section">
            <div class="section-title">Incentives</div>
            ${payslipGroupSectionHtml(payslipIncentiveLines(row), payslipIncentiveSubtotal(row))}
          </div>
          <div class="section">
            <div class="section-title">Adjustments</div>
            ${payslipGroupSectionHtml(payslipAdjustmentLines(row), payslipAdjustmentSubtotal(row))}
          </div>
          <hr class="divider" />
          <div class="section">
            <div class="section-title">Deductions</div>
            ${payslipGroupSectionHtml(payslipDeductionLines(row), payslipDeductionSubtotal(row))}
          </div>
          <div class="total-block">
            <div class="total-row"><span>Total payout</span><span>${totalPayout.toFixed(2)}</span></div>
          </div>
          <div class="footer">
            <div class="footer-row">Status: ${row.status.toUpperCase()}</div>
            ${row.approvedBy ? `<div class="footer-row">Approved by: ${row.approvedBy}</div>` : ""}
            <div class="footer-row">Generated: ${generatedAt}</div>
            <div class="footer-row" style="margin-top: 8px;">This is a computer-generated payslip. Please retain for your records.</div>
          </div>
        </div>
      </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
    printWindow.onload = () => {
      printWindow.print();
      printWindow.close();
    };
  }, [dateFrom, dateTo]);

  const handleDownloadPayslipPdf = useCallback((row: PayrollRow) => {
    const dateTimeIn = `${dateFrom} to ${dateTo}`;
    const ldCountLive = row.ldCountRealtime ?? row.ldCount ?? 0;
    const totalPayout = row.netPayout;
    const generatedAt = new Date().toLocaleString();

    const doc = new jsPDF({ format: "a4" });
    const pageW = doc.internal.pageSize.getWidth();
    const left = 20;
    const right = pageW - 20;
    const center = pageW / 2;

    const dottedLine = (y: number) => {
      for (let x = left; x < right; x += 3) doc.line(x, y, Math.min(x + 2, right), y);
    };

    let y = 18;
    doc.setFontSize(16);
    doc.setFont("helvetica", "bold");
    doc.text("RABBIT ALLEY", center, y, { align: "center" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.text("Bar & Restaurant", center, y + 8, { align: "center" });
    doc.setFontSize(9);
    doc.text("PAYSLIP RECEIPT", center, y + 16, { align: "center" });
    dottedLine(y + 24);
    y += 32;

    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.text("EMPLOYEE", left, y);
    doc.setFont("helvetica", "normal");
    y += 6;
    doc.setFontSize(10);
    doc.text("Name", left, y);
    doc.text(row.name, right, y, { align: "right" });
    y += 5;
    doc.text("Employee No.", left, y);
    doc.text(row.employeeId, right, y, { align: "right" });
    y += 5;
    doc.text("Date and time in", left, y);
    doc.text(dateTimeIn, right, y, { align: "right" });
    y += 10;
    dottedLine(y);
    y += 8;

    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.text("EARNINGS", left, y);
    doc.setFont("helvetica", "normal");
    y += 6;
    doc.setFontSize(10);
    doc.text("Budget", left, y);
    doc.text(row.budget.toFixed(2), right, y, { align: "right" });
    y += 5;
    doc.text("LD count (incl. open)", left, y);
    doc.text(String(ldCountLive), right, y, { align: "right" });
    y += 5;
    doc.text("Commission", left, y);
    doc.text(row.commission.toFixed(2), right, y, { align: "right" });
    y += 10;
    dottedLine(y);
    y += 8;

    y = drawPayslipGroupSection(doc, left, right, y, "INCENTIVES", payslipIncentiveLines(row), payslipIncentiveSubtotal(row));
    y = drawPayslipGroupSection(doc, left, right, y, "ADJUSTMENTS", payslipAdjustmentLines(row), payslipAdjustmentSubtotal(row));
    y += 2;
    dottedLine(y);
    y += 8;
    y = drawPayslipGroupSection(doc, left, right, y, "DEDUCTIONS", payslipDeductionLines(row), payslipDeductionSubtotal(row));
    y += 2;

    doc.setDrawColor(0, 0, 0);
    doc.rect(left, y - 2, right - left, 14, "S");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.text("Total payout", left + 4, y + 6);
    doc.text(totalPayout.toFixed(2), right - 4, y + 6, { align: "right" });
    doc.setFont("helvetica", "normal");
    y += 20;
    dottedLine(y);
    y += 10;

    doc.setFontSize(9);
    doc.text(`Status: ${row.status.toUpperCase()}`, center, y, { align: "center" });
    y += 5;
    if (row.approvedBy) {
      doc.text(`Approved by: ${row.approvedBy}`, center, y, { align: "center" });
      y += 5;
    }
    doc.text(`Generated: ${generatedAt}`, center, y, { align: "center" });
    y += 8;
    doc.setFontSize(8);
    doc.text("This is a computer-generated payslip. Please retain for your records.", center, y, { align: "center" });

    doc.save(`payslip_${row.employeeId}_${dateFrom}_${dateTo}.pdf`);
    toast.success("Payslip PDF downloaded");
  }, [dateFrom, dateTo]);

  const handlePrintPayslipThermal = useCallback(async (row: PayrollRow) => {
    const ldCountLive = row.ldCountRealtime ?? row.ldCount ?? 0;
    try {
      const res = await api.print.payslip({
        employeeId: row.employeeId,
        name: row.name,
        periodFrom: dateFrom,
        periodTo: dateTo,
        allowance: row.budget,
        hours: 0,
        perHour: 0,
        commission: row.commission,
        incentives: row.incentives,
        ldCount: ldCountLive,
        incentivesBreakdown: row.incentivesBreakdown ?? [],
        adjustments: row.adjustments,
        adjustmentsBreakdown: row.adjustmentsBreakdown ?? [],
        deductions: row.deductions,
        deductionsBreakdown: row.deductionsBreakdown ?? [],
        gross: row.budget + row.commission + payslipIncentiveSubtotal(row) + payslipAdjustmentSubtotal(row),
        netPayout: row.netPayout,
        status: row.status,
        approvedBy: row.approvedBy ?? undefined,
      });
      if (res.ok) toast.success("Payslip sent to thermal printer");
      else toast.warning(res.fallback ? "Printer unavailable; use Print or Download PDF" : res.error ?? "Print failed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to print payslip");
    }
  }, [dateFrom, dateTo]);

  const handleUpdateBreakdown = useCallback(async (row: PayrollRow, field: "incentives" | "adjustments" | "deductions", breakdown: BreakdownItem[]) => {
    const total = breakdown.reduce((s, x) => s + x.amount, 0);
    const payload = { [`${field}Breakdown`]: breakdown } as const;
    try {
      await api.reports.updatePayout(row.id, payload);
      setPayroll((prev) =>
        prev.map((r) => {
          if (r.id !== row.id) return r;
          const next = { ...r, [`${field}Breakdown`]: breakdown };
          if (field === "adjustments") next.adjustments = total;
          if (field === "deductions") next.deductions = total;
          const otherInc = Array.isArray(next.incentivesBreakdown) ? next.incentivesBreakdown.reduce((s, x) => s + x.amount, 0) : 0;
          next.netPayout = next.budget + next.commission + next.incentives + otherInc + next.adjustments - next.deductions;
          return next;
        })
      );
      toast.success("Updated");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update");
      loadPayrollStable();
    }
  }, [loadPayrollStable]);

  const handlePayrollNameClick = useCallback(async (row: PayrollRow) => {
    setPayrollLdDetailLoading(true);
    setPayrollLdDetail(null);
    try {
      const hour = dayStartHour === "" ? undefined : Number(dayStartHour);
      const detail = await api.reports.payrollLdByTable(row.id, {
        from: dateFrom,
        to: dateTo,
        dayStartHour: hour,
      });
      setPayrollLdDetail(detail);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load LD breakdown");
    } finally {
      setPayrollLdDetailLoading(false);
    }
  }, [dateFrom, dateTo, dayStartHour]);

  return (
    <AppLayout>
      <PageHeader title="Reports" description="View sales and payroll reports">
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => handleExport("PDF")}>
            <File className="w-4 h-4 mr-2" />
            PDF
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("Excel")}>
            <FileSpreadsheet className="w-4 h-4 mr-2" />
            Excel
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleExport("CSV")}>
            <FileText className="w-4 h-4 mr-2" />
            CSV
          </Button>
        </div>
      </PageHeader>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-6 items-center">
        <Button
          variant={activeTab === "sales" ? "default" : "secondary"}
          onClick={() => setActiveTab("sales")}
        >
          Sales Report
        </Button>
        <Button
          variant={activeTab === "products" ? "default" : "secondary"}
          onClick={() => setActiveTab("products")}
        >
          Product Report
        </Button>
        {canViewVoids && (
          <Button
            variant={activeTab === "voids" ? "default" : "secondary"}
            onClick={() => setActiveTab("voids")}
          >
            Void Report
          </Button>
        )}
        <Button
          variant={activeTab === "payroll" ? "default" : "secondary"}
          onClick={() => setActiveTab("payroll")}
        >
          Payroll Report
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 mb-6">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">From:</span>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-auto"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">To:</span>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-auto"
          />
        </div>
        {activeTab === "sales" && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Table:</span>
              <Input
                placeholder="e.g. S1"
                className="w-24"
                value={filterTableId}
                onChange={(e) => setFilterTableId(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Waiter:</span>
              <Input
                placeholder="Employee ID"
                className="w-32"
                value={filterWaiterId}
                onChange={(e) => setFilterWaiterId(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Session #:</span>
              <Input
                placeholder="ID"
                className="w-24"
                value={filterSessionId}
                onChange={(e) => setFilterSessionId(e.target.value)}
              />
            </div>
          </>
        )}
        {activeTab === "products" && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Search Product:</span>
              <Input
                placeholder="Name or SKU"
                className="w-44"
                value={filterProductSku}
                onChange={(e) => setFilterProductSku(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Category:</span>
              <Select value={filterProductCategory} onValueChange={setFilterProductCategory}>
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  {["All", ...productCategories].map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Table:</span>
              <Input
                placeholder="e.g. S1"
                className="w-24"
                value={filterProductTableId}
                onChange={(e) => setFilterProductTableId(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Session #:</span>
              <Input
                placeholder="ID"
                className="w-24"
                value={filterProductSessionId}
                onChange={(e) => setFilterProductSessionId(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Sort:</span>
              <Select
                value={`${productSortBy}-${productSortDir}`}
                onValueChange={(v) => {
                  const [by, dir] = v.split("-") as ["quantity" | "revenue" | "sku" | "name", "asc" | "desc"];
                  setProductSortBy(by);
                  setProductSortDir(dir);
                }}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="revenue-desc">Revenue (high → low)</SelectItem>
                  <SelectItem value="revenue-asc">Revenue (low → high)</SelectItem>
                  <SelectItem value="quantity-desc">Quantity (high → low)</SelectItem>
                  <SelectItem value="quantity-asc">Quantity (low → high)</SelectItem>
                  <SelectItem value="sku-asc">SKU (A → Z)</SelectItem>
                  <SelectItem value="sku-desc">SKU (Z → A)</SelectItem>
                  <SelectItem value="name-asc">Product Name (A → Z)</SelectItem>
                  <SelectItem value="name-desc">Product Name (Z → A)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="button" variant="outline" onClick={startProductReportPrint} disabled={loadingProducts || !productRows.length}>
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
          </>
        )}
        {activeTab === "voids" && canViewVoids && (
          <>
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search item, staff, reason…"
                className="w-52 pl-8"
                value={voidSearch}
                onChange={(e) => setVoidSearch(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Staff:</span>
              <Input
                placeholder="Name"
                className="w-32"
                value={filterVoidStaff}
                onChange={(e) => setFilterVoidStaff(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Product:</span>
              <Input
                placeholder="Name or SKU"
                className="w-36"
                value={filterVoidProduct}
                onChange={(e) => setFilterVoidProduct(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Table:</span>
              <Input
                placeholder="e.g. S1"
                className="w-24"
                value={filterVoidTableId}
                onChange={(e) => setFilterVoidTableId(e.target.value)}
              />
            </div>
            <Button type="button" variant="outline" onClick={startVoidReportPrint} disabled={loadingVoids || !voidRows.length}>
              <Printer className="w-4 h-4 mr-2" />
              Print
            </Button>
          </>
        )}
        {activeTab === "payroll" && (
          <>
            <div className="relative flex items-center">
              <Search className="absolute left-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or employee ID…"
                className="w-64 pl-8"
                value={payrollSearch}
                onChange={(e) => setPayrollSearch(e.target.value)}
              />
            </div>
            <Select value={payrollStatusFilter} onValueChange={setPayrollStatusFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="All">All</SelectItem>
                <SelectItem value="Draft">Draft</SelectItem>
                <SelectItem value="Approved">Approved</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">Sort:</span>
              <Select
                value={`${payrollSortBy}-${payrollSortDir}`}
                onValueChange={(v) => {
                  const [by, dir] = v.split("-") as ["name" | "netPayout" | "timeIn", "asc" | "desc"];
                  setPayrollSortBy(by);
                  setPayrollSortDir(dir);
                }}
              >
                <SelectTrigger className="w-[200px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name-asc">Name (A → Z)</SelectItem>
                  <SelectItem value="name-desc">Name (Z → A)</SelectItem>
                  <SelectItem value="netPayout-desc">Net Payout (high → low)</SelectItem>
                  <SelectItem value="netPayout-asc">Net Payout (low → high)</SelectItem>
                  <SelectItem value="timeIn-desc">Time In (newest)</SelectItem>
                  <SelectItem value="timeIn-asc">Time In (oldest)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
        <Button variant="secondary" onClick={handleFilter}>
          <Filter className="w-4 h-4 mr-2" />
          Filter
        </Button>
        {(activeTab === "sales" || activeTab === "products" || activeTab === "payroll" || activeTab === "voids") && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Operational day start (hour 0–23):</span>
            <Input
              type="number"
              min={0}
              max={23}
              placeholder="e.g. 4 = 4am"
              className="w-24"
              value={dayStartHour}
              onChange={(e) => setDayStartHour(e.target.value === "" ? "" : Math.min(23, Math.max(0, parseInt(e.target.value, 10) || 0)))}
            />
            <span className="text-xs text-muted-foreground">Applies to Sales, Product, Payroll, and Voids. Leave empty for calendar midnight. Set 17 so Aug 10 = Aug 10 5pm–Aug 11 5pm. Aug 10–Aug 11 with hour 17 is the same night (not two days).</span>
          </div>
        )}
        {activeTab === "payroll" && (
          <Button onClick={handleComputePayouts}>
            <Calculator className="w-4 h-4 mr-2" />
            Compute Payouts
          </Button>
        )}
      </div>

      {activeTab === "sales" && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-8 gap-4 mb-6">
            <StatCard
              label="Table sessions"
              value={salesSummary.totalSessions}
              icon={<MapPin className="w-5 h-5" />}
            />
            <StatCard
              label="Order lines"
              value={salesSummary.totalOrders}
              icon={<ShoppingBag className="w-5 h-5" />}
            />
            <StatCard
              label="Total Sales"
              value={formatCurrency(salesSummary.totalSales)}
              icon={<DollarSign className="w-5 h-5" />}
            />
            <StatCard
              label="Open Tabs"
              value={formatCurrency(salesSummary.openTabsTotal)}
              icon={<Clock className="w-5 h-5" />}
            />
            <StatCard
              label="Discounts"
              value={formatCurrency(salesSummary.totalDiscounts)}
              icon={<Percent className="w-5 h-5" />}
            />
            <StatCard
              label="Tax"
              value={formatCurrency(salesSummary.totalTax)}
              icon={<Receipt className="w-5 h-5" />}
            />
            <StatCard
              label="Card Surcharge"
              value={formatCurrency(salesSummary.totalCardSurcharge)}
              icon={<CreditCard className="w-5 h-5" />}
            />
            <StatCard
              label="Complimentary"
              value={formatCurrency(salesSummary.totalComplimentary)}
              icon={<Package className="w-5 h-5" />}
            />
          </div>

          <div className="rounded-lg border border-border overflow-hidden min-h-[200px]">
            <Table wrapperClassName="max-h-[75vh]">
              <TableHeader>
                <TableRow className={tableStickyHeaderRowClassName}>
                  <TableHead>Session</TableHead>
                  <TableHead>Area</TableHead>
                  <TableHead>Table</TableHead>
                  <TableHead>Waiter</TableHead>
                  <TableHead className="text-right">Subtotal</TableHead>
                  <TableHead className="text-right">Discount</TableHead>
                  <TableHead className="text-right">Compli</TableHead>
                  <TableHead className="text-right">Tax</TableHead>
                  <TableHead className="text-right">Card Surcharge</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingSales ? (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center py-8 text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : (
                  salesGroups.map((group) => (
                    <Fragment key={group.groupId}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => setExpandedGroups((prev) => ({ ...prev, [group.groupId]: !prev[group.groupId] }))}
                      >
                        <TableCell>
                          <div className="flex items-start gap-2">
                            {expandedGroups[group.groupId] ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                            <div>
                              <div className="text-sm font-medium leading-tight">
                                {group.sessionLabel ||
                                  (group.sessionId != null
                                    ? group.orderCount > 1
                                      ? `${group.table} · ${group.orderCount} orders (session #${group.sessionId})`
                                      : `${group.table} · session #${group.sessionId}`
                                    : group.orderCount > 1
                                      ? `${group.table} · ${group.orderCount} orders (visit #${group.visitAnchorOrderId})`
                                      : `${group.table} · visit #${group.visitAnchorOrderId}`)}
                              </div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {group.sessionId != null ? `Session #${group.sessionId}` : `Visit #${group.visitAnchorOrderId}`}
                                {" · "}
                                {group.orderCount} order{group.orderCount > 1 ? "s" : ""}
                                {group.paymentMethod ? ` · ${group.paymentMethod}` : ""}
                                {group.migratedLegacy ? " · legacy" : ""}
                              </div>
                              {group.status === "paid" && canReprintFinalBill && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="mt-1 h-6 px-2 text-[11px]"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handlePrintTransaction(group);
                                  }}
                                >
                                  <Printer className="w-3 h-3 mr-1" />
                                  Reprint Final Bill
                                </Button>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>{group.area}</TableCell>
                        <TableCell>{group.table}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{group.waiter || group.employee}</TableCell>
                        <TableCell className="text-right">{formatCurrency(group.subtotal)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(group.discount)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(group.complimentary)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(group.tax)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(group.cardSurcharge)}</TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(group.total)}</TableCell>
                        <TableCell>
                          <Badge
                            className={cn(
                              group.status === "paid"
                                ? "bg-success/20 text-success border-success/30"
                                : "bg-warning/20 text-warning border-warning/30"
                            )}
                          >
                            {group.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">{group.time}</TableCell>
                      </TableRow>
                      {expandedGroups[group.groupId] && (
                        group.orders.map((order) => {
                          const orderKey = orderIdFromCode(order.id);
                          const detail = orderDetailsById[orderKey];
                          const isExpanded = !!expandedOrders[order.id];
                          const isLoading = !!loadingOrderIds[orderKey];
                          return (
                            <Fragment key={`${group.groupId}-${order.id}`}>
                              <TableRow
                                className="bg-muted/10 cursor-pointer hover:bg-muted/20"
                                onClick={() => {
                                  const next = !isExpanded;
                                  setExpandedOrders((prev) => ({ ...prev, [order.id]: next }));
                                  if (next) void ensureOrderDetail(order.id);
                                }}
                              >
                                <TableCell>
                                  <div className="pl-6 flex items-center gap-2">
                                    {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />}
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs font-medium">{order.table}</span>
                                      <span className="text-[11px] text-muted-foreground">Order {order.id}</span>
                                    </div>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-6 px-2 text-[11px]"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        void handleViewOrder(order.id);
                                      }}
                                    >
                                      <Eye className="w-3 h-3 mr-1" />
                                      View
                                    </Button>
                                  </div>
                                </TableCell>
                                <TableCell>{order.area}</TableCell>
                                <TableCell>{order.table}</TableCell>
                                <TableCell className="text-muted-foreground text-sm">{order.employee}</TableCell>
                                <TableCell className="text-right">{formatCurrency(order.subtotal)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(order.discount)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(order.complimentary)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(order.tax)}</TableCell>
                                <TableCell className="text-right">{formatCurrency(order.cardSurcharge)}</TableCell>
                                <TableCell className="text-right font-medium">{formatCurrency(order.total)}</TableCell>
                                <TableCell>
                                  <Badge
                                    className={cn(
                                      order.status === "paid"
                                        ? "bg-success/20 text-success border-success/30"
                                        : "bg-warning/20 text-warning border-warning/30"
                                    )}
                                  >
                                    {order.status}
                                  </Badge>
                                </TableCell>
                                <TableCell className="text-muted-foreground text-sm">{order.time}</TableCell>
                              </TableRow>
                              {isExpanded && (
                                <TableRow className="bg-muted/5">
                                  <TableCell colSpan={12} className="pl-14 pr-4 py-3">
                                    {isLoading ? (
                                      <div className="text-xs text-muted-foreground">Loading items…</div>
                                    ) : detail ? (
                                      <div className="space-y-2">
                                        {detail.items.length === 0 && <div className="text-xs text-muted-foreground">No items found.</div>}
                                        {detail.items.map((item) => (
                                          <div key={item.id} className="flex items-center justify-between text-sm border-b border-border/40 pb-1">
                                            <div>
                                              <span className={cn("font-medium", item.isVoided && "line-through text-muted-foreground")}>
                                                {item.name}
                                              </span>
                                              {item.isComplimentary && <span className="ml-2 text-xs text-purple-600">(Complimentary)</span>}
                                              {item.specialRequest && <span className="ml-2 text-xs text-amber-600 italic">"{item.specialRequest}"</span>}
                                            </div>
                                            <div className="text-xs text-muted-foreground">
                                              x{item.quantity} · {formatCurrency(item.subtotal)}
                                            </div>
                                          </div>
                                        ))}
                                        <div className="flex items-center justify-between text-xs pt-1">
                                          <div className="text-muted-foreground">Per-order reprint available in View dialog.</div>
                                          <div className="font-semibold">Order Total: {formatCurrency(detail.total)}</div>
                                        </div>
                                      </div>
                                    ) : (
                                      <div className="text-xs text-muted-foreground">Click the order again to load details.</div>
                                    )}
                                  </TableCell>
                                </TableRow>
                              )}
                            </Fragment>
                          );
                        })
                      )}
                    </Fragment>
                  ))
                )}
                {!loadingSales && salesGroups.length > 0 && (
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={4}>TOTAL</TableCell>
                    <TableCell className="text-right">{formatCurrency(salesGroups.reduce((s, g) => s + g.subtotal, 0))}</TableCell>
                    <TableCell className="text-right">{formatCurrency(salesSummary.totalDiscounts)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(salesSummary.totalComplimentary)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(salesSummary.totalTax)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(salesSummary.totalCardSurcharge)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(salesSummary.totalSales)}</TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {activeTab === "products" && (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            Paid / billed items only (by SKU). Open tabs, voided lines, and complimentary items are excluded. Stock
            moves on payment so quantities reconcile with inventory.
          </p>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <StatCard
              label="SKUs sold"
              value={productSummary.totalSkus}
              icon={<ShoppingBag className="w-5 h-5" />}
            />
            <StatCard
              label="Qty consumed"
              value={productSummary.totalQuantity}
              icon={<Package className="w-5 h-5" />}
            />
            <StatCard
              label="Revenue (paid)"
              value={formatCurrency(productSummary.totalRevenue)}
              icon={<DollarSign className="w-5 h-5" />}
            />
          </div>

          <div className="rounded-lg border border-border overflow-hidden min-h-[200px]">
            <Table wrapperClassName="max-h-[75vh]">
              <TableHeader>
                <TableRow className={tableStickyHeaderRowClassName}>
                  <TableHead>SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Qty sold</TableHead>
                  <TableHead className="text-right">Revenue</TableHead>
                  <TableHead className="text-right">Stock remaining</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingProducts ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : productRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No paid product sales in this range
                    </TableCell>
                  </TableRow>
                ) : (
                  productRows.map((row) => (
                    <Fragment key={row.sku}>
                      <TableRow
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() =>
                          setExpandedProductSkus((prev) => ({
                            ...prev,
                            [row.sku]: !prev[row.sku],
                          }))
                        }
                      >
                        <TableCell className="font-mono text-xs">
                          <div className="flex items-center gap-1">
                            {expandedProductSkus[row.sku] ? (
                              <ChevronDown className="w-4 h-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="w-4 h-4 text-muted-foreground" />
                            )}
                            {row.sku}
                          </div>
                        </TableCell>
                        <TableCell className="font-medium">{row.productName}</TableCell>
                        <TableCell className="text-muted-foreground text-sm">{row.category || "—"}</TableCell>
                        <TableCell className="text-right">{row.quantity}</TableCell>
                        <TableCell className="text-right font-medium">{formatCurrency(row.revenue)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {row.stockQty == null ? "—" : row.stockQty}
                        </TableCell>
                      </TableRow>
                      {expandedProductSkus[row.sku] &&
                        row.variants.map((v, i) => (
                          <TableRow key={`${row.sku}-v-${i}`} className="bg-muted/20 text-sm">
                            <TableCell />
                            <TableCell className="text-muted-foreground pl-8" colSpan={2}>
                              {v.label} @ {formatCurrency(v.unitPrice)}
                            </TableCell>
                            <TableCell className="text-right text-muted-foreground">{v.quantity}</TableCell>
                            <TableCell className="text-right text-muted-foreground">
                              {formatCurrency(v.revenue)}
                            </TableCell>
                            <TableCell />
                          </TableRow>
                        ))}
                    </Fragment>
                  ))
                )}
                {!loadingProducts && productRows.length > 0 && (
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={3}>TOTAL</TableCell>
                    <TableCell className="text-right">{productSummary.totalQuantity}</TableCell>
                    <TableCell className="text-right">{formatCurrency(productSummary.totalRevenue)}</TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <Dialog open={productPrintOpen} onOpenChange={(open) => !open && setProductPrintOpen(false)}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Print Product Report</DialogTitle>
              </DialogHeader>
              <div className="py-6 text-center space-y-3">
                {productPrintStep === "preparing" && (
                  <>
                    <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    <p className="text-sm text-muted-foreground">Preparing report…</p>
                  </>
                )}
                {productPrintStep === "printing" && (
                  <>
                    <Printer className="mx-auto h-10 w-10 text-primary animate-pulse" />
                    <p className="text-sm text-muted-foreground">Saving to prints folder &amp; opening print preview…</p>
                  </>
                )}
                {productPrintStep === "done" && (
                  <>
                    <CheckCircle className="mx-auto h-10 w-10 text-success" />
                    <p className="text-sm font-medium">Report saved &amp; printed</p>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}

      {activeTab === "voids" && canViewVoids && (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            Every voided line with who authorized it and why. Manager / Admin only.
            {voidSummary.truncated
              ? ` Showing ${voidSummary.listed} of ${voidSummary.totalVoids} rows — totals still include all voids.`
              : ""}
          </p>
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
            <StatCard label="Void events" value={voidSummary.totalVoids} icon={<Ban className="w-5 h-5" />} />
            <StatCard label="Qty voided" value={voidSummary.totalQuantity} icon={<Package className="w-5 h-5" />} />
            <StatCard
              label="Amount voided"
              value={formatCurrency(voidSummary.totalAmount)}
              icon={<DollarSign className="w-5 h-5" />}
            />
          </div>

          <div className="rounded-lg border border-border overflow-hidden min-h-[200px]">
            <Table wrapperClassName="max-h-[75vh]">
              <TableHeader>
                <TableRow className={tableStickyHeaderRowClassName}>
                  <TableHead>Date / Time</TableHead>
                  <TableHead>Item</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Voided By</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Table / Session</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingVoids ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                ) : voidRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                      No voids in this range
                    </TableCell>
                  </TableRow>
                ) : (
                  voidRows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="text-sm whitespace-nowrap">{row.voidedAtDisplay}</TableCell>
                      <TableCell>
                        <div className="font-medium">{row.productName}</div>
                        {row.productSku && (
                          <div className="text-xs text-muted-foreground font-mono">{row.productSku}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{row.quantity}</TableCell>
                      <TableCell className="text-right font-medium">{formatCurrency(row.amount)}</TableCell>
                      <TableCell className="text-sm">
                        {row.voidedByName}
                        {row.voidedByEmployeeId && (
                          <div className="text-xs text-muted-foreground">{row.voidedByEmployeeId}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm max-w-[200px]">{row.reason}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {row.tableArea ? `${row.tableArea} · ` : ""}
                        {row.tableName}
                        {row.sessionId != null ? ` · #${row.sessionId}` : ""}
                      </TableCell>
                    </TableRow>
                  ))
                )}
                {!loadingVoids && voidRows.length > 0 && (
                  <TableRow className="bg-muted/40 font-semibold">
                    <TableCell colSpan={2}>TOTAL</TableCell>
                    <TableCell className="text-right">{voidSummary.totalQuantity}</TableCell>
                    <TableCell className="text-right">{formatCurrency(voidSummary.totalAmount)}</TableCell>
                    <TableCell colSpan={3} />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <Dialog open={voidPrintOpen} onOpenChange={(open) => !open && setVoidPrintOpen(false)}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Print Void Report</DialogTitle>
              </DialogHeader>
              <div className="py-6 text-center space-y-3">
                {voidPrintStep === "preparing" && (
                  <>
                    <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    <p className="text-sm text-muted-foreground">Preparing report…</p>
                  </>
                )}
                {voidPrintStep === "printing" && (
                  <>
                    <Printer className="mx-auto h-10 w-10 text-primary animate-pulse" />
                    <p className="text-sm text-muted-foreground">Saving to prints folder &amp; opening print preview…</p>
                  </>
                )}
                {voidPrintStep === "done" && (
                  <>
                    <CheckCircle className="mx-auto h-10 w-10 text-success" />
                    <p className="text-sm font-medium">Report saved &amp; printed</p>
                  </>
                )}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}

      {activeTab === "payroll" && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-6 gap-4 mb-4">
            <StatCard
              label="Total Employees"
              value={displayPayrollSummary.totalEmployees}
              icon={<Users className="w-5 h-5" />}
            />
            <StatCard
              label="Total Payout"
              value={formatCurrency(displayPayrollSummary.totalPayout)}
              icon={<DollarSign className="w-5 h-5" />}
            />
            <StatCard
              label="Total LD (paid)"
              value={displayPayrollSummary.totalLdPaid}
              icon={<ShoppingBag className="w-5 h-5" />}
            />
            <StatCard
              label="Open LD"
              value={displayPayrollSummary.totalLdOpen}
              icon={<Clock className="w-5 h-5" />}
            />
            <StatCard
              label="Total Incentives"
              value={formatCurrency(displayPayrollSummary.totalIncentives)}
              icon={<CheckCircle className="w-5 h-5" />}
            />
            <StatCard
              label="Total Deductions"
              value={formatCurrency(displayPayrollSummary.totalDeductions)}
              icon={<Percent className="w-5 h-5" />}
            />
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Paid LD matches Product report (billed, non-void, non-comp). Open LD is still on unpaid tables and is not in Product qty.
            {displayPayrollSummary.totalLdOpen > 0 && displayPayrollSummary.openLdTables.length > 0
              ? ` Open LD is on: ${displayPayrollSummary.openLdTables
                  .map((t) => `${t.tableCode || t.tableId} (${t.ldCount})`)
                  .join(", ")}.`
              : displayPayrollSummary.totalLdOpen > 0
                ? " Check POS for unpaid tables — leftover pending lines on closed tables are no longer counted."
                : ""}
          </p>

          <div className="rounded-lg border border-border overflow-hidden">
          <Table wrapperClassName="max-h-[500px]">
            <TableHeader>
              <TableRow className={tableStickyHeaderRowClassName}>
                <TableHead className="whitespace-nowrap">Employee</TableHead>
                <TableHead className="whitespace-nowrap">Employee ID</TableHead>
                <TableHead className="whitespace-nowrap">Time In</TableHead>
                <TableHead className="text-right whitespace-nowrap">Budget</TableHead>
                <TableHead className="text-center whitespace-nowrap">Total LD (incl. open)</TableHead>
                <TableHead className="text-right whitespace-nowrap">LD comm.</TableHead>
                <TableHead className="text-right whitespace-nowrap">Incentives</TableHead>
                <TableHead className="text-right whitespace-nowrap">Other Incentives</TableHead>
                <TableHead className="text-right whitespace-nowrap">Adjustments</TableHead>
                <TableHead className="text-right whitespace-nowrap">Deductions</TableHead>
                <TableHead className="text-right whitespace-nowrap font-semibold">Net Payout</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="whitespace-nowrap">Actions</TableHead>
                <TableHead className="whitespace-nowrap">Apprvd By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingPayroll ? (
                <TableRow>
                  <TableCell colSpan={14} className="text-center py-8 text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : filteredPayroll.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={14} className="text-center py-8 text-muted-foreground">
                    No records found
                  </TableCell>
                </TableRow>
              ) : (
                filteredPayroll.map((row) => (
                  <PayrollTableRow
                    key={row.id}
                    row={row}
                    onNameClick={handlePayrollNameClick}
                    onUpdateBreakdown={handleUpdateBreakdown}
                    onApprove={handleApprove}
                    onPrintPayslip={handlePrintPayslip}
                    onDownloadPayslipPdf={handleDownloadPayslipPdf}
                    onPrintPayslipThermal={handlePrintPayslipThermal}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
        </>
      )}

      {/* Payroll LD per table (click employee name) */}
      <Dialog
        open={payrollLdDetailLoading || !!payrollLdDetail}
        onOpenChange={(open) => {
          if (!open) {
            setPayrollLdDetail(null);
            setPayrollLdDetailLoading(false);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>LD by table</DialogTitle>
          </DialogHeader>
          {payrollLdDetailLoading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
          ) : payrollLdDetail ? (
            <div className="space-y-3">
              <table className="w-full border-collapse border border-border text-sm">
                <thead>
                  <tr>
                    <th className="border border-border bg-primary text-primary-foreground font-bold text-center px-3 py-2 w-20">
                      {payrollLdDetail.ownLdCount}
                    </th>
                    <th className="border border-border font-bold text-center px-3 py-2 uppercase">
                      {payrollLdDetail.name}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payrollLdDetail.tables.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="border border-border text-center text-muted-foreground py-3">
                        No LD for this period
                      </td>
                    </tr>
                  ) : (
                    payrollLdDetail.tables.map((t) => (
                      <tr key={t.tableCode}>
                        <td className="border border-border text-center font-medium px-3 py-1.5">{t.tableCode}</td>
                        <td className="border border-border text-center tabular-nums px-3 py-1.5">{t.ldCount}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <p className="text-xs text-muted-foreground">
                Blue header = this staff&apos;s total LD (incl. open). Only tables with LD served are listed.
                Branch kabuuan: {payrollLdDetail.totalLdAll}. Incentive: {formatCurrency(payrollLdDetail.incentiveRate)} ×{" "}
                {payrollLdDetail.totalLdAll} = {formatCurrency(payrollLdDetail.incentives)}
              </p>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Order Detail Modal */}
      <Dialog open={!!orderDetail || orderDetailLoading} onOpenChange={(open) => { if (!open) setOrderDetail(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="w-5 h-5 text-primary" />
              Order History
              {orderDetail && (
                <span className="text-muted-foreground font-normal text-sm ml-1">
                  #{orderDetail.id}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {orderDetailLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              Loading order details…
            </div>
          ) : orderDetail ? (
            <div className="flex flex-col gap-4 overflow-y-auto">
              {/* Order meta */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="w-4 h-4 shrink-0" />
                  <span>{orderDetail.area} — {orderDetail.table}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Users className="w-4 h-4 shrink-0" />
                  <span>{orderDetail.employee || "—"}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="w-4 h-4 shrink-0" />
                  <span>{new Date(orderDetail.createdAt).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}</span>
                </div>
                <div className="flex items-center gap-2 text-muted-foreground">
                  <CreditCard className="w-4 h-4 shrink-0" />
                  <span className="capitalize">{orderDetail.paymentMethod || "—"}</span>
                </div>
              </div>

              <Separator />

              {/* Items list */}
              <div className="rounded-lg border overflow-hidden">
                <Table wrapperClassName="max-h-[min(50vh,360px)]">
                  <TableHeader>
                    <TableRow className={tableStickyHeaderRowClassName}>
                      <TableHead>Item</TableHead>
                      <TableHead className="text-center w-16">Qty</TableHead>
                      <TableHead className="text-right w-24">Unit Price</TableHead>
                      <TableHead className="text-right w-24">Subtotal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {orderDetail.items.map((item) => (
                      <TableRow
                        key={item.id}
                        className={cn(item.isVoided && "opacity-50")}
                      >
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <span className={cn("font-medium text-sm", item.isVoided && "line-through text-muted-foreground")}>
                              {item.name}
                              {item.isComplimentary && (
                                <span className="ml-1.5 text-xs text-purple-600 font-normal">(Complimentary)</span>
                              )}
                              {item.isVoided && (
                                <span className="ml-1.5 text-xs text-destructive font-normal">VOIDED</span>
                              )}
                            </span>
                            {item.servedByName && (
                              <span className="text-xs text-violet-600">Lady: {item.servedByName}</span>
                            )}
                            {item.specialRequest && (
                              <span className="text-xs text-amber-600 italic">"{item.specialRequest}"</span>
                            )}
                            {item.discount > 0 && (
                              <span className="text-xs text-green-600">Discount: -{formatCurrency(item.discount)}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-center tabular-nums">{item.quantity}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCurrency(item.unitPrice)}</TableCell>
                        <TableCell className={cn("text-right tabular-nums font-medium", item.isVoided && "line-through text-muted-foreground")}>
                          {formatCurrency(item.subtotal)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Totals */}
              <div className="rounded-lg border p-4 space-y-2 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span>{formatCurrency(orderDetail.subtotal)}</span>
                </div>
                {orderDetail.discount > 0 && (
                  <div className="flex justify-between text-green-600">
                    <span>Discount</span>
                    <span>-{formatCurrency(orderDetail.discount)}</span>
                  </div>
                )}
                {orderDetail.tax > 0 && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Tax</span>
                    <span>{formatCurrency(orderDetail.tax)}</span>
                  </div>
                )}
                <Separator />
                <div className="flex justify-between font-bold text-base">
                  <span>Total</span>
                  <span>{formatCurrency(orderDetail.total)}</span>
                </div>
              </div>

              {/* Status badge and Print */}
              <div className="flex justify-between items-center gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    if (!orderDetail) return;
                    if (orderDetail.status === "paid" && canReprintFinalBill) {
                      try {
                        const { receipt, orderId } = await api.orders.reprintFinalBill(
                          orderIdFromCode(orderDetail.id),
                          "order_detail"
                        );
                        printFinalBillReceipts([{ orderId, receipt: receipt as Parameters<typeof printFinalBillReceipts>[0][0]["receipt"] }]);
                        toast.success("Final bill reprint opened");
                        return;
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "No final bill on file for this transaction");
                        return;
                      }
                    }
                    if (orderDetail.status === "paid" && !canReprintFinalBill) {
                      toast.error("Only Cashier or Manager can reprint the final bill");
                      return;
                    }
                    const w = window.open("", "_blank", "width=520,height=700");
                    if (!w) return;
                    const itemsRows = orderDetail.items.map((i) =>
                      `<tr><td>${i.name}${i.isComplimentary ? " (Compli)" : ""}${i.isVoided ? " (VOIDED)" : ""}</td><td class="text-center">${i.quantity}</td><td class="text-right">${formatCurrency(i.unitPrice)}</td><td class="text-right">${formatCurrency(i.subtotal)}</td></tr>`
                    ).join("");
                    w.document.write(`
                      <!DOCTYPE html><html><head><title>Order #${orderDetail.id}</title><style>
                        body{font-family:system-ui,sans-serif;padding:16px;font-size:13px;}
                        table{width:100%;border-collapse:collapse;} th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;}
                        .text-right{text-align:right;} .text-center{text-align:center;}
                        .bold{font-weight:bold;} .mt{margin-top:12px;}
                      </style></head><body>
                        <h2>Order #${orderDetail.id}</h2>
                        <p>${orderDetail.area} — ${orderDetail.table} · ${orderDetail.employee || "—"} · ${new Date(orderDetail.createdAt).toLocaleString()}</p>
                        <table class="mt"><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Subtotal</th></tr></thead><tbody>${itemsRows}</tbody></table>
                        <p class="mt bold">Subtotal: ${formatCurrency(orderDetail.subtotal)} · Tax: ${formatCurrency(orderDetail.tax)} · Total: ${formatCurrency(orderDetail.total)}</p>
                        <p class="mt">Status: ${orderDetail.status.toUpperCase()}</p>
                      </body></html>`
                    );
                    w.document.close();
                    w.focus();
                    setTimeout(() => { w.print(); w.close(); }, 250);
                  }}
                >
                  <Printer className="w-4 h-4 mr-2" />
                  {orderDetail.status === "paid" ? "Reprint Final Bill" : "Print"}
                </Button>
                <Badge className={cn(
                  orderDetail.status === "paid"
                    ? "bg-success/20 text-success border-success/30"
                    : orderDetail.status === "voided"
                      ? "bg-destructive/20 text-destructive border-destructive/30"
                      : "bg-warning/20 text-warning border-warning/30"
                )}>
                  {orderDetail.status.toUpperCase()}
                </Badge>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Compute Payout Modal */}
      <Dialog open={computeModalOpen} onOpenChange={() => {}}>
        <DialogContent className="max-w-md [&>button]:hidden">
          <div className="flex flex-col items-center py-4">
            {computeProgress < 100 ? (
              <>
                <div className="w-16 h-16 mb-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <Calculator className="w-8 h-8 text-primary animate-pulse" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Computing Payouts</h3>
                <p className="text-sm text-muted-foreground mb-6">{computeStep}</p>
                <div className="w-full space-y-2">
                  <Progress value={computeProgress} className="h-3" />
                  <p className="text-xs text-muted-foreground text-center">{computeProgress}%</p>
                </div>
              </>
            ) : (
              <>
                <div className="w-16 h-16 mb-6 rounded-full bg-green-500/10 flex items-center justify-center">
                  <CheckCircle className="w-8 h-8 text-green-500" />
                </div>
                <h3 className="text-lg font-semibold text-green-600 mb-2">Computation Complete!</h3>
                <p className="text-sm text-muted-foreground">All payouts have been calculated.</p>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
