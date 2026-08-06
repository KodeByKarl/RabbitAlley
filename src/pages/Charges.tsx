import { useCallback, useEffect, useState } from "react";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Receipt, Search, RefreshCw, CheckCircle } from "lucide-react";
import { api, type ChargeTransaction } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { formatCurrency } from "@/lib/utils";
import { toast } from "sonner";

const today = new Date().toISOString().split("T")[0];
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split("T")[0];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Charges() {
  const { user, hasPermission } = useAuth();
  const canView = hasPermission("manage_settings");
  const [charges, setCharges] = useState<ChargeTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState("");
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(today);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [markingPaid, setMarkingPaid] = useState<number | null>(null);

  const loadCharges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.charges.list({
        customerName: customerName.trim() || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        from: dateFrom,
        to: dateTo,
        limit: 500,
      });
      setCharges(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load charges");
      setCharges([]);
    } finally {
      setLoading(false);
    }
  }, [customerName, dateFrom, dateTo, statusFilter]);

  useEffect(() => {
    if (canView) loadCharges();
  }, [canView, loadCharges]);

  const handleMarkPaid = async (charge: ChargeTransaction) => {
    if (charge.status === "paid") return;
    const methodRaw = window.prompt(
      "Collection method when customer pays utang (cash, gcash, bank, debit, credit):",
      "cash"
    );
    if (methodRaw == null) return;
    const paymentMethod = String(methodRaw).trim().toLowerCase() || "cash";
    setMarkingPaid(charge.id);
    try {
      await api.charges.markPaid(String(charge.id), user?.name, { paymentMethod });
      toast.success(`Marked as paid: ${charge.customerName} (${paymentMethod})`);
      loadCharges();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to mark as paid");
    } finally {
      setMarkingPaid(null);
    }
  };

  if (!canView) {
    return (
      <AppLayout>
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Receipt className="w-12 h-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">You do not have permission to view Charge / Utang.</p>
        </div>
      </AppLayout>
    );
  }

  const pendingTotal = charges.filter((c) => c.status === "pending").reduce((s, c) => s + c.amount, 0);
  const paidTotal = charges.filter((c) => c.status === "paid").reduce((s, c) => s + c.amount, 0);

  return (
    <AppLayout>
      <PageHeader
        title="Charge / Utang"
        description="Monitor customer charges and payment status. Search by name to see if paid or not yet."
      />
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="flex flex-wrap gap-4 mb-6">
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by customer name..."
            value={customerName}
            onChange={(e) => setCustomerName(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">From:</span>
          <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">To:</span>
          <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Not Yet Paid</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={loadCharges} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="flex gap-4 mb-6">
        <div className="rounded-lg border bg-card p-4 flex-1">
          <p className="text-sm text-muted-foreground">Pending (Not Yet Paid)</p>
          <p className="text-xl font-bold text-amber-600">{formatCurrency(pendingTotal)}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 flex-1">
          <p className="text-sm text-muted-foreground">Paid</p>
          <p className="text-xl font-bold text-green-600">{formatCurrency(paidTotal)}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table wrapperClassName="max-h-[500px]">
          <TableHeader>
            <TableRow className={tableStickyHeaderRowClassName}>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Order(s)</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : charges.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                  No charges found. Search by name or adjust date range.
                </TableCell>
              </TableRow>
            ) : (
              charges.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap">{formatDate(c.chargedAt)}</TableCell>
                  <TableCell className="font-medium">{c.customerName}</TableCell>
                  <TableCell className="text-right font-mono">{formatCurrency(c.amount)}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {c.orderIds ? c.orderIds.split(",").map((id) => `#${id.trim()}`).join(", ") : "-"}
                  </TableCell>
                  <TableCell>
                    {c.status === "paid" ? (
                      <Badge variant="secondary" className="bg-green-500/20 text-green-700 dark:text-green-400">
                        Paid{c.paidAt ? ` ${new Date(c.paidAt).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}` : ""}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="bg-amber-500/20 text-amber-700 dark:text-amber-400">
                        Not Yet
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {c.status === "pending" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleMarkPaid(c)}
                        disabled={markingPaid === c.id}
                      >
                        {markingPaid === c.id ? (
                          <span className="animate-pulse">...</span>
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4 mr-1" />
                            Mark Paid
                          </>
                        )}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </AppLayout>
  );
}
