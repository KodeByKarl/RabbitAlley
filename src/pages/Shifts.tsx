import { useEffect, useState, useCallback } from "react";
import { formatCurrency } from "@/lib/utils";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { useAuth } from "@/contexts/AuthContext";
import { api, Shift, ShiftSummary, CashCountItem, ShiftListItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  DialogFooter,
  VisuallyHidden,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { 
  Clock, DollarSign, CreditCard, Smartphone, Building2, Receipt,
  TrendingUp, TrendingDown, AlertTriangle, Check, Printer,
  PlayCircle, StopCircle, Calculator, RefreshCw, ArrowRightLeft
} from "lucide-react";

// Philippine peso denominations
const DENOMINATIONS = [
  { value: "1000", label: "₱1,000" },
  { value: "500", label: "₱500" },
  { value: "200", label: "₱200" },
  { value: "100", label: "₱100" },
  { value: "50", label: "₱50" },
  { value: "20", label: "₱20" },
  { value: "10", label: "₱10" },
  { value: "5", label: "₱5" },
  { value: "1", label: "₱1" },
  { value: "0.25", label: "25¢" },
];

export default function Shifts() {
  const { user, hasPermission } = useAuth();
  const canAccess = hasPermission("close_shift") || hasPermission("view_shift_summary");
  const [currentShift, setCurrentShift] = useState<Shift | null>(null);
  const [shiftSummary, setShiftSummary] = useState<ShiftSummary | null>(null);
  const [shiftHistory, setShiftHistory] = useState<ShiftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  
  // Open Shift Modal
  const [openShiftModal, setOpenShiftModal] = useState(false);
  const [openingCash, setOpeningCash] = useState("");
  
  // Close Shift Modal
  const [closeShiftModal, setCloseShiftModal] = useState(false);
  const [cashCount, setCashCount] = useState<Record<string, number>>({});
  const [varianceReason, setVarianceReason] = useState("");
  const [closeNotes, setCloseNotes] = useState("");
  
  // View Summary Modal
  const [summaryModal, setSummaryModal] = useState(false);
  const [selectedShift, setSelectedShift] = useState<ShiftListItem | null>(null);

  // Conversion Modal (digital -> cash, e.g. pasahod)
  const [conversionModal, setConversionModal] = useState(false);
  const [convFromMethod, setConvFromMethod] = useState("gcash");
  const [convAmount, setConvAmount] = useState("");
  const [convNotes, setConvNotes] = useState("");
  const [convSubmitting, setConvSubmitting] = useState(false);

  // Report Print Modal (same flow as payment: preparing → printing → done)
  const [reportPrintOpen, setReportPrintOpen] = useState(false);
  const [reportPrintStep, setReportPrintStep] = useState<"preparing" | "printing" | "done">("preparing");
  const [reportPrintData, setReportPrintData] = useState<{
    shift: ShiftListItem | ShiftSummary["shift"];
    summary?: ShiftSummary;
  } | null>(null);
  
  // Filter
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleString("en-PH", { 
      month: "short", day: "numeric", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
  };

  const loadData = useCallback(async () => {
    if (!canAccess || !user) return;
    setLoading(true);
    try {
      // Load current shift
      const shift = await api.shifts.getCurrent(String(user.id));
      setCurrentShift(shift);
      
      // If there's an open shift, load its summary
      if (shift && shift.id) {
        const summary = await api.shifts.getSummary(String(shift.id));
        setShiftSummary(summary);
      }
      
      // Load shift history
      const history = await api.shifts.list({ 
        limit: 50,
        status: statusFilter !== "all" ? statusFilter : undefined 
      });
      setShiftHistory(history);
    } catch {
      // Failed to load shift data
    } finally {
      setLoading(false);
    }
  }, [canAccess, user, statusFilter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (!canAccess) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-muted-foreground">You do not have permission to access Shifts.</p>
        </div>
      </AppLayout>
    );
  }

  // Calculate total from cash count
  const calculateCashCountTotal = () => {
    return Object.entries(cashCount).reduce((sum, [denom, qty]) => {
      return sum + (parseFloat(denom) * qty);
    }, 0);
  };

  const handleOpenShift = async () => {
    if (!user) return;
    try {
      const shift = await api.shifts.open(String(user.id), parseFloat(openingCash) || 0);
      setCurrentShift(shift);
      setOpenShiftModal(false);
      setOpeningCash("");
      toast.success("Shift opened successfully!");
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open shift");
    }
  };

  const handleCloseShift = async () => {
    if (!currentShift) return;
    try {
      const actualCash = calculateCashCountTotal();
      const cashCountItems: CashCountItem[] = Object.entries(cashCount)
        .filter(([, qty]) => qty > 0)
        .map(([denom, qty]) => ({
          denomination: denom,
          quantity: qty,
          subtotal: parseFloat(denom) * qty,
        }));
      
      await api.shifts.close(String(currentShift.id), {
        actualCash,
        cashCount: cashCountItems,
        varianceReason: varianceReason || undefined,
        notes: closeNotes || undefined,
      });
      
      setCloseShiftModal(false);
      setCashCount({});
      setVarianceReason("");
      setCloseNotes("");
      setCurrentShift(null);
      setShiftSummary(null);
      toast.success("Shift closed successfully!");
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to close shift");
    }
  };

  const handleRecordConversion = async () => {
    const amt = parseFloat(convAmount);
    if (!amt || amt <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    if (!currentShift?.id) return;
    setConvSubmitting(true);
    try {
      await api.conversions.create({
        fromMethod: convFromMethod,
        amount: amt,
        notes: convNotes.trim() || undefined,
        shiftId: currentShift.id,
      });
      setConversionModal(false);
      setConvAmount("");
      setConvNotes("");
      toast.success("Conversion recorded");
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to record conversion");
    } finally {
      setConvSubmitting(false);
    }
  };

  const handleApproveShift = async (shift: ShiftListItem) => {
    if (!user) return;
    try {
      await api.shifts.approve(String(shift.id), String(user.id));
      toast.success("Shift approved!");
      loadData();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve shift");
    }
  };

  // Build report HTML (shared for modal preview + save + print)
  const buildReportHtml = (
    shift: ShiftListItem | ShiftSummary["shift"],
    summary?: ShiftSummary
  ): { html: string; reportType: string; isZReport: boolean; sales: { cash: number; card: number; gcash: number; bank: number; charge: number; total: number } } => {
    const s = summary?.shift || shift as ShiftListItem;
    const sales = summary?.sales || {
      cash: Number((shift as ShiftListItem).total_cash_sales || 0),
      card: Number((shift as ShiftListItem).total_card_sales || 0),
      gcash: Number((shift as ShiftListItem).total_gcash_sales || 0),
      bank: Number((shift as ShiftListItem).total_bank_sales || 0),
      charge: 0,
      total: 0,
      transactionCount: 0,
    };
    const charge = Number(sales.charge || 0);
    sales.total = sales.cash + sales.card + sales.gcash + sales.bank + charge;
    const isZReport = s.status === "closed" || s.status === "approved";
    const reportType = isZReport ? "Z REPORT" : "X REPORT";
    const html = `<!DOCTYPE html><html><head><title>${reportType}</title><style>
      body { font-family: 'Courier New', monospace; font-size: 12px; width: 80mm; margin: 0 auto; padding: 10px; }
      .header { text-align: center; border-bottom: 2px dashed #000; padding-bottom: 10px; margin-bottom: 10px; }
      .title { font-size: 16px; font-weight: bold; }
      .row { display: flex; justify-content: space-between; margin: 4px 0; }
      .section { border-top: 1px dashed #000; padding-top: 8px; margin-top: 8px; }
      .bold { font-weight: bold; }
      .variance-positive { color: green; }
      .variance-negative { color: red; }
      .footer { text-align: center; margin-top: 20px; font-size: 10px; }
      @media print { body { width: 100%; } }
    </style></head><body>
      <div class="header">
        <div class="title">RABBIT ALLEY</div>
        <div>Garden Bar & Bistro</div>
        <div style="margin-top:10px;font-size:14px;font-weight:bold">${reportType}</div>
      </div>
      <div class="row"><span>Cashier:</span><span>${(s as ShiftListItem).user_name || 'N/A'}</span></div>
      <div class="row"><span>Date:</span><span>${s.shift_date}</span></div>
      <div class="row"><span>Start:</span><span>${formatDateTime(s.start_time)}</span></div>
      ${s.end_time ? `<div class="row"><span>End:</span><span>${formatDateTime(s.end_time)}</span></div>` : ''}
      <div class="section">
        <div class="row bold"><span>SALES SUMMARY</span></div>
        <div class="row"><span>Cash Sales:</span><span>${formatCurrency(sales.cash)}</span></div>
        <div class="row"><span>Card Sales:</span><span>${formatCurrency(sales.card)}</span></div>
        <div class="row"><span>GCash Sales:</span><span>${formatCurrency(sales.gcash)}</span></div>
        <div class="row"><span>Bank Transfer:</span><span>${formatCurrency(sales.bank)}</span></div>
        <div class="row"><span>Charge/Utang:</span><span>${formatCurrency(charge)}</span></div>
        <div class="row bold"><span>TOTAL SALES:</span><span>${formatCurrency(sales.total)}</span></div>
      </div>
      ${isZReport ? `
      <div class="section">
        <div class="row bold"><span>CASH COUNT</span></div>
        <div class="row"><span>Opening Cash:</span><span>${formatCurrency(Number(s.opening_cash))}</span></div>
        <div class="row"><span>+ Cash Sales:</span><span>${formatCurrency(sales.cash)}</span></div>
        <div class="row"><span>- Refunds:</span><span>${formatCurrency(Number(s.total_refunds))}</span></div>
        ${(summary?.conversions?.length || 0) > 0 ? `
        <div style="margin-top:6px;font-size:10px">
          <div class="row bold"><span>CONVERSIONS (Digital→Cash)</span></div>
          ${(summary.conversions || []).map((c: { fromMethod: string; amount: number; notes?: string }) =>
            `<div class="row"><span>${c.fromMethod}→Cash${c.notes ? ` (${c.notes})` : ''}</span><span>${formatCurrency(c.amount)}</span></div>`
          ).join('')}
        </div>
        ` : ''}
        <div class="row bold"><span>Expected Cash:</span><span>${formatCurrency(Number(s.expected_cash))}</span></div>
        <div class="row"><span>Actual Cash:</span><span>${formatCurrency(Number(s.actual_cash || 0))}</span></div>
        <div class="row ${Number(s.cash_variance || 0) >= 0 ? 'variance-positive' : 'variance-negative'}">
          <span>Variance:</span><span>${formatCurrency(Number(s.cash_variance || 0))}</span>
        </div>
        ${s.variance_reason ? `<div style="margin-top:8px;font-size:10px">Reason: ${s.variance_reason}</div>` : ''}
      </div>
      ` : ''}
      <div class="footer">
        <div>--- End of ${reportType} ---</div>
        <div>Printed: ${new Date().toLocaleString()}</div>
      </div>
    </body></html>`;
    return { html, reportType, isZReport, sales };
  };

  // Start report print flow (same as payment: modal with preparing → printing → done)
  const startReportPrintFlow = (shift: ShiftListItem | ShiftSummary["shift"], summary?: ShiftSummary) => {
    setReportPrintData({ shift, summary });
    setReportPrintOpen(true);
    setReportPrintStep("preparing");
    setSummaryModal(false);

    (async () => {
      await new Promise((r) => setTimeout(r, 400));
      setReportPrintStep("printing");

      const { html, reportType } = buildReportHtml(shift, summary);
      try {
        await api.reports.savePrint({ type: reportType, html });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not save to prints folder");
      }
      const win = window.open("", "_blank", "width=400,height=600");
      if (win) {
        win.document.write(html);
        win.document.close();
        win.print();
      }

      await new Promise((r) => setTimeout(r, 2000));
      setReportPrintStep("done");
      await new Promise((r) => setTimeout(r, 1500));
      toast.success("Report saved & printed!");
      setReportPrintOpen(false);
      setReportPrintData(null);
    })();
  };

  const variance = shiftSummary ? calculateCashCountTotal() - shiftSummary.expectedCash : 0;

  return (
    <AppLayout>
      <PageHeader title="Shift Management" subtitle="Manage cashier shifts and cash counts" />

      <div className="p-6 space-y-6">
        {/* Current Shift Status */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-5 w-5" />
                Current Shift
              </CardTitle>
            </CardHeader>
            <CardContent>
              {currentShift ? (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Status:</span>
                    <Badge variant="default" className="bg-green-500">OPEN</Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Started:</span>
                    <span className="font-medium">{formatDateTime(currentShift.start_time)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Opening Cash:</span>
                    <span className="font-medium">{formatCurrency(Number(currentShift.opening_cash))}</span>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-4">
                    <Button 
                      className="flex-1 min-w-[120px]" 
                      variant="outline"
                      onClick={() => setSummaryModal(true)}
                    >
                      <Calculator className="h-4 w-4 mr-2" />
                      X Report
                    </Button>
                    <Button 
                      className="flex-1 min-w-[120px]"
                      variant="secondary"
                      onClick={() => setConversionModal(true)}
                    >
                      <ArrowRightLeft className="h-4 w-4 mr-2" />
                      Record Conversion
                    </Button>
                    <Button 
                      className="flex-1 min-w-[120px]" 
                      variant="destructive"
                      onClick={() => setCloseShiftModal(true)}
                      disabled={!hasPermission("close_shift")}
                    >
                      <StopCircle className="h-4 w-4 mr-2" />
                      Close Shift
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="text-center py-6">
                  <p className="text-muted-foreground mb-4">No active shift</p>
                  <Button onClick={() => setOpenShiftModal(true)} disabled={!hasPermission("close_shift")}>
                    <PlayCircle className="h-4 w-4 mr-2" />
                    Open Shift
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {shiftSummary && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="h-5 w-5" />
                  Running Totals
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <DollarSign className="h-4 w-4 text-green-500" />
                    Cash Sales:
                  </span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.cash)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-blue-500" />
                    Card Sales:
                  </span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.card)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Smartphone className="h-4 w-4 text-blue-400" />
                    GCash Sales:
                  </span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.gcash)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-purple-500" />
                    Bank Transfer:
                  </span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.bank)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Receipt className="h-4 w-4 text-orange-500" />
                    Charge/Utang (AR):
                  </span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.charge || 0)}</span>
                </div>
                {(shiftSummary.chargeCollections?.total || 0) > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Utang collected (cash):</span>
                    <span className="font-medium">{formatCurrency(shiftSummary.chargeCollections?.cash || 0)}</span>
                  </div>
                )}
                {(shiftSummary.conversionCash || 0) > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Conversions → cash:</span>
                    <span className="font-medium">{formatCurrency(shiftSummary.conversionCash || 0)}</span>
                  </div>
                )}
                <div className="border-t pt-3 flex items-center justify-between font-bold">
                  <span>Total Sales:</span>
                  <span className="text-lg">{formatCurrency(shiftSummary.sales.total)}</span>
                </div>
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Transactions:</span>
                  <span>{shiftSummary.sales.transactionCount}</span>
                </div>
                <div className="flex items-center justify-between font-medium pt-2">
                  <span>Expected Cash:</span>
                  <span>{formatCurrency(shiftSummary.expectedCash)}</span>
                </div>
                {shiftSummary.conversions && shiftSummary.conversions.length > 0 && (
                  <div className="border-t pt-3 space-y-1">
                    <h5 className="text-sm font-medium flex items-center gap-2">
                      <ArrowRightLeft className="h-4 w-4" /> Conversions
                    </h5>
                    {shiftSummary.conversions.map((c, i) => (
                      <div key={i} className="flex justify-between text-sm text-muted-foreground">
                        <span>{c.fromMethod} → Cash{c.notes ? ` (${c.notes})` : ""}</span>
                        <span>{formatCurrency(c.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Shift History */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Shift History</CardTitle>
            <div className="flex items-center gap-2">
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Filter status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="outline" size="icon" onClick={loadData}>
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-hidden">
              <Table wrapperClassName="max-h-[400px]">
                <TableHeader>
                  <TableRow className={tableStickyHeaderRowClassName}>
                    <TableHead>Date</TableHead>
                    <TableHead>Cashier</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead className="text-right">Total Sales</TableHead>
                    <TableHead className="text-right">Variance</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shiftHistory.map((shift) => (
                    <TableRow key={shift.id}>
                      <TableCell>{shift.shift_date}</TableCell>
                      <TableCell>{shift.user_name}</TableCell>
                      <TableCell className="text-sm">{formatDateTime(shift.start_time)}</TableCell>
                      <TableCell className="text-sm">{shift.end_time ? formatDateTime(shift.end_time) : "-"}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(
                          Number(shift.total_cash_sales) + 
                          Number(shift.total_card_sales) + 
                          Number(shift.total_gcash_sales) + 
                          Number(shift.total_bank_sales)
                        )}
                      </TableCell>
                      <TableCell className={`text-right ${
                        Number(shift.cash_variance || 0) > 0 ? 'text-green-600' : 
                        Number(shift.cash_variance || 0) < 0 ? 'text-red-600' : ''
                      }`}>
                        {shift.cash_variance !== null ? formatCurrency(Number(shift.cash_variance)) : "-"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={
                          shift.status === 'approved' ? 'default' :
                          shift.status === 'closed' ? 'secondary' : 'outline'
                        }>
                          {shift.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex gap-1 justify-end">
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={() => startReportPrintFlow(shift)}
                            title="Print Z Report"
                          >
                            <Printer className="h-4 w-4" />
                          </Button>
                          {shift.status === 'closed' && hasPermission("approve_cash_discrepancy") && (
                            <Button 
                              variant="ghost" 
                              size="icon"
                              onClick={() => handleApproveShift(shift)}
                              title="Approve Shift"
                            >
                              <Check className="h-4 w-4 text-green-500" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {shiftHistory.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                        No shift history found
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Open Shift Modal */}
      <Dialog open={openShiftModal} onOpenChange={setOpenShiftModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open New Shift</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Opening Cash (Float)</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={openingCash}
                onChange={(e) => setOpeningCash(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Enter the starting cash in the register
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenShiftModal(false)}>Cancel</Button>
            <Button onClick={handleOpenShift}>Open Shift</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close Shift Modal */}
      <Dialog open={closeShiftModal} onOpenChange={setCloseShiftModal}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Close Shift - Cash Count</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            {/* Summary */}
            {shiftSummary && (
              <div className="bg-muted p-4 rounded-lg space-y-2">
                <h4 className="font-semibold">Shift Summary</h4>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <span>Opening Cash:</span>
                  <span className="text-right">{formatCurrency(Number(currentShift?.opening_cash || 0))}</span>
                  <span>+ Cash Sales:</span>
                  <span className="text-right">{formatCurrency(shiftSummary.sales.cash)}</span>
                  <span>- Refunds:</span>
                  <span className="text-right">{formatCurrency(shiftSummary.refunds)}</span>
                  <span className="font-semibold">Expected Cash:</span>
                  <span className="text-right font-semibold">{formatCurrency(shiftSummary.expectedCash)}</span>
                </div>
                {shiftSummary.conversions && shiftSummary.conversions.length > 0 && (
                  <div className="border-t pt-2 mt-2">
                    <h5 className="font-medium text-sm mb-1">Conversions (Digital → Cash)</h5>
                    {shiftSummary.conversions.map((c, i) => (
                      <div key={i} className="flex justify-between text-xs text-muted-foreground">
                        <span>{c.fromMethod} → Cash{c.notes ? ` (${c.notes})` : ""}</span>
                        <span>{formatCurrency(c.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Denomination Count */}
            <div>
              <h4 className="font-semibold mb-3">Cash Count by Denomination</h4>
              <div className="grid grid-cols-2 gap-3">
                {DENOMINATIONS.map((d) => (
                  <div key={d.value} className="flex items-center gap-2">
                    <Label className="w-16">{d.label}</Label>
                    <Input
                      type="number"
                      min="0"
                      className="w-20"
                      value={cashCount[d.value] || ""}
                      onChange={(e) => setCashCount(prev => ({
                        ...prev,
                        [d.value]: parseInt(e.target.value) || 0
                      }))}
                    />
                    <span className="text-sm text-muted-foreground w-24 text-right">
                      = {formatCurrency((cashCount[d.value] || 0) * parseFloat(d.value))}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Total and Variance */}
            <div className="bg-muted p-4 rounded-lg space-y-2">
              <div className="flex justify-between font-semibold">
                <span>Counted Cash:</span>
                <span>{formatCurrency(calculateCashCountTotal())}</span>
              </div>
              {shiftSummary && (
                <div className={`flex justify-between font-semibold ${
                  variance > 0 ? 'text-green-600' : variance < 0 ? 'text-red-600' : ''
                }`}>
                  <span className="flex items-center gap-2">
                    {variance !== 0 && (variance > 0 ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />)}
                    Variance:
                  </span>
                  <span>{variance >= 0 ? '+' : ''}{formatCurrency(variance)}</span>
                </div>
              )}
            </div>

            {/* Variance Reason */}
            {variance !== 0 && (
              <div className="space-y-2">
                <Label className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-500" />
                  Variance Reason (Required)
                </Label>
                <Textarea
                  placeholder="Explain the cash variance..."
                  value={varianceReason}
                  onChange={(e) => setVarianceReason(e.target.value)}
                />
              </div>
            )}

            {/* Notes */}
            <div className="space-y-2">
              <Label>Additional Notes (Optional)</Label>
              <Textarea
                placeholder="Any additional notes about this shift..."
                value={closeNotes}
                onChange={(e) => setCloseNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseShiftModal(false)}>Cancel</Button>
            <Button 
              onClick={handleCloseShift}
              disabled={variance !== 0 && !varianceReason.trim()}
            >
              Close Shift
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record Conversion Modal */}
      <Dialog open={conversionModal} onOpenChange={setConversionModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-5 w-5" />
              Record Conversion (Digital → Cash)
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            When GCash, Bank, BPI, etc. are converted to physical cash (e.g. for pasahod), record it here to avoid confusion.
          </p>
          <div className="space-y-4 py-4">
            <div>
              <Label>Convert from</Label>
              <Select value={convFromMethod} onValueChange={setConvFromMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gcash">GCash</SelectItem>
                  <SelectItem value="bank">Bank Transfer</SelectItem>
                  <SelectItem value="debit">Debit Card</SelectItem>
                  <SelectItem value="credit">Credit Card</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Amount (₱)</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={convAmount}
                onChange={(e) => setConvAmount(e.target.value)}
              />
            </div>
            <div>
              <Label>Notes (optional, e.g. "Pasahod")</Label>
              <Input
                placeholder="Reason for conversion..."
                value={convNotes}
                onChange={(e) => setConvNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConversionModal(false)}>Cancel</Button>
            <Button onClick={handleRecordConversion} disabled={!convAmount || parseFloat(convAmount) <= 0 || convSubmitting}>
              {convSubmitting ? "Recording…" : "Record"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* X Report Modal */}
      <Dialog open={summaryModal} onOpenChange={setSummaryModal}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>X Report - Running Summary</DialogTitle>
          </DialogHeader>
          {shiftSummary && (
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Cash Sales:</span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.cash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Card Sales:</span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.card)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">GCash Sales:</span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.gcash)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bank Transfer:</span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.bank)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Charge/Utang:</span>
                  <span className="font-medium">{formatCurrency(shiftSummary.sales.charge || 0)}</span>
                </div>
                <div className="border-t pt-2 flex justify-between font-bold">
                  <span>Total Sales:</span>
                  <span>{formatCurrency(shiftSummary.sales.total)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Transactions:</span>
                  <span>{shiftSummary.sales.transactionCount}</span>
                </div>
                <div className="border-t pt-2 flex justify-between font-bold">
                  <span>Expected Cash in Drawer:</span>
                  <span>{formatCurrency(shiftSummary.expectedCash)}</span>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSummaryModal(false)}>Close</Button>
            <Button onClick={() => shiftSummary && startReportPrintFlow(shiftSummary.shift, shiftSummary)}>
              <Printer className="h-4 w-4 mr-2" />
              Print X Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report Printing Modal (same flow as payment) */}
      <Dialog open={reportPrintOpen} onOpenChange={(open) => !open && setReportPrintOpen(false)}>
        <DialogContent className="max-w-md [&>button]:hidden">
          <VisuallyHidden>
            <DialogTitle>Report Printing</DialogTitle>
          </VisuallyHidden>
          <div className="flex flex-col items-center">
            <div className="mb-6 text-center">
              {reportPrintStep === "preparing" && (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/10 flex items-center justify-center">
                    <Clock className="w-8 h-8 text-blue-500 animate-pulse" />
                  </div>
                  <h3 className="text-lg font-semibold">Preparing Report</h3>
                  <p className="text-sm text-muted-foreground">Please wait...</p>
                </>
              )}
              {reportPrintStep === "printing" && (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center relative">
                    <Printer className="w-8 h-8 text-amber-500" />
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full animate-ping" />
                  </div>
                  <h3 className="text-lg font-semibold">Printing Report</h3>
                  <p className="text-sm text-muted-foreground">Saving to prints folder & printing</p>
                </>
              )}
              {reportPrintStep === "done" && (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/10 flex items-center justify-center">
                    <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-green-600">Report Complete!</h3>
                  <p className="text-sm text-muted-foreground">Report saved & printed successfully</p>
                </>
              )}
            </div>

            {/* Report Preview - 80mm thermal style (same as payment receipt) */}
            {reportPrintData && (
              <div className={`w-full bg-white dark:bg-zinc-950 border border-border rounded-lg overflow-hidden transition-all duration-500 ${reportPrintStep === "printing" ? "animate-pulse" : ""}`}>
                {reportPrintStep === "printing" && (
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent via-amber-500/5 to-transparent animate-[scan_1.5s_ease-in-out_infinite]" />
                )}
                <div className="p-4 font-mono text-xs leading-relaxed relative">
                  {(() => {
                    const d = reportPrintData;
                    if (!d) return null;
                    const { reportType, isZReport, sales } = buildReportHtml(d.shift, d.summary);
                    const s = d.summary?.shift || d.shift as ShiftListItem;
                    return (
                      <>
                        <div className="text-center border-b border-dashed border-gray-300 dark:border-gray-700 pb-3 mb-3">
                          <p className="text-base font-bold tracking-wider">RABBIT ALLEY</p>
                          <p className="text-[10px] text-muted-foreground">Garden Bar & Bistro</p>
                          <p className="text-sm font-bold mt-1">{reportType}</p>
                        </div>
                        <div className="border-b border-dashed border-gray-300 dark:border-gray-700 pb-3 mb-3 space-y-1">
                          <div className="flex justify-between"><span>Cashier:</span><span>{s.user_name || "N/A"}</span></div>
                          <div className="flex justify-between"><span>Date:</span><span>{s.shift_date}</span></div>
                          <div className="flex justify-between"><span>Start:</span><span>{formatDateTime(s.start_time)}</span></div>
                          {s.end_time && <div className="flex justify-between"><span>End:</span><span>{formatDateTime(s.end_time)}</span></div>}
                        </div>
                        <div className="border-b border-dashed border-gray-300 dark:border-gray-700 pb-3 mb-3">
                          <p className="font-bold mb-2">SALES SUMMARY</p>
                          <div className="space-y-1">
                            <div className="flex justify-between"><span>Cash Sales:</span><span>{formatCurrency(sales.cash)}</span></div>
                            <div className="flex justify-between"><span>Card Sales:</span><span>{formatCurrency(sales.card)}</span></div>
                            <div className="flex justify-between"><span>GCash Sales:</span><span>{formatCurrency(sales.gcash)}</span></div>
                            <div className="flex justify-between"><span>Bank Transfer:</span><span>{formatCurrency(sales.bank)}</span></div>
                            <div className="flex justify-between"><span>Charge/Utang:</span><span>{formatCurrency(sales.charge || 0)}</span></div>
                            <div className="flex justify-between font-bold pt-1"><span>TOTAL SALES:</span><span>{formatCurrency(sales.total)}</span></div>
                          </div>
                        </div>
                        {isZReport && (
                          <div className="border-b border-dashed border-gray-300 dark:border-gray-700 pb-3 mb-3">
                            <p className="font-bold mb-2">CASH COUNT</p>
                            <div className="space-y-1">
                              <div className="flex justify-between"><span>Opening Cash:</span><span>{formatCurrency(Number(s.opening_cash))}</span></div>
                              <div className="flex justify-between"><span>Expected Cash:</span><span>{formatCurrency(Number(s.expected_cash))}</span></div>
                              <div className="flex justify-between"><span>Actual Cash:</span><span>{formatCurrency(Number(s.actual_cash || 0))}</span></div>
                              <div className={`flex justify-between ${Number(s.cash_variance || 0) >= 0 ? "text-green-600" : "text-red-600"}`}>
                                <span>Variance:</span><span>{formatCurrency(Number(s.cash_variance || 0))}</span>
                              </div>
                            </div>
                          </div>
                        )}
                        <div className="text-center text-[10px] text-muted-foreground pt-2">
                          <p>--- End of {reportType} ---</p>
                        </div>
                        {reportPrintStep === "printing" && (
                          <div className="absolute left-0 right-0 h-0.5 bg-amber-500 animate-[printLine_1.5s_ease-in-out_infinite]" style={{ top: "var(--print-line-pos, 0)" }} />
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
            )}

            {reportPrintStep === "printing" && (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span>Saving to prints folder & printing</span>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <style>{`
        @keyframes scan {
          0%, 100% { transform: translateY(-100%); }
          50% { transform: translateY(100%); }
        }
        @keyframes printLine {
          0% { top: 0; opacity: 1; }
          100% { top: 100%; opacity: 0.5; }
        }
      `}</style>
    </AppLayout>
  );
}
