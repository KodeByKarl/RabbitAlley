import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { AppLayout } from "@/components/layout/AppLayout";
import { useAuth } from "@/contexts/AuthContext";
import { api, type OrderItem } from "@/lib/api";
import { formatOrderDisplayNumber, formatOrderListLabel, formatOrderTabLabel } from "@/lib/formatOrderNumber";
import { useTableOrderSession, type OrderTab } from "@/hooks/useTableOrderSession";
import { getPrinterForJob, deptToPrintJobType, PRINT_JOB_LABELS } from "@/lib/storage-keys";
import { isQzTrayEnabled, qzPrintRawBase64 } from "@/lib/qzTray";
import { getPosSettings } from "@/lib/posSettings";
import { isFloorWaiter } from "@/lib/floorStaff";
import {
  loadPendingBillAdjustments,
  savePendingBillAdjustments,
  clearPendingBillAdjustments,
} from "@/lib/pendingBillAdjustments";
import {
  type PaymentMethod,
  type SplitMethod,
  MANUAL_AMOUNT_METHODS,
  isCardPaymentMethod,
  normalizePaymentMethod,
  paymentMethodLabel as formatPaymentMethodLabel,
} from "@/lib/paymentMethods";
import { type Table, type Product } from "@/types/pos";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Send, CreditCard, Eye, Printer, ChefHat, Wine, Banknote, Smartphone, Building2, Wallet, Tag, Percent, X, Gift, Plus, Lock, Receipt, User, Ban, MessageSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  VisuallyHidden,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

export default function POSTableOrder() {
  const { tableId } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, hasPermission, logout } = useAuth();
  const floorWaiter = isFloorWaiter(hasPermission);
  const {
    table,
    setTable,
    tablesLoading,
    sessionError,
    orderTabs,
    setOrderTabs,
    activeTabIndex,
    setActiveTabIndex,
    refetchOrders,
  } = useTableOrderSession(tableId, { releaseOnLeave: floorWaiter });
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>("");
  const [sendToDeptOpen, setSendToDeptOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [processingPayment, setProcessingPayment] = useState(false);
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [paymentStep, setPaymentStep] = useState<"processing" | "printing" | "done">("processing");
  const [lastReceiptSentToBackend, setLastReceiptSentToBackend] = useState(false);
  const [lastReceiptForPrint, setLastReceiptForPrint] = useState<{
    orderNumber: string;
    date: string;
    time: string;
    table: string;
    cashier: string;
    items: Array<{ name: string; quantity: number; subtotal: number; isComplimentary?: boolean; note?: string }>;
    subtotal: number;
    complimentary?: number;
    discount?: number;
    serviceCharge: number;
    tax: number;
    cardSurcharge?: number;
    total: number;
    amountDue?: number;
    paymentMethod: string;
    amountPaid: number;
    change: number;
  } | null>(null);
  /** Paid order IDs from the most recent successful payment on this table (for final bill reprint). */
  const [lastPaidOrderIds, setLastPaidOrderIds] = useState<string[]>([]);
  const [paymentMethodModalOpen, setPaymentMethodModalOpen] = useState(false);
  const [selectedPaymentMethod, setSelectedPaymentMethod] = useState<PaymentMethod>(() => {
    const saved = loadPendingBillAdjustments(tableId);
    return normalizePaymentMethod(saved?.selectedPaymentMethod);
  });
  const [useSplitPayment, setUseSplitPayment] = useState(() => !!loadPendingBillAdjustments(tableId)?.useSplitPayment);
  const [splitPayments, setSplitPayments] = useState<Array<{ amount: string; method: SplitMethod }>>(() => {
    const saved = loadPendingBillAdjustments(tableId)?.splitPayments;
    if (saved && saved.length >= 2) {
      return saved.map((s) => ({
        amount: s.amount || "",
        method: (s.method as SplitMethod) || "cash",
      }));
    }
    return [
      { amount: "", method: "cash" },
      { amount: "", method: "bank" },
    ];
  });
  const [splitChargeNames, setSplitChargeNames] = useState<Record<number, string>>(() => {
    const saved = loadPendingBillAdjustments(tableId)?.splitChargeNames || {};
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(saved)) {
      const n = Number(k);
      if (Number.isFinite(n)) out[n] = v;
    }
    return out;
  });
  const [chargeCustomerName, setChargeCustomerName] = useState(
    () => loadPendingBillAdjustments(tableId)?.chargeCustomerName || ""
  );
  const [chargeAuthModalOpen, setChargeAuthModalOpen] = useState(false);
  const [chargeAuthCustomerName, setChargeAuthCustomerName] = useState("");
  const [ladyModalOpen, setLadyModalOpen] = useState(false);
  const [pendingLdProduct, setPendingLdProduct] = useState<Product | null>(null);
  const [ldLadies, setLdLadies] = useState<Array<{ id: string; code: string; name: string }>>([]);
  const [selectedLady, setSelectedLady] = useState<string>("");
  const [selectedLdLadyForCategory, setSelectedLdLadyForCategory] = useState<string>("");
  const [amountTendered, setAmountTendered] = useState<string>("");
  // Server-authoritative bill total (mirrors pay-all math) — prevents "amount less than due" drift.
  const [serverBill, setServerBill] = useState<{ total: number; baseTotal: number } | null>(null);
  const [discountModalOpen, setDiscountModalOpen] = useState(false);
  const [managerAuthModalOpen, setManagerAuthModalOpen] = useState(false);
  const [pendingDiscount, setPendingDiscount] = useState<{ id: string; name: string; type: string; value: string } | null>(null);
  const [managerEmployeeId, setManagerEmployeeId] = useState("");
  const [managerPassword, setManagerPassword] = useState("");
  const [managerAuthError, setManagerAuthError] = useState<string | null>(null);
  const [managerAuthLoading, setManagerAuthLoading] = useState(false);
  const [availableDiscounts, setAvailableDiscounts] = useState<Array<{ id: string; name: string; type: string; value: string; category?: string | null }>>([]);
  const [appliedDiscount, setAppliedDiscount] = useState<{ id: string; name: string; type: string; value: string } | null>(
    () => loadPendingBillAdjustments(tableId)?.appliedDiscount ?? null
  );

  // Persist pending discount / payment method (card surcharge) for this table session.
  // Survives Bill Summary print and re-opening payment; cleared only on pay or manual remove.
  useEffect(() => {
    if (!tableId) return;
    savePendingBillAdjustments(tableId, {
      appliedDiscount,
      selectedPaymentMethod,
      useSplitPayment,
      splitPayments,
      chargeCustomerName,
      splitChargeNames: Object.fromEntries(
        Object.entries(splitChargeNames).map(([k, v]) => [String(k), v])
      ),
    });
  }, [
    tableId,
    appliedDiscount,
    selectedPaymentMethod,
    useSplitPayment,
    splitPayments,
    chargeCustomerName,
    splitChargeNames,
  ]);

  useEffect(() => {
    setLastPaidOrderIds([]);
  }, [tableId]);

  // Table is "In use" only while ordering: claim on first draft item, release when
  // the draft cart becomes empty again (or on leave via releaseOnLeave). Opening /
  // browsing alone must not lock the floor grid. Do not remove — without claim-on-
  // punch + release-on-empty, tables stick as "In use" after browse-and-back or a
  // cancelled draft. Skipped once any order is sent; backend also no-ops release
  // when a real pending order exists (occupied path untouched).
  const hadUnsentItemsRef = useRef(false);
  useEffect(() => {
    if (!tableId) {
      hadUnsentItemsRef.current = false;
      return;
    }
    const hasAnySentOrder = orderTabs.some((t) => t.sent);
    const unsentItemCount = orderTabs
      .filter((t) => !t.sent)
      .reduce((sum, t) => sum + t.items.length, 0);
    const hasUnsentItems = unsentItemCount > 0;

    if (!hadUnsentItemsRef.current && hasUnsentItems && !hasAnySentOrder) {
      void api.pos.claimTable(tableId).catch((err: Error) => {
        toast.error(err.message || "Could not claim this table");
      });
    } else if (hadUnsentItemsRef.current && !hasUnsentItems && !hasAnySentOrder) {
      void api.pos.releaseTable(tableId).catch(() => {});
    }
    hadUnsentItemsRef.current = hasUnsentItems;
  }, [tableId, orderTabs]);

  // Fetch the server-authoritative bill total whenever the payment UI is open or its inputs change.
  // Self-contained (computes its own inputs) so it stays above the loading/error early returns.
  useEffect(() => {
    if (!tableId) {
      setServerBill(null);
      return;
    }
    if (!paymentMethodModalOpen && !paymentModalOpen) return;
    const sentItems = orderTabs
      .filter((t) => t.sent)
      .flatMap((t) => t.items)
      .filter((i) => !i.isVoided);
    if (sentItems.length === 0) {
      setServerBill(null);
      return;
    }
    const chargeable = sentItems.reduce(
      (s, i) => s + (i.isComplimentary ? 0 : i.subtotal),
      0
    );
    const discount = appliedDiscount
      ? appliedDiscount.value.includes("%")
        ? chargeable * (parseFloat(appliedDiscount.value) / 100)
        : parseFloat(appliedDiscount.value) || 0
      : 0;
    const splitsPayload = useSplitPayment
      ? splitPayments
          .filter((sp) => Number(sp.amount) > 0)
          .map((sp) => ({ amount: Number(sp.amount) || 0, paymentMethod: normalizePaymentMethod(sp.method) }))
      : undefined;
    let cancelled = false;
    api.tables
      .billPreview(tableId, {
        paymentMethod: useSplitPayment ? undefined : selectedPaymentMethod,
        discountAmount: discount > 0 ? discount : undefined,
        splits: splitsPayload && splitsPayload.length >= 2 ? splitsPayload : undefined,
      })
      .then((res) => {
        if (cancelled) return;
        // Empty/settled table (or post-payment race) → fall back to local math, don't show ₱0.
        setServerBill(res.total > 0 ? { total: res.total, baseTotal: res.baseTotal } : null);
      })
      .catch(() => {
        // Fall back to local math if preview is unavailable.
        if (!cancelled) setServerBill(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    tableId,
    orderTabs,
    appliedDiscount,
    paymentMethodModalOpen,
    paymentModalOpen,
    selectedPaymentMethod,
    useSplitPayment,
    splitPayments,
  ]);

  const [voidModalOpen, setVoidModalOpen] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [voidEmployeeId, setVoidEmployeeId] = useState("");
  const [voidPassword, setVoidPassword] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  /** Item ids (order_items.id) selected to void in Request Void modal */
  const [voidSelectedIds, setVoidSelectedIds] = useState<string[]>([]);
  const [voidLookupQuery, setVoidLookupQuery] = useState("");
  const [voidLookupResults, setVoidLookupResults] = useState<Array<{
    orderId: string;
    orderNumber: string;
    tableId: string | null;
    tableName: string | null;
    area: string | null;
    status: string;
    voided: boolean;
  }> | null>(null);
  const [voidLookupLoading, setVoidLookupLoading] = useState(false);
  const [itemVoidModalOpen, setItemVoidModalOpen] = useState(false);
  const [pendingVoidItem, setPendingVoidItem] = useState<OrderItem | null>(null);
  const [itemVoidEmployeeId, setItemVoidEmployeeId] = useState("");
  const [itemVoidPassword, setItemVoidPassword] = useState("");
  const [itemVoidReason, setItemVoidReason] = useState("");
  const [itemVoidError, setItemVoidError] = useState<string | null>(null);
  const [itemVoiding, setItemVoiding] = useState(false);
  const [commentModal, setCommentModal] = useState<{ productId: string; servedBy?: string; value: string } | null>(null);
  const [pricePickProduct, setPricePickProduct] = useState<Product | null>(null);
  const [pricePickContext, setPricePickContext] = useState<{
    servedBy?: string;
    servedByName?: string;
    specialRequest?: string;
  } | null>(null);

  const clearPendingBillState = useCallback(() => {
    clearPendingBillAdjustments(tableId);
    setAppliedDiscount(null);
    setSelectedPaymentMethod("cash");
    setUseSplitPayment(false);
    setSplitPayments([
      { amount: "", method: "cash" },
      { amount: "", method: "gcash" },
    ]);
    setSplitChargeNames({});
    setChargeCustomerName("");
    setAmountTendered("");
  }, [tableId]);

  useEffect(() => {
    if (!ladyModalOpen && selectedCategory !== "Ladies Drink") return;
    api.staff.ldLadies().then(setLdLadies).catch(() => setLdLadies([]));
  }, [ladyModalOpen, selectedCategory]);

  useEffect(() => {
    if (selectedCategory !== "Ladies Drink" && selectedLdLadyForCategory) {
      setSelectedLdLadyForCategory("");
    }
  }, [selectedCategory, selectedLdLadyForCategory]);

  useEffect(() => {
    setSelectedSubCategory("");
  }, [selectedCategory]);

  // Load products from API (with area so prices match table: Lounge vs Club vs LD)
  // When we have a table, wait for it so we pass area and price-by-area reflects correctly
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const area = table?.area ?? undefined;
        const productList = await api.products.list(area ? { area } : undefined);
        if (!cancelled) {
          const mappedProducts: Product[] = productList
            .filter(p => p.status === "active")
            .map(p => ({
              id: String(p.id),
              sku: p.sku,
              name: p.name,
              description: p.description,
              category: p.category,
              sub_category: p.sub_category ?? "",
              department: p.department,
              price: p.price,
              priceId: p.priceId ?? null,
              cost: p.cost,
              commission: p.commission,
              status: p.status as "active" | "inactive",
              pricesByArea: p.pricesByArea,
              prices: p.prices,
              priceVariants: p.priceVariants,
              stockQty: p.stockQty,
            }));
          setProducts(mappedProducts);

          // Build category list from ALL products (active + inactive) so every category shows in POS
          const isListOfLadiesCategory = (cat: string) => /list\s+of\s+ladies/i.test(cat) || /ladies\s+drink/i.test(cat);
          const uniqueCategories = [...new Set(productList.map((p) => p.category).filter(Boolean))].sort();
          const hasLdProducts = productList.some((p) => p.department === "LD");
          const categoryList = hasLdProducts
            ? ["Ladies Drink", ...uniqueCategories.filter((cat) => cat !== "LD" && !isListOfLadiesCategory(cat))]
            : uniqueCategories.filter((cat) => !isListOfLadiesCategory(cat));
          setCategories(categoryList);
          if (categoryList.length > 0) {
            setSelectedCategory((prev) => (prev && categoryList.includes(prev) ? prev : categoryList[0]));
          }
        }
      } catch {
        // Products failed to load
      }
    })();
    return () => { cancelled = true; };
  }, [table?.area]);

  // Role-based permissions
  const canAddToOrder = hasPermission("create_orders");           // Staff only
  const canSendToDept = hasPermission("send_to_departments");     // Staff only
  const canProcessPayment = hasPermission("accept_payments");     // Cashier, Admin
  const canPrintReceipt = hasPermission("print_receipts");        // Cashier, Admin
  /** Final bill reprint: Cashier or Manager/Admin (not Waiters). */
  const canReprintFinalBill =
    hasPermission("print_receipts") ||
    hasPermission("approve_discounts") ||
    hasPermission("manage_settings") ||
    hasPermission("view_reports");
  const canRequestVoid = hasPermission("request_voids");
  const canApproveDiscounts = hasPermission("approve_discounts"); // Manager only - skip password if has this
  // Monitor-only: Admin (has no floor operations - no add, no send, no payment)
  const isMonitorOnly = !canAddToOrder && !canSendToDept && !canProcessPayment;

  // Sub-categories for current category (e.g. 1pc, 2pc, Gravy under Chickenjoy)
  const subCategoriesForCurrent = useMemo(() => {
    if (!selectedCategory) return [];
    const inCategory = selectedCategory === "Ladies Drink"
      ? products.filter((p) => p.department === "LD")
      : products.filter((p) => p.category === selectedCategory && p.department !== "LD");
    const subs = [...new Set(inCategory.map((p) => (p as Product & { sub_category?: string }).sub_category).filter((s): s is string => Boolean(s?.trim())))].sort();
    return subs;
  }, [products, selectedCategory]);

  // Memoize filtered products for better performance (must be before early returns!)
  const filteredProducts = useMemo(
    () => {
      if (selectedCategory === "Ladies Drink") {
        const ldProducts = products.filter((p) => p.department === "LD");
        if (selectedSubCategory && subCategoriesForCurrent.length > 0) {
          return ldProducts.filter((p) => (p as Product & { sub_category?: string }).sub_category === selectedSubCategory);
        }
        return ldProducts;
      }
      const byCategory = products.filter((p) => p.category === selectedCategory && p.department !== "LD");
      if (selectedSubCategory && subCategoriesForCurrent.length > 0) {
        return byCategory.filter((p) => (p as Product & { sub_category?: string }).sub_category === selectedSubCategory);
      }
      return byCategory;
    },
    [products, selectedCategory, selectedSubCategory, subCategoriesForCurrent]
  );
  const selectedLdLadyProfile = useMemo(
    () => ldLadies.find((lady) => lady.id === selectedLdLadyForCategory),
    [ldLadies, selectedLdLadyForCategory]
  );

  const posSettings = getPosSettings();
  const taxRateDecimal = posSettings.taxRate / 100;
  const cardSurchargeDecimal = posSettings.cardSurcharge / 100;
  const serviceLabel =
    posSettings.serviceChargeMode === "fixed"
      ? `Service (Fixed ₱${posSettings.serviceChargeValue.toFixed(2)})`
      : `Service (${posSettings.serviceChargeValue.toFixed(2).replace(/\.00$/, "")}%)`;
  const taxLabel = `VAT (${posSettings.taxRate.toFixed(2).replace(/\.00$/, "")}%)`;

  const computeServiceCharge = useCallback(
    (baseAmount: number) =>
      posSettings.serviceChargeMode === "fixed"
        ? posSettings.serviceChargeValue
        : baseAmount * (posSettings.serviceChargeValue / 100),
    [posSettings.serviceChargeMode, posSettings.serviceChargeValue]
  );

  const estimateTabTotal = useCallback(
    (items: OrderItem[]) => {
      const tabSubtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
      const tabComplimentary = items
        .filter((item) => item.isComplimentary)
        .reduce((sum, item) => sum + item.subtotal, 0);
      const tabChargeable = tabSubtotal - tabComplimentary;
      const tabTax = tabChargeable * taxRateDecimal;
      const tabService = computeServiceCharge(tabChargeable);
      return tabChargeable + tabTax + tabService;
    },
    [computeServiceCharge, taxRateDecimal]
  );

  const printDeptReceipt = useCallback(
    async (deptTitle: string, subtitle: string, items: OrderItem[], orderNumber: string) => {
      if (!table || items.length === 0) return;
      const now = new Date();
      const encoderName = user?.name || "Staff";
      const dateStr = now.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" });
      const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

      // Map deptTitle ("BAR" / "KITCHEN" / "LD") to print job type (bar_chit / kitchen_chit / ld_chit)
      const deptKey = deptTitle === "BAR" ? "Bar" : deptTitle === "KITCHEN" ? "Kitchen" : "LD";
      const jobType = deptToPrintJobType(deptKey);
      const printerName = jobType ? getPrinterForJob(jobType) : null;
      if (!printerName?.trim()) {
        // None = disabled — skip silently for auto dept chits
        return;
      }
      const payload = {
        dept: deptKey,
        title: deptTitle,
        subtitle,
        items: items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          servedByName: i.servedByName,
          specialRequest: i.specialRequest,
          isComplimentary: i.isComplimentary,
        })),
        table: table.name,
        area: table.area,
        encoder: encoderName,
        orderNumber,
        date: dateStr,
        time: timeStr,
      };
      try {
        if (isQzTrayEnabled()) {
          const { base64 } = await api.print.qzPayload.deptReceipt(payload);
          await qzPrintRawBase64(printerName, base64);
        } else {
          const result = await api.print.deptReceipt({ ...payload, printerName });
          if (!result.ok) {
            toast.warning(`${deptTitle} chit not printed: ${result.error || "Printer error"}.`);
          }
        }
      } catch (e) {
        toast.warning(
          `${deptTitle} chit not printed: ${e instanceof Error ? e.message : "Check QZ Tray is running and printer name matches Settings."}`
        );
      }
    },
    [table, user?.name]
  );

  const buildOrderSlipPayload = useCallback(
    (items: OrderItem[], orderId: string, opts?: { isReprint?: boolean }) => {
      const now = new Date();
      return {
        orderId,
        table: table?.name || "",
        area: table?.area || "",
        waiter: user?.name || "Staff",
        date: now.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
        time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        subtotal: items.reduce((s, i) => s + i.subtotal, 0),
        isReprint: opts?.isReprint === true,
        items: items.map((i) => ({
          name: i.name,
          quantity: i.quantity,
          subtotal: i.subtotal,
          servedByName: i.servedByName,
          specialRequest: i.specialRequest,
          isComplimentary: i.isComplimentary,
        })),
      };
    },
    [table, user?.name]
  );

  const printOrderSlipPreview = useCallback(
    async (items: OrderItem[], orderId: string, opts?: { isReprint?: boolean }) => {
      if (!table || items.length === 0) return false;
      const slipBody = buildOrderSlipPayload(items, orderId, opts);
      let html = "";
      try {
        html = await api.print.orderSlipHtml(slipBody as Record<string, unknown>);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to load order slip preview");
        return false;
      }

      const printWindow = window.open("", "_blank", "width=400,height=1000,scrollbars=yes");
      if (!printWindow) {
        toast.error("Print preview was blocked. Allow popups for this site and try again.");
        return false;
      }

      printWindow.document.write(html);
      printWindow.document.close();
      const triggerPrint = () => {
        printWindow.onafterprint = () => {
          try {
            printWindow.close();
          } catch {
            /* no-op */
          }
        };
        printWindow.print();
      };
      if (printWindow.document.readyState === "complete") {
        printWindow.focus();
        setTimeout(triggerPrint, 120);
      } else {
        printWindow.onload = () => {
          printWindow.focus();
          setTimeout(triggerPrint, 120);
        };
      }
      return true;
    },
    [table, buildOrderSlipPayload]
  );

  // Must be called unconditionally (before any early return) to satisfy Rules of Hooks
  const printCashierOrderSlip = useCallback(
    async (items: OrderItem[], orderId: string, opts?: { silent?: boolean; isReprint?: boolean }) => {
      if (!table || items.length === 0) return false;
      const slipBody = buildOrderSlipPayload(items, orderId, { isReprint: opts?.isReprint === true });
      const printerName = getPrinterForJob("order_slip") || undefined;
      if (!printerName?.trim()) {
        if (!opts?.silent) {
          toast.error(`${PRINT_JOB_LABELS.order_slip} printer not set. Configure in Settings.`);
        }
        return false;
      }
      try {
        if (isQzTrayEnabled()) {
          const { base64 } = await api.print.qzPayload.orderSlip(slipBody);
          await qzPrintRawBase64(printerName, base64);
        } else {
          const result = await api.print.orderSlip({ ...slipBody, printerName });
          if (!result.ok) {
            if (!opts?.silent) {
              toast.error(`Order slip not printed: ${result.error || "Printer error"}.`);
            }
            return false;
          }
        }
        return true;
      } catch (e) {
        if (!opts?.silent) {
          toast.error(
            `Order slip not printed: ${e instanceof Error ? e.message : "Check QZ Tray is running and printer name matches Settings."}`
          );
        }
        return false;
      }
    },
    [table, buildOrderSlipPayload]
  );

  const handleReprintOrderSlip = useCallback(async () => {
    const tab = orderTabs[activeTabIndex];
    if (!tab?.sent || !tab.id) {
      toast.error("Select a sent order tab to reprint its order slip");
      return;
    }
    const printableItems = tab.items.filter((item) => !item.isVoided);
    if (printableItems.length === 0) {
      toast.error("No items on this order to print");
      return;
    }
    const orderNumber = formatOrderDisplayNumber(tab.orderNumber, tab.id);
    const tabLabel = formatOrderTabLabel(tab.orderNumber, tab.id);

    // Print once: thermal when configured, otherwise browser preview. Never both (double print).
    const printerName = getPrinterForJob("order_slip");
    if (printerName?.trim()) {
      const printed = await printCashierOrderSlip(printableItems, orderNumber, {
        silent: true,
        isReprint: true,
      });
      if (printed) {
        toast.success(`Order slip reprinted (${tabLabel})`);
        return;
      }
      toast.warning(`Thermal reprint failed (${tabLabel}). Opening browser preview…`);
    }

    const previewOpened = await printOrderSlipPreview(printableItems, orderNumber, { isReprint: true });
    if (previewOpened) {
      toast.info(`Order slip preview opened (${tabLabel}). Select your printer in the dialog.`);
    }
  }, [orderTabs, activeTabIndex, printOrderSlipPreview, printCashierOrderSlip]);

  const orderTabRows = useMemo(() => {
    const rows: Array<Array<{ tab: OrderTab; idx: number }>> = [];
    orderTabs.forEach((tab, idx) => {
      const rowIndex = Math.floor(idx / 10);
      if (!rows[rowIndex]) rows[rowIndex] = [];
      rows[rowIndex].push({ tab, idx });
    });
    return rows;
  }, [orderTabs]);

  const sendPreviewNow = useMemo(() => new Date(), [sendToDeptOpen]);

  const printReceiptViaBrowser = useCallback(
    (receipt: {
      orderNumber: string;
      date: string;
      time: string;
      table: string;
      cashier: string;
      businessName?: string;
      businessAddress?: string;
      businessContact?: string;
      receiptFooter?: string;
      vatTin?: string;
      serviceLabel?: string;
      taxLabel?: string;
      items: Array<{ name: string; quantity: number; subtotal: number; isComplimentary?: boolean; note?: string }>;
      subtotal: number;
      complimentary?: number;
      discount?: number;
      serviceCharge: number;
      tax: number;
      cardSurcharge?: number;
      total: number;
      paymentMethod: string;
      amountPaid: number;
      change: number;
      isReprint?: boolean;
      originalPaymentMethod?: string | null;
    }) => {
      const printWindow = window.open("", "_blank", "width=400,height=1000,scrollbars=yes");
      if (!printWindow) {
        toast.error("Receipt print window was blocked. Allow popups for this site and try again, or use the browser Print menu.");
        return;
      }

      const businessName = receipt.businessName?.trim() || "";
      const businessAddress = receipt.businessAddress?.trim() || "";
      const businessContact = receipt.businessContact?.trim() || "";
      const receiptFooterText = receipt.receiptFooter?.trim() || "";
      const vatTinText = receipt.vatTin?.trim() || "";
      const isReprint =
        receipt.isReprint === true ||
        receipt.paymentMethod === "Reprint" ||
        receipt.paymentMethod === "REPRINT";
      const paymentDisplay = (() => {
        if (!isReprint) return String(receipt.paymentMethod || "—").toUpperCase();
        const original = receipt.originalPaymentMethod || receipt.paymentMethod;
        if (!original || /^reprint$/i.test(String(original))) return "—";
        return String(original).toUpperCase();
      })();
      const receiptChange = Math.max(
        0,
        Number(
          receipt.change != null
            ? receipt.change
            : Number(receipt.amountPaid || 0) - Number(receipt.total || 0)
        )
      );
      const showChange = /^CASH$/i.test(paymentDisplay) || /^GCASH$/i.test(paymentDisplay) || receiptChange > 0;

      const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Receipt</title>
        <style>
          @page { size: 80mm auto; margin: 3mm 2mm 8mm 2mm; }
          @media print {
            html, body { height: auto !important; overflow: visible !important; }
            .no-break { page-break-inside: avoid; }
          }
          * { box-sizing: border-box; }
          body {
            font-family: 'Courier New', monospace;
            font-size: 12px;
            line-height: 1.4;
            width: 72mm;
            margin: 0 auto;
            padding: 6px 4px 0 4px;
            color: #000;
            background: #fff;
          }
          .center { text-align: center; }
          .bold { font-weight: bold; }
          .line { border: none; border-top: 1px dashed #000; margin: 6px 0; }
          .row {
            display: table;
            width: 100%;
            margin: 1.5px 0;
          }
          .row .lbl {
            display: table-cell;
            width: 60%;
            word-break: break-word;
          }
          .row .val {
            display: table-cell;
            width: 40%;
            text-align: right;
            white-space: nowrap;
            padding-left: 4px;
          }
          .row.total-row { font-weight: bold; font-size: 13px; }
          .item-note { margin-left: 1.5em; font-size: 10px; color: #444; margin-bottom: 1px; }
          h1 { margin: 0 0 2px 0; font-size: 15px; font-weight: bold; }
          .biz-sub { font-size: 10px; margin: 1px 0; }
          .reprint-banner {
            text-align: center;
            font-weight: bold;
            font-size: 10px;
            letter-spacing: 0.12em;
            border: 1px solid #000;
            padding: 2px 4px;
            margin: 4px 0;
          }
          .footer-note { font-size: 10px; margin: 2px 0; }
          .bottom-pad { height: 10mm; }
        </style>
      </head>
      <body>
        <div class="center no-break">
          ${businessName ? `<h1>${businessName}</h1>` : ""}
          ${businessAddress ? `<div class="biz-sub">${businessAddress}</div>` : ""}
          ${businessContact ? `<div class="biz-sub">${businessContact}</div>` : ""}
        </div>
        ${isReprint ? `<div class="reprint-banner">** REPRINT COPY **</div>` : ""}
        <div class="line"></div>
        <div class="row"><span class="lbl">Order #:</span><span class="val">${receipt.orderNumber}</span></div>
        <div class="row"><span class="lbl">Date:</span><span class="val">${receipt.date}</span></div>
        <div class="row"><span class="lbl">Time:</span><span class="val">${receipt.time}</span></div>
        <div class="row"><span class="lbl">Table:</span><span class="val">${receipt.table}</span></div>
        <div class="row"><span class="lbl">Cashier:</span><span class="val">${receipt.cashier}</span></div>
        <div class="line"></div>
        <div class="bold" style="margin-bottom:3px;">ITEMS</div>
        ${receipt.items.map(item => `
          <div class="row">
            <span class="lbl">${item.quantity}x ${item.name}</span>
            <span class="val">${item.subtotal === 0 ? "0.00" : "₱" + item.subtotal.toFixed(2)}</span>
          </div>
          ${item.note ? `<div class="item-note">Note: ${item.note}</div>` : ""}
        `).join("")}
        <div class="line"></div>
        <div class="row"><span class="lbl">Subtotal:</span><span class="val">₱${receipt.subtotal.toFixed(2)}</span></div>
        ${receipt.complimentary ? `<div class="row"><span class="lbl">Less Compli:</span><span class="val">-₱${receipt.complimentary.toFixed(2)}</span></div>` : ""}
        ${receipt.discount ? `<div class="row"><span class="lbl">Discount:</span><span class="val">-₱${receipt.discount.toFixed(2)}</span></div>` : ""}
        <div class="row"><span class="lbl">${receipt.serviceLabel || serviceLabel}:</span><span class="val">₱${receipt.serviceCharge.toFixed(2)}</span></div>
        <div class="row"><span class="lbl">${receipt.taxLabel || taxLabel}:</span><span class="val">₱${receipt.tax.toFixed(2)}</span></div>
        ${receipt.cardSurcharge ? `<div class="row"><span class="lbl">Card Fee (${posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}%):</span><span class="val">₱${receipt.cardSurcharge.toFixed(2)}</span></div>` : ""}
        <div class="line"></div>
        <div class="row total-row"><span class="lbl">TOTAL:</span><span class="val">₱${receipt.total.toFixed(2)}</span></div>
        <div class="line"></div>
        <div class="row"><span class="lbl">Payment:</span><span class="val">${paymentDisplay}</span></div>
        <div class="row"><span class="lbl">Amount Paid:</span><span class="val">₱${receipt.amountPaid.toFixed(2)}</span></div>
        ${showChange ? `<div class="row"><span class="lbl">Change:</span><span class="val">₱${receiptChange.toFixed(2)}</span></div>` : ""}
        <div class="line"></div>
        <div class="center">
          ${receiptFooterText ? `<div class="bold footer-note">${receiptFooterText}</div>` : ""}
          <div class="footer-note">Please come again</div>
          <br>
          <div class="footer-note bold">This serves as your OFFICIAL RECEIPT</div>
          ${vatTinText ? `<div class="footer-note">VAT Reg TIN: ${vatTinText}</div>` : ""}
          ${isReprint ? `<div class="footer-note" style="margin-top:4px;">** REPRINT — NOT A DUPLICATE CHARGE **</div>` : ""}
        </div>
        <div class="bottom-pad"></div>
      </body>
      </html>
    `;

      printWindow.document.write(html);
      printWindow.document.close();
      const triggerPrint = () => {
        printWindow.print();
        printWindow.close();
      };
      if (printWindow.document.readyState === "complete") {
        printWindow.focus();
        setTimeout(triggerPrint, 100);
      } else {
        printWindow.onload = () => { printWindow.focus(); setTimeout(triggerPrint, 100); };
      }
    },
    [serviceLabel, taxLabel, posSettings.cardSurcharge]
  );

  const printOfficialReprintReceipt = useCallback(
    async (receipt: Record<string, unknown>, fallbackOrderId?: string) => {
      const receiptData = {
        orderNumber: String(receipt.orderNumber ?? fallbackOrderId ?? ""),
        date: String(receipt.date ?? ""),
        time: String(receipt.time ?? ""),
        table: String(receipt.table ?? ""),
        cashier: String(receipt.cashier ?? ""),
        businessName: receipt.businessName as string | undefined,
        businessAddress: receipt.businessAddress as string | undefined,
        businessContact: receipt.businessContact as string | undefined,
        receiptFooter: receipt.receiptFooter as string | undefined,
        vatTin: receipt.vatTin as string | undefined,
        serviceLabel: receipt.serviceLabel as string | undefined,
        taxLabel: receipt.taxLabel as string | undefined,
        items: (receipt.items as Array<{ name: string; quantity: number; subtotal: number }>) || [],
        subtotal: Number(receipt.subtotal ?? 0),
        complimentary: receipt.complimentary != null ? Number(receipt.complimentary) : undefined,
        discount: receipt.discount != null ? Number(receipt.discount) : undefined,
        serviceCharge: Number(receipt.serviceCharge ?? 0),
        tax: Number(receipt.tax ?? 0),
        cardSurcharge: receipt.cardSurcharge != null ? Number(receipt.cardSurcharge) : undefined,
        total: Number(receipt.total ?? 0),
        paymentMethod: String(receipt.paymentMethod ?? "cash"),
        originalPaymentMethod:
          (receipt.originalPaymentMethod as string | null | undefined) ?? String(receipt.paymentMethod ?? ""),
        amountPaid: Number(receipt.amountPaid ?? receipt.total ?? 0),
        change: Number(receipt.change ?? 0),
        isReprint: true,
      };
      const printerName = getPrinterForJob("payment_receipt") || undefined;
      if (!printerName?.trim()) {
        printReceiptViaBrowser(receiptData);
        return false;
      }
      try {
        if (isQzTrayEnabled()) {
          const { base64 } = await api.print.qzPayload.receipt(receiptData as Record<string, unknown>);
          await qzPrintRawBase64(printerName, base64);
          return true;
        }
        const result = await api.print.receipt(receiptData, printerName);
        if (result.ok) return true;
      } catch {
        // fall through to browser
      }
      printReceiptViaBrowser(receiptData);
      return false;
    },
    [printReceiptViaBrowser]
  );

  const handleReprintFinalBill = useCallback(
    async (orderIds?: string[]) => {
      const ids = (orderIds?.length ? orderIds : lastPaidOrderIds).filter(Boolean);
      if (!ids.length) {
        toast.error("Complete payment first to reprint the final bill");
        return;
      }
      if (!canReprintFinalBill) {
        toast.error("Only Cashier or Manager can reprint the final bill");
        return;
      }
      try {
        if (ids.length === 1) {
          const { receipt } = await api.orders.reprintFinalBill(ids[0], "pos");
          const printed = await printOfficialReprintReceipt(receipt, ids[0]);
          toast.success(printed ? "Final bill reprint sent to printer" : "Final bill reprint opened in browser");
          return;
        }
        const { receipts } = await api.orders.reprintFinalBills(ids, "pos");
        const mergedOrderNumbers = receipts.map((entry) => String(entry.receipt?.orderNumber ?? entry.orderId)).filter(Boolean);
        const mergedItems = receipts.flatMap((entry) =>
          Array.isArray(entry.receipt?.items)
            ? (entry.receipt.items as Array<{ name: string; quantity: number; subtotal: number; note?: string; isComplimentary?: boolean }>)
            : []
        );
        const mergedSubtotal = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.subtotal ?? 0), 0);
        const mergedComplimentary = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.complimentary ?? 0), 0);
        const mergedDiscount = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.discount ?? 0), 0);
        const mergedServiceCharge = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.serviceCharge ?? 0), 0);
        const mergedTax = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.tax ?? 0), 0);
        const mergedCardFee = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.cardSurcharge ?? 0), 0);
        const mergedTotal = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.total ?? 0), 0);
        const mergedChange = receipts.reduce((sum, entry) => sum + Number(entry.receipt?.change ?? 0), 0);
        const mergedAmountPaid = mergedTotal + mergedChange;
        const mergedPaymentMethods = Array.from(
          new Set(receipts.map((entry) => String(entry.receipt?.originalPaymentMethod ?? entry.receipt?.paymentMethod ?? "")).filter(Boolean))
        );
        const baseReceipt = receipts[0]?.receipt ?? {};
        const mergedReceipt = {
          ...baseReceipt,
          orderNumber: formatOrderListLabel(mergedOrderNumbers),
          items: mergedItems,
          subtotal: mergedSubtotal,
          complimentary: mergedComplimentary > 0 ? mergedComplimentary : undefined,
          discount: mergedDiscount > 0 ? mergedDiscount : undefined,
          serviceCharge: mergedServiceCharge,
          tax: mergedTax,
          cardSurcharge: mergedCardFee > 0 ? mergedCardFee : undefined,
          total: mergedTotal,
          amountPaid: mergedAmountPaid,
          change: mergedChange,
          paymentMethod: mergedPaymentMethods.length === 1 ? mergedPaymentMethods[0] : "Mixed",
          originalPaymentMethod: mergedPaymentMethods.length === 1 ? mergedPaymentMethods[0] : "Mixed",
        };
        const anyPrinted = await printOfficialReprintReceipt(mergedReceipt as Record<string, unknown>, ids[0]);
        toast.success(
          anyPrinted
            ? "Final bill reprint sent to printer"
            : "Final bill reprint opened in browser"
        );
      } catch (e) {
        const err = e as Error & { data?: { code?: string } };
        if (err.data?.code === "ORDER_UNPAID") {
          toast.error("Complete payment first to reprint the final bill");
          return;
        }
        toast.error(err.message || "No final bill on file for this transaction");
      }
    },
    [lastPaidOrderIds, canReprintFinalBill, printOfficialReprintReceipt]
  );

  if (tablesLoading) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AppLayout>
    );
  }

  if (sessionError) {
    return (
      <AppLayout>
        <div className="text-center py-12 space-y-3">
          <p className="text-muted-foreground">{sessionError}</p>
          <Link to="/pos" className="text-primary hover:underline inline-block">
            Back to Tables
          </Link>
        </div>
      </AppLayout>
    );
  }

  if (!table) {
    return (
      <AppLayout>
        <div className="text-center py-12">
          <p className="text-muted-foreground">Table not found</p>
          <Link to="/pos" className="text-primary hover:underline mt-2 inline-block">
            Back to Tables
          </Link>
        </div>
      </AppLayout>
    );
  }

  const activeTab = orderTabs[activeTabIndex];
  const displayOrderNumber = formatOrderDisplayNumber(activeTab?.orderNumber, activeTab?.id);
  const orderItems = activeTab?.items ?? [];
  const orderSent = activeTab?.sent ?? false;
  const hasAnySentOrder = orderTabs.some((t) => t.sent);
  const canAddItems = canAddToOrder && activeTab && !activeTab.sent;
  const requiresLdLadySelection = selectedCategory === "Ladies Drink" && !selectedLdLadyForCategory;

  const updateActiveTabItems = (updater: (items: OrderItem[]) => OrderItem[]) => {
    setOrderTabs((prev) =>
      prev.map((tab, i) =>
        i === activeTabIndex ? { ...tab, items: updater(tab.items) } : tab
      )
    );
  };

  const isLdProduct = (p: Product) => p.department === "LD";

  const addToOrder = (product: Product) => {
    if (!canAddItems) return;
    const variants = product.priceVariants || [];
    const needsPricePick = variants.length > 1;
    if (isLdProduct(product)) {
      if (selectedCategory === "Ladies Drink" && selectedLdLadyForCategory) {
        if (needsPricePick) {
          setPricePickProduct(product);
          setPricePickContext({
            servedBy: selectedLdLadyForCategory,
            servedByName: selectedLdLadyProfile?.name,
          });
          return;
        }
        doAddToOrder(product, selectedLdLadyForCategory, selectedLdLadyProfile?.name);
        return;
      }
      setPendingLdProduct(product);
      setLadyModalOpen(true);
      setSelectedLady(selectedLdLadyForCategory || "");
      return;
    }
    if (needsPricePick) {
      setPricePickProduct(product);
      setPricePickContext({});
      return;
    }
    doAddToOrder(product, undefined, undefined);
  };

  const doAddToOrder = (
    product: Product,
    servedBy?: string,
    servedByName?: string,
    specialRequest?: string,
    priceOverride?: { priceId?: string | null; unitPrice: number }
  ) => {
    if (!canAddItems) return;
    const unitPrice = priceOverride?.unitPrice ?? product.price;
    const productPriceId = priceOverride?.priceId ?? product.priceId ?? null;
    updateActiveTabItems((prev) => {
      const existing = prev.find(
        (item) =>
          item.productId === product.id &&
          (item.servedBy ?? "") === (servedBy ?? "") &&
          (item.specialRequest ?? "") === (specialRequest ?? "") &&
          (item.productPriceId ?? "") === (productPriceId ?? "")
      );
      if (existing) {
        return prev.map((item) =>
          item.productId === product.id &&
          (item.servedBy ?? "") === (servedBy ?? "") &&
          (item.specialRequest ?? "") === (specialRequest ?? "") &&
          (item.productPriceId ?? "") === (productPriceId ?? "")
            ? { ...item, quantity: item.quantity + 1, subtotal: (item.quantity + 1) * item.unitPrice - item.discount }
            : item
        );
      }
      return [
        ...prev,
        {
          productId: product.id,
          productPriceId,
          name: product.name,
          quantity: 1,
          unitPrice,
          discount: 0,
          subtotal: unitPrice,
          department: product.department as OrderItem["department"],
          servedBy,
          servedByName,
          specialRequest: specialRequest || undefined,
        },
      ];
    });
  };

  const addNewOrderTab = () => {
    setOrderTabs((prev) => [...prev, { id: null, items: [], sent: false }]);
    setActiveTabIndex(orderTabs.length);
  };

  const removeFromOrder = (productId: string, servedBy?: string) => {
    updateActiveTabItems((prev) =>
      prev.filter((item) => !(item.productId === productId && (item.servedBy ?? "") === (servedBy ?? "")))
    );
  };

  const toggleComplimentary = (productId: string, servedBy?: string) => {
    updateActiveTabItems((prev) =>
      prev.map((item) =>
        item.productId === productId && (item.servedBy ?? "") === (servedBy ?? "")
          ? { ...item, isComplimentary: !item.isComplimentary }
          : item
      )
    );
  };

  const updateQuantity = (productId: string, delta: number, servedBy?: string) => {
    updateActiveTabItems((prev) =>
      prev
        .map((item) => {
          if (item.productId === productId && (item.servedBy ?? "") === (servedBy ?? "")) {
            const newQty = item.quantity + delta;
            if (newQty <= 0) return null;
            return {
              ...item,
              quantity: newQty,
              subtotal: newQty * item.unitPrice - item.discount,
            };
          }
          return item;
        })
        .filter(Boolean) as OrderItem[]
    );
  };

  const setItemDiscount = (productId: string, servedBy?: string) => {
    if (!canAddItems) return;
    const target = orderItems.find(
      (item) => item.productId === productId && (item.servedBy ?? "") === (servedBy ?? "")
    );
    if (!target) return;
    const maxDiscount = target.unitPrice * target.quantity;
    const input = window.prompt(
      `Enter item discount amount (max ${formatCurrency(maxDiscount)}):`,
      String(target.discount || 0)
    );
    if (input === null) return;
    const nextDiscount = Number(input);
    if (!Number.isFinite(nextDiscount) || nextDiscount < 0) {
      toast.error("Invalid discount amount");
      return;
    }
    if (nextDiscount > maxDiscount) {
      toast.error("Discount cannot exceed item total");
      return;
    }
    updateActiveTabItems((prev) =>
      prev.map((item) =>
        item.productId === productId && (item.servedBy ?? "") === (servedBy ?? "")
          ? {
              ...item,
              discount: nextDiscount,
              subtotal: item.quantity * item.unitPrice - nextDiscount,
            }
          : item
      )
    );
  };

  const updateItemComment = (productId: string, servedBy: string | undefined, comment: string) => {
    updateActiveTabItems((prev) =>
      prev.map((item) =>
        item.productId === productId && (item.servedBy ?? "") === (servedBy ?? "")
          ? { ...item, specialRequest: comment.trim() || undefined }
          : item
      )
    );
  };

  // Current tab totals (for display)
  const subtotal = orderItems.filter((i) => !i.isVoided).reduce((sum, item) => sum + item.subtotal, 0);
  const complimentaryTotal = orderItems
    .filter((i) => !i.isVoided)
    .filter((item) => item.isComplimentary)
    .reduce((sum, item) => sum + item.subtotal, 0);
  const chargeableSubtotal = subtotal - complimentaryTotal;
  const tax = chargeableSubtotal * taxRateDecimal;
  const serviceCharge = computeServiceCharge(chargeableSubtotal);
  const total = chargeableSubtotal + tax + serviceCharge;

  // Combined totals from ALL sent tabs (for payment)
  const sentTabs = orderTabs.filter((t) => t.sent);
  const combinedItems = sentTabs.flatMap((t) => t.items);
  /** Non-voided items only — use this for payment screen so voided are not visible */
  const paymentDisplayItems = combinedItems.filter((i) => !i.isVoided);
  const combinedSubtotal = paymentDisplayItems.reduce((s, i) => s + i.subtotal, 0);
  const combinedComplimentary = paymentDisplayItems.filter((i) => i.isComplimentary).reduce((s, i) => s + i.subtotal, 0);
  const combinedChargeable = combinedSubtotal - combinedComplimentary;
  const combinedTax = combinedChargeable * taxRateDecimal;
  const combinedServiceCharge = computeServiceCharge(combinedChargeable);
  const combinedTotalBeforeDiscount = combinedChargeable + combinedTax + combinedServiceCharge;

  // Group items by department for Send to Dept modal
  const barItems = orderItems.filter((item) => item.department === "Bar");
  const kitchenItems = orderItems.filter((item) => item.department === "Kitchen");
  const ldItems = orderItems.filter((item) => item.department === "LD");

  const handleConfirmSend = async () => {
    setSending(true);
    try {
      if (!tableId) return;
      // Capture items before state updates for printing
      const itemsToSend = [...orderItems];
      const barItemsSnap = itemsToSend.filter((i) => i.department === "Bar");
      const kitchenItemsSnap = itemsToSend.filter((i) => i.department === "Kitchen");
      const ldItemsSnap = itemsToSend.filter((i) => i.department === "LD");

      const result = await api.orders.create({
        tableId,
        employeeId: user?.employeeId,
        items: itemsToSend,
        subtotal,
        tax,
        total,
      });
      setTable((prev) => prev ? { ...prev, status: "occupied", currentOrderId: result.orderId } : prev);
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (barItemsSnap.length > 0) toast.success(`${barItemsSnap.length} item(s) sent to Bar`);
      if (kitchenItemsSnap.length > 0) toast.success(`${kitchenItemsSnap.length} item(s) sent to Kitchen`);
      if (ldItemsSnap.length > 0) toast.success(`${ldItemsSnap.length} item(s) sent to LD`);
      // Convert tab to sent, add new draft tab
      const createdOrderNumber = result.orderNumber || result.orderId;
      setOrderTabs((prev) => {
        const next = [...prev];
        next[activeTabIndex] = { id: result.orderId, orderNumber: createdOrderNumber, items: itemsToSend, sent: true };
        next.push({ id: null, items: [], sent: false });
        return next;
      });
      setActiveTabIndex(activeTabIndex + 1);

      // Auto-print dept receipts and cashier order slip
      let printDelay = 0;
      if (barItemsSnap.length > 0) {
        setTimeout(() => printDeptReceipt("BAR", "Drinks & Beverages", barItemsSnap, createdOrderNumber), printDelay);
        printDelay += 500;
      }
      if (kitchenItemsSnap.length > 0) {
        setTimeout(() => printDeptReceipt("KITCHEN", "Food Orders", kitchenItemsSnap, createdOrderNumber), printDelay);
        printDelay += 500;
      }
      if (ldItemsSnap.length > 0) {
        setTimeout(() => printDeptReceipt("LD", "LD Orders", ldItemsSnap, createdOrderNumber), printDelay);
        printDelay += 500;
      }
      // Cashier order slip (for customer to verify & sign)
      setTimeout(() => void printCashierOrderSlip(itemsToSend, createdOrderNumber, { silent: true }), printDelay);
      printDelay += 500;

      // Auto-logout waiter after send (role from API is lowercase with underscore, e.g. staff, operations_staff)
      const role = String(user?.role || "").toLowerCase();
      const isWaiter = role === "staff" || role === "operations_staff";
      if (isWaiter) {
        setTimeout(() => {
          logout();
          navigate("/login", { replace: true, state: null });
        }, printDelay);
      }
    } catch {
      toast.error("Failed to send order to departments");
    } finally {
      setSending(false);
      setSendToDeptOpen(false);
    }
  };

  // Discount & payment totals (on combined sent tabs)
  const discountAmount = appliedDiscount
    ? appliedDiscount.value.includes("%")
      ? combinedChargeable * (parseFloat(appliedDiscount.value) / 100)
      : parseFloat(appliedDiscount.value) || 0
    : 0;
  const discountedSubtotal = combinedChargeable - discountAmount;
  const discountedTax = discountedSubtotal * taxRateDecimal;
  const discountedServiceCharge = computeServiceCharge(discountedSubtotal);
  const discountedTotal = discountedSubtotal + discountedTax + discountedServiceCharge;
  // Card surcharge: must match server pay-all (rate × pre-surcharge total = chargeable + tax + service).
  // Split supports both input styles: (a) card entered as base, or (b) collected amount incl. surcharge.
  const hasCardSurcharge = !useSplitPayment && isCardPaymentMethod(selectedPaymentMethod);
  const cardSurcharge = hasCardSurcharge
    ? Math.round((discountedTotal * cardSurchargeDecimal + Number.EPSILON) * 100) / 100
    : 0;
  const splitCardSurchargeRaw = useSplitPayment
    ? splitPayments.reduce((sum, sp) => {
        if (isCardPaymentMethod(sp.method)) {
          return sum + (Number(sp.amount) || 0) * cardSurchargeDecimal;
        }
        return sum;
      }, 0)
    : 0;
  const splitBaseTotalAdjusted = useSplitPayment
    ? splitPayments.reduce((sum, sp) => {
        const amt = Number(sp.amount) || 0;
        if (isCardPaymentMethod(sp.method)) {
          return sum + (amt / (1 + cardSurchargeDecimal));
        }
        return sum + amt;
      }, 0)
    : 0;
  const splitCardSurchargeAdjusted = useSplitPayment
    ? splitPayments.reduce((sum, sp) => {
        const amt = Number(sp.amount) || 0;
        if (isCardPaymentMethod(sp.method)) {
          return sum + (amt - amt / (1 + cardSurchargeDecimal));
        }
        return sum;
      }, 0)
    : 0;
  const splitTotal = splitPayments.reduce((sum, split) => sum + (Number(split.amount) || 0), 0);
  const splitBaseTotalRaw = splitTotal;
  const useAdjustedSplitMath =
    useSplitPayment &&
    Math.abs(discountedTotal - splitBaseTotalAdjusted) < Math.abs(discountedTotal - splitBaseTotalRaw);
  const splitCardSurcharge = useSplitPayment
    ? (useAdjustedSplitMath ? splitCardSurchargeAdjusted : splitCardSurchargeRaw)
    : 0;
  const localFinalTotal = Math.round(
    ((discountedTotal + (useSplitPayment ? splitCardSurcharge : cardSurcharge)) + Number.EPSILON) * 100
  ) / 100;
  // Prefer the server total (identical math to pay-all) for the non-split manual/exact-amount path.
  const finalTotal = !useSplitPayment && serverBill != null ? serverBill.total : localFinalTotal;
  const showAmountEntry = !useSplitPayment && MANUAL_AMOUNT_METHODS.includes(selectedPaymentMethod);
  const amountEntryLabel =
    selectedPaymentMethod === "cash"
      ? "Amount Tendered"
      : selectedPaymentMethod === "gcash"
        ? "GCash Amount Received"
      : isCardPaymentMethod(selectedPaymentMethod)
        ? "Amount Charged"
        : "Amount Received";
  const amountReceivedNum = amountTendered ? parseFloat(amountTendered) : NaN;
  const changeAmount =
    showAmountEntry &&
    Number.isFinite(amountReceivedNum) &&
    amountReceivedNum > finalTotal
      ? amountReceivedNum - finalTotal
      : 0;
  // For split: validate against discounted base total using whichever interpretation is closer:
  // raw (base input) vs adjusted (card input includes surcharge). Prefer server base total when available.
  const splitBaseTotal = useAdjustedSplitMath ? splitBaseTotalAdjusted : splitBaseTotalRaw;
  const splitTargetTotal = useSplitPayment && serverBill != null ? serverBill.baseTotal : discountedTotal;
  const splitRemaining = splitTargetTotal - splitBaseTotal;
  // When only one split is "charge", allow using main chargeCustomerName if split name empty
  const chargeSplitsCount = splitPayments.filter((sp) => sp.method === "charge").length;
  const splitValid =
    useSplitPayment &&
    splitPayments.length >= 2 &&
    splitPayments.every((sp, idx) => {
      const amountOk = Number(sp.amount) > 0;
      const chargeNameOk =
        sp.method !== "charge" ||
        (splitChargeNames[idx] || "").trim() ||
        (chargeSplitsCount === 1 && chargeCustomerName.trim());
      return amountOk && chargeNameOk;
    }) &&
    Math.abs(splitRemaining) < 0.01;

  /** Sent order items that can be voided (have id and are not already voided) */
  const voidableItems = combinedItems.filter((i): i is OrderItem & { id: string } => !!i.id && !i.isVoided);

  const openVoidModal = () => {
    if (!hasAnySentOrder) {
      toast.error("No sent orders to void");
      return;
    }
    setVoidReason("");
    setVoidEmployeeId("");
    setVoidPassword("");
    setVoidError(null);
    setVoidSelectedIds([]);
    setVoidModalOpen(true);
  };

  const handleRequestVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!voidEmployeeId.trim() || !voidPassword) {
      setVoidError("Manager Employee ID and password are required");
      return;
    }
    if (voidSelectedIds.length === 0) {
      setVoidError("Select at least one item to void");
      return;
    }
    if (voidReason.trim().length < 3) {
      setVoidError("Void reason is required (at least 3 characters)");
      return;
    }
    setVoiding(true);
    setVoidError(null);
    try {
      for (const itemId of voidSelectedIds) {
        await api.orderItems.void(itemId, {
          employeeId: voidEmployeeId.trim(),
          password: voidPassword,
          reason: voidReason.trim(),
        });
      }
      setVoidModalOpen(false);
      setVoidSelectedIds([]);
      setVoidReason("");
      await refetchOrders();
      toast.success(voidSelectedIds.length === 1 ? "Item voided." : `${voidSelectedIds.length} items voided. Receipt will show voided and manager name.`);
    } catch (e) {
      setVoidError(e instanceof Error ? e.message : "Failed to void");
    } finally {
      setVoiding(false);
    }
  };

  const openItemVoidModal = (item: OrderItem) => {
    if (!item.id) return;
    setPendingVoidItem(item);
    setItemVoidEmployeeId("");
    setItemVoidPassword("");
    setItemVoidReason("");
    setItemVoidError(null);
    setItemVoidModalOpen(true);
  };

  const handleItemVoid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingVoidItem?.id || !itemVoidEmployeeId.trim() || !itemVoidPassword) {
      setItemVoidError("Manager Employee ID and password are required");
      return;
    }
    if (itemVoidReason.trim().length < 3) {
      setItemVoidError("Void reason is required (at least 3 characters)");
      return;
    }
    setItemVoiding(true);
    setItemVoidError(null);
    try {
      await api.orderItems.void(pendingVoidItem.id, {
        employeeId: itemVoidEmployeeId.trim(),
        password: itemVoidPassword,
        reason: itemVoidReason.trim(),
      });
      setItemVoidModalOpen(false);
      setPendingVoidItem(null);
      setItemVoidReason("");
      await refetchOrders();
      toast.success("Item voided");
    } catch (e) {
      setItemVoidError(e instanceof Error ? e.message : "Failed to void item");
    } finally {
      setItemVoiding(false);
    }
  };

  const handleProcessPayment = async () => {
    if (!hasAnySentOrder) {
      toast.error("Send at least one order to departments first");
      return;
    }
    if (!tableId) return;
    try {
      const discounts = await api.discounts.list();
      setAvailableDiscounts(discounts.filter((d) => d.status === "approved"));
    } catch {
      // Discounts failed to load
    }
    // Do not reset applied discount / payment method / card surcharge — they persist
    // until payment completes or staff removes them. Bill Summary print is read-only.
    setAmountTendered("");
    setPaymentMethodModalOpen(true);
  };

  const handleConfirmPayment = async () => {
    // Close payment method modal and open processing modal
    setPaymentMethodModalOpen(false);
    setPaymentModalOpen(true);
    setPaymentStep("processing");
    setProcessingPayment(true);
    
    try {
      if (!tableId) throw new Error("No table");
      const now = new Date();
      let paidOrderIds: string[] = [];
      let paidOrderNumbers: string[] = [];
      let paidSummary: {
        subtotal: number;
        discount: number;
        tax: number;
        total: number;
        cardSurcharge?: number;
        orderNumbers?: string[];
        amountReceived?: number;
        change?: number;
      } | null = null;
      if (useSplitPayment) {
        if (!splitValid) {
          throw new Error("Split payment amounts must exactly match the total");
        }
        // Use payAll with splits for all orders (single or multiple)
        const payResult = await api.tables.payAll(
          tableId,
          "split_payment",
          appliedDiscount?.name,
          discountAmount > 0 ? discountAmount : undefined,
          undefined,
          splitPayments.map((sp, idx) => ({
            amount: Number(sp.amount) || 0,
            paymentMethod: normalizePaymentMethod(sp.method),
            customerName: sp.method === "charge" ? (splitChargeNames[idx] || (chargeSplitsCount === 1 ? chargeCustomerName : "")) : undefined,
          }))
        );
        paidOrderIds = payResult.orderIds || [];
        paidOrderNumbers = payResult.orderNumbers || payResult.orderIds || [];
        paidSummary = payResult;
      } else {
        const received = showAmountEntry ? parseFloat(amountTendered) || finalTotal : finalTotal;
        const payResult = await api.tables.payAll(
          tableId,
          selectedPaymentMethod,
          appliedDiscount?.name,
          discountAmount > 0 ? discountAmount : undefined,
          selectedPaymentMethod === "charge" ? chargeCustomerName : undefined,
          undefined,
          showAmountEntry ? { amountReceived: received } : undefined
        );
        paidOrderIds = payResult.orderIds || [];
        paidOrderNumbers = payResult.orderNumbers || payResult.orderIds || [];
        paidSummary = payResult;
      }
      setLastPaidOrderIds(paidOrderIds);
      setPaymentStep("printing");
      const settledSubtotal = paidSummary?.subtotal ?? combinedSubtotal;
      const settledDiscount = paidSummary?.discount ?? (discountAmount > 0 ? discountAmount : 0);
      const settledTax = paidSummary?.tax ?? discountedTax;
      const settledCardSurcharge = paidSummary?.cardSurcharge ?? ((hasCardSurcharge && cardSurcharge > 0) || (useSplitPayment && splitCardSurcharge > 0) ? (useSplitPayment ? splitCardSurcharge : cardSurcharge) : 0);
      const settledTotal = paidSummary?.total ?? finalTotal;
      const settledServiceCharge = Math.max(0, settledTotal - Math.max(0, settledSubtotal - settledDiscount) - settledTax - settledCardSurcharge);
      const manualAmountPaid = showAmountEntry;
      const settledAmountPaid = manualAmountPaid
        ? ((paidSummary?.amountReceived ?? parseFloat(amountTendered)) || settledTotal)
        : settledTotal;
      const settledChange = manualAmountPaid
        ? (paidSummary?.change ?? Math.max(0, settledAmountPaid - settledTotal))
        : 0;
      const receiptPaymentLabel = useSplitPayment
        ? `Split (${splitPayments.map((sp, idx) => `${sp.method === "charge" ? `Charge-${splitChargeNames[idx] || ""}` : formatPaymentMethodLabel(sp.method).toUpperCase()} ₱${sp.amount}`).join(" / ")})`
        : selectedPaymentMethod === "charge"
          ? `Charge - ${chargeCustomerName}`
          : formatPaymentMethodLabel(selectedPaymentMethod);
      const receiptData = {
        orderNumber: formatOrderListLabel(paidOrderNumbers.length ? paidOrderNumbers : paidOrderIds),
        date: now.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
        time: now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        table: `${table?.area} - ${table?.name}`,
        cashier: user?.name || "Staff",
        businessName: posSettings.businessName,
        businessAddress: posSettings.address,
        businessContact: posSettings.contact,
        receiptFooter: posSettings.receiptFooter,
        vatTin: posSettings.vatTin,
        serviceLabel,
        taxLabel,
        items: combinedItems.map((item) => {
          let name: string;
          if (item.isVoided) {
            name = `${item.name} (VOIDED${item.voidedByName ? ` by ${item.voidedByName}` : ""})`;
          } else {
            const ladySuffix = item.department === "LD" && item.servedByName ? ` [${item.servedByName}]` : "";
            const noteSuffix = item.specialRequest ? ` - ${item.specialRequest}` : "";
            name = `${item.name}${ladySuffix}${noteSuffix}`;
          }
          return { name, quantity: item.quantity, subtotal: item.isVoided ? 0 : item.subtotal, isComplimentary: item.isComplimentary, note: item.specialRequest || undefined };
        }),
        subtotal: settledSubtotal,
        complimentary: combinedComplimentary > 0 ? combinedComplimentary : undefined,
        discount: settledDiscount > 0 ? settledDiscount : undefined,
        serviceCharge: settledServiceCharge,
        tax: settledTax,
        cardSurcharge: settledCardSurcharge > 0 ? settledCardSurcharge : undefined,
        total: settledTotal,
        amountDue: settledTotal,
        paymentMethod: receiptPaymentLabel,
        amountPaid: settledAmountPaid,
        change: settledChange,
      };
      setLastReceiptForPrint(receiptData);

      let receiptSent = false;
      const printerName = getPrinterForJob("payment_receipt") || undefined;
      if (!printerName?.trim()) {
        // None = payment receipt printing disabled
      } else {
        try {
          if (isQzTrayEnabled()) {
            const { base64 } = await api.print.qzPayload.receipt(receiptData as Record<string, unknown>);
            await qzPrintRawBase64(printerName, base64);
            receiptSent = true;
          } else {
            const printResult = await api.print.receipt(receiptData, printerName);
            if (printResult.ok) receiptSent = true;
          }
        } catch (_printErr) {
          // print failed
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
      setLastReceiptSentToBackend(receiptSent);
      setPaymentStep("done");
      // Bill state clears when staff clicks Done (keeps correct payment method on receipt preview).
      toast.success(
        receiptSent
          ? "Payment complete. Receipt sent to printer."
          : printerName?.trim()
            ? "Payment complete. Receipt could not be sent to printer."
            : `Payment complete. ${PRINT_JOB_LABELS.payment_receipt} printing is disabled.`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to process payment");
      setPaymentModalOpen(false);
    } finally {
      setProcessingPayment(false);
    }
  };

  const printBillSummaryViaBrowser = async () => {
    if (!table || !hasAnySentOrder) {
      toast.error("No sent orders to print");
      return;
    }

    const nowLocal = new Date();

    const sentOrderIds = formatOrderListLabel(
      sentTabs.map((t) => formatOrderDisplayNumber(t.orderNumber, t.id))
    );
    const summaryBusinessName = posSettings.businessName?.trim() || "";
    const summaryAddress = posSettings.address?.trim() || "";

    const itemLines = paymentDisplayItems.map((item) => {
      const ladySuffix = item.department === "LD" && item.servedByName ? ` [${item.servedByName}]` : "";
      const compliSuffix = item.isComplimentary ? " (Compli)" : "";
      const noteSuffix = item.specialRequest ? ` - ${item.specialRequest}` : "";
      return `
        <div class="row">
          <span class="lbl">${item.quantity}x ${item.name}${ladySuffix}${compliSuffix}${noteSuffix}</span>
          <span class="val">${formatCurrency(item.subtotal)}</span>
        </div>
      `;
    }).join("");

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bill Summary</title>
        <style>
          @page { size: 80mm auto; margin: 3mm 2mm 8mm 2mm; }
          @media print {
            html, body { height: auto !important; overflow: visible !important; }
            .no-break { page-break-inside: avoid; }
          }
          * { box-sizing: border-box; }
          body {
            font-family: 'Courier New', monospace;
            font-size: 11px;
            line-height: 1.45;
            width: 76mm;
            margin: 0 auto;
            padding: 6px 4px 0 4px;
            color: #000;
            background: #fff;
          }
          .center { text-align: center; }
          .bold { font-weight: bold; }
          .line { border: none; border-top: 1px dashed #000; margin: 6px 0; }
          .row {
            display: table;
            width: 100%;
            margin: 1.5px 0;
          }
          .row .lbl {
            display: table-cell;
            width: 60%;
            word-break: break-word;
          }
          .row .val {
            display: table-cell;
            width: 40%;
            text-align: right;
            white-space: nowrap;
            padding-left: 4px;
          }
          .row.total-row { font-weight: bold; font-size: 12px; }
          .note { font-size: 10px; }
          .bottom-pad { height: 25mm; }
        </style>
      </head>
      <body>
        <div class="center no-break">
          ${summaryBusinessName ? `<div class="bold" style="font-size:15px;">${summaryBusinessName}</div>` : ""}
          ${summaryAddress ? `<div class="note">${summaryAddress}</div>` : ""}
          <div class="bold" style="margin-top:3px;">BILL SUMMARY</div>
          <div class="note">NOT OFFICIAL RECEIPT</div>
        </div>
        <div class="line"></div>
        <div class="row"><span class="lbl">Date:</span><span class="val">${nowLocal.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}</span></div>
        <div class="row"><span class="lbl">Time:</span><span class="val">${nowLocal.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span></div>
        <div class="row"><span class="lbl">Table:</span><span class="val">${table.area} - ${table.name}</span></div>
        <div class="row"><span class="lbl">Cashier:</span><span class="val">${user?.name || "Staff"}</span></div>
        <div class="row"><span class="lbl">Orders:</span><span class="val">${sentOrderIds || "—"}</span></div>
        <div class="line"></div>
        <div class="bold" style="margin-bottom:3px;">ITEMS</div>
        ${itemLines || `<div class="row"><span class="lbl">No items</span><span class="val">0.00</span></div>`}
        <div class="line"></div>
        <div class="row"><span class="lbl">Subtotal:</span><span class="val">${formatCurrency(combinedSubtotal)}</span></div>
        ${combinedComplimentary > 0 ? `<div class="row"><span class="lbl">Less Compli:</span><span class="val">-${formatCurrency(combinedComplimentary)}</span></div>` : ""}
        ${appliedDiscount ? `<div class="row"><span class="lbl">Discount (${appliedDiscount.name}):</span><span class="val">-${formatCurrency(discountAmount)}</span></div>` : ""}
        <div class="row"><span class="lbl">${serviceLabel}:</span><span class="val">${formatCurrency(discountedServiceCharge)}</span></div>
        <div class="row"><span class="lbl">${taxLabel}:</span><span class="val">${formatCurrency(discountedTax)}</span></div>
        ${((useSplitPayment && splitCardSurcharge > 0) || (!useSplitPayment && hasCardSurcharge && cardSurcharge > 0))
          ? `<div class="row"><span class="lbl">Card Fee:</span><span class="val">${formatCurrency(useSplitPayment ? splitCardSurcharge : cardSurcharge)}</span></div>`
          : ""
        }
        <div class="line"></div>
        <div class="row total-row"><span class="lbl">TOTAL DUE:</span><span class="val">${formatCurrency(finalTotal)}</span></div>
        <div class="line"></div>
        <div class="center note">For bill checking before payment only.</div>
        <div class="bottom-pad"></div>
      </body>
      </html>
    `;

    // Build payload for thermal/QZ
    const billPayload = {
      tableId,
      businessName: summaryBusinessName,
      businessAddress: summaryAddress,
      date: nowLocal.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
      time: nowLocal.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      table: `${table.area} - ${table.name}`,
      cashier: user?.name || "Staff",
      orderIds: sentOrderIds || "—",
      items: paymentDisplayItems.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        subtotal: item.subtotal,
        department: item.department,
        servedByName: item.servedByName,
        isComplimentary: item.isComplimentary,
        specialRequest: item.specialRequest,
      })),
      subtotal: combinedSubtotal,
      complimentary: combinedComplimentary > 0 ? combinedComplimentary : undefined,
      discount: appliedDiscount ? discountAmount : undefined,
      discountName: appliedDiscount?.name,
      serviceCharge: discountedServiceCharge,
      serviceLabel,
      tax: discountedTax,
      taxLabel,
      cardSurcharge: (useSplitPayment && splitCardSurcharge > 0) ? splitCardSurcharge : (!useSplitPayment && hasCardSurcharge && cardSurcharge > 0) ? cardSurcharge : undefined,
      total: finalTotal,
    };

    const printerName = getPrinterForJob("running_bill") || undefined;
    if (!printerName?.trim()) {
      toast.info(`${PRINT_JOB_LABELS.running_bill} printing is disabled.`);
      return;
    }

    // Try thermal / QZ first
    let thermalSent = false;
    try {
      if (isQzTrayEnabled()) {
        const { base64 } = await api.print.qzPayload.runningBill(billPayload as Record<string, unknown>);
        await qzPrintRawBase64(printerName, base64);
        thermalSent = true;
      } else {
        const result = await api.print.runningBill({ ...billPayload, printerName });
        if (result.ok) thermalSent = true;
      }
    } catch {
      // fallback to browser
    }

    if (thermalSent) {
      toast.success("Running bill sent to printer.");
      return;
    }

    // Fallback: browser popup (printer assigned but thermal failed)
    const printWindow = window.open("", "_blank", "width=400,height=1000,scrollbars=yes");
    if (!printWindow) {
      toast.error("Print window was blocked. Allow popups for this site and try again.");
      return;
    }

    printWindow.document.write(html);
    printWindow.document.close();
    const triggerPrint = () => {
      printWindow.onafterprint = () => {
        try { printWindow.close(); } catch { /* no-op */ }
      };
      printWindow.print();
    };
    if (printWindow.document.readyState === "complete") {
      printWindow.focus();
      setTimeout(triggerPrint, 120);
    } else {
      printWindow.onload = () => {
        printWindow.focus();
        setTimeout(triggerPrint, 120);
      };
    }
  };

  return (
    <AppLayout>
      {/* Compact header */}
      <div className="flex items-center gap-3 mb-4">
        <Link to="/pos">
          <Button variant="ghost" size="icon" aria-label="Back to tables">
            <ArrowLeft className="w-5 h-5" />
          </Button>
        </Link>
        <h1 className="text-lg font-semibold">
          {table.area} – Table {table.name}
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            {table.status === "occupied" ? "Occupied" : "Available"}
          </span>
        </h1>
      </div>

      {isMonitorOnly && (
        <p className="mb-3 text-xs text-amber-700 dark:text-amber-300">
          View only — Staff can add items.
        </p>
      )}
      {!canAddToOrder && canProcessPayment && (
        <p className="mb-3 text-xs text-blue-700 dark:text-blue-300">
          Cashier mode — Process payments.
        </p>
      )}

      {/* Split View */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 lg:h-[calc(100vh-200px)]">
        {/* Left: Products */}
        <div className="lg:col-span-3 space-y-4 overflow-y-auto">
          {/* Categories - buttons */}
          <div className="flex gap-2 flex-wrap">
            {categories.map((cat) => (
              <Button
                key={cat}
                variant={selectedCategory === cat ? "default" : "secondary"}
                size="sm"
                onClick={() => setSelectedCategory(cat)}
              >
                {cat}
              </Button>
            ))}
          </div>

          {/* Sub-categories (e.g. 1pc, 2pc, Gravy) when category has options */}
          {selectedCategory && subCategoriesForCurrent.length > 0 && (
            <div className="flex gap-2 flex-wrap items-center">
              <span className="text-xs text-muted-foreground mr-1">Options:</span>
              <Button
                variant={!selectedSubCategory ? "default" : "outline"}
                size="sm"
                onClick={() => setSelectedSubCategory("")}
              >
                All
              </Button>
              {subCategoriesForCurrent.map((sub) => (
                <Button
                  key={sub}
                  variant={selectedSubCategory === sub ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelectedSubCategory(sub)}
                >
                  {sub}
                </Button>
              ))}
            </div>
          )}

          {hasAnySentOrder && canAddToOrder && (
            <p className="text-xs text-muted-foreground">
              Tap &quot;+ New Order&quot; in the order panel to add another round.
            </p>
          )}
          {selectedCategory === "Ladies Drink" && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Step 1: Select Lady</p>
                {selectedLdLadyForCategory && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setSelectedLdLadyForCategory("")}
                  >
                    Change
                  </Button>
                )}
              </div>
              {ldLadies.length === 0 ? (
                <p className="text-xs text-amber-600">
                  No ladies found. Add staff members in the Staff tab first.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {ldLadies.map((lady) => (
                    <Button
                      key={lady.id}
                      type="button"
                      size="sm"
                      variant={selectedLdLadyForCategory === lady.id ? "default" : "outline"}
                      onClick={() => setSelectedLdLadyForCategory(lady.id)}
                    >
                      {lady.name}
                    </Button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                {selectedLdLadyProfile
                  ? `Step 2: Choose LD type for ${selectedLdLadyProfile.name}.`
                  : "Step 2: Select LD type after choosing a lady."}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {filteredProducts.map((product) => (
              <button
                key={product.id}
                type="button"
                title={product.name}
                onClick={() => canAddItems && addToOrder(product)}
                disabled={!canAddItems || requiresLdLadySelection}
                className={`p-3 rounded-lg text-left transition-colors min-h-[4rem] ${
                  canAddItems && !requiresLdLadySelection
                    ? "bg-muted/30 hover:bg-muted/60 border border-transparent hover:border-border cursor-pointer"
                    : "bg-muted/20 border border-transparent cursor-default opacity-50"
                }`}
              >
                <p className="text-sm font-medium break-words" title={product.name}>
                  {product.name}
                </p>
                <p className="text-xs text-primary font-semibold mt-0.5">
                  {formatCurrency(product.price)}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Right: Order */}
        <div className="lg:col-span-2 bg-card border border-border rounded-xl p-4 flex flex-col h-fit lg:h-[calc(100vh-200px)] lg:sticky lg:top-4">
          {/* Compact order tabs */}
          <div className="space-y-1.5 mb-3 shrink-0">
            {orderTabRows.map((row, rowIdx) => (
              <div key={`tab-row-${rowIdx}`} className="flex items-center gap-1.5 flex-wrap">
                {row.map(({ tab, idx }) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => setActiveTabIndex(idx)}
                    className={`min-w-[36px] px-2.5 py-1.5 rounded-md text-sm font-medium transition-colors ${
                      activeTabIndex === idx
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted/60 hover:bg-muted text-muted-foreground"
                    }`}
                    title={
                      tab.sent
                        ? `Order ${formatOrderDisplayNumber(tab.orderNumber, tab.id)} (system id ${tab.id})`
                        : "Draft"
                    }
                  >
                    {tab.sent ? formatOrderTabLabel(tab.orderNumber, tab.id) : idx + 1}
                  </button>
                ))}
                {canAddToOrder && rowIdx === orderTabRows.length - 1 && (
                  <button
                    type="button"
                    onClick={addNewOrderTab}
                    className="flex items-center justify-center min-w-[36px] px-2.5 py-1.5 rounded-md text-sm border border-dashed border-muted-foreground/40 text-muted-foreground hover:border-primary hover:text-primary"
                    title="New order"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between mb-2 shrink-0">
            <span className="text-sm font-medium">
              {orderSent ? "Sent" : "Adding items"}
            </span>
          </div>

          {/* Order Items - Scrollable */}
          <div className="space-y-2 flex-1 overflow-y-auto mb-4 min-h-0 max-h-[40vh] lg:max-h-none">
            {orderItems.filter((item) => !item.isVoided).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                {canAddItems ? "Tap products to add to order" : "No items in this order."}
              </p>
            ) : (
              orderItems
                .filter((item) => !item.isVoided)
                .map((item) => (
                <div
                  key={item.id ?? `${item.productId}:${item.servedBy ?? ""}`}
                  className={`flex items-center justify-between p-2 rounded-lg ${
                    item.isVoided
                      ? "bg-muted/50 opacity-75"
                      : item.isComplimentary
                        ? "bg-purple-500/10 border border-purple-500/30"
                        : "bg-background"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                      <p
                        className={`text-sm font-medium break-words ${item.isVoided ? "line-through text-muted-foreground" : ""} ${item.isComplimentary ? "text-purple-600" : ""}`}
                        title={item.name}
                      >
                        {item.name}
                      </p>
                      {item.specialRequest && (
                        <span className="text-xs text-amber-600 dark:text-amber-400 italic" title={item.specialRequest}>
                          ({item.specialRequest})
                        </span>
                      )}
                      {item.isVoided && (
                        <span className="text-xs font-medium text-destructive shrink-0">
                          VOIDED{item.voidedByName ? ` by ${item.voidedByName}` : ""}
                        </span>
                      )}
                      {item.servedByName && !item.isVoided && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-violet-500/20 text-violet-700 dark:text-violet-300 shrink-0">
                          <User className="w-3 h-3" />
                          {item.servedByName}
                        </span>
                      )}
                      {item.isComplimentary && !item.isVoided && (
                        <Gift className="w-3 h-3 text-purple-500 shrink-0" />
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatCurrency(item.unitPrice)} × {item.quantity}
                      {item.isComplimentary && !item.isVoided && <span className="ml-1 text-purple-500">(Complimentary)</span>}
                      {item.discount > 0 && <span className="ml-1 text-green-600">(-{formatCurrency(item.discount)})</span>}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {orderSent && item.id && !item.isVoided && canRequestVoid && (
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-6 w-6 text-destructive hover:text-destructive"
                        onClick={() => openItemVoidModal(item)}
                        title="Void this item (manager auth)"
                      >
                        <Ban className="w-3 h-3" />
                      </Button>
                    )}
                    {canAddItems && !item.isVoided ? (
                      <>
                        <Button
                          variant={item.isComplimentary ? "default" : "outline"}
                          size="icon"
                          className={`h-6 w-6 ${item.isComplimentary ? "bg-purple-500 hover:bg-purple-600" : ""}`}
                          onClick={() => toggleComplimentary(item.productId, item.servedBy)}
                          title={item.isComplimentary ? "Remove complimentary" : "Mark as complimentary"}
                        >
                          <Gift className="w-3 h-3" />
                        </Button>
                        <Button
                          variant={item.discount > 0 ? "default" : "outline"}
                          size="icon"
                          className={`h-6 w-6 ${item.discount > 0 ? "bg-green-600 hover:bg-green-700" : ""}`}
                          onClick={() => setItemDiscount(item.productId, item.servedBy)}
                          title="Set item discount"
                        >
                          <Percent className="w-3 h-3" />
                        </Button>
                        <Button
                          variant={item.specialRequest ? "default" : "outline"}
                          size="icon"
                          className={`h-6 w-6 ${item.specialRequest ? "bg-amber-500 hover:bg-amber-600" : ""}`}
                          onClick={() => setCommentModal({ productId: item.productId, servedBy: item.servedBy, value: item.specialRequest ?? "" })}
                          title={item.specialRequest ? `Comment: ${item.specialRequest}` : "Add comment"}
                        >
                          <MessageSquare className="w-3 h-3" />
                        </Button>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => updateQuantity(item.productId, -1, item.servedBy)}
                          >
                            -
                          </Button>
                          <span className="w-6 text-center text-sm">{item.quantity}</span>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => updateQuantity(item.productId, 1, item.servedBy)}
                          >
                            +
                          </Button>
                        </div>
                      </>
                    ) : !item.isVoided ? (
                      <span className="text-sm text-muted-foreground">× {item.quantity}</span>
                    ) : null}
                    <span className={`font-medium text-sm w-20 text-right ${item.isVoided ? "text-muted-foreground line-through" : ""}`}>
                      {formatCurrency(item.subtotal)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Totals - compact */}
          <div className="border-t border-border pt-3 space-y-1 mt-auto shrink-0 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotal)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>+ Tax &amp; Service</span>
              <span>{formatCurrency(tax + serviceCharge)}</span>
            </div>
            <div className="flex justify-between font-semibold pt-2 border-t border-border text-base">
              <span>Total</span>
              <span className="text-primary">{formatCurrency(total)}</span>
            </div>
            {hasAnySentOrder && (
              <div className="flex justify-between font-medium pt-1 text-primary text-sm">
                <span>Running bill total</span>
                <span>{formatCurrency(combinedTotalBeforeDiscount)}</span>
              </div>
            )}
          </div>

          {/* Actions: Staff sends to dept, Cashier/Admin process payment */}
          {(canSendToDept || canProcessPayment || canRequestVoid || canPrintReceipt || canReprintFinalBill) && (
            <div className="grid gap-2 mt-4 shrink-0 grid-cols-1 sm:grid-cols-2">
              {canSendToDept && !orderSent && (
                <Button 
                  variant="secondary" 
                  disabled={orderItems.length === 0}
                  onClick={() => setSendToDeptOpen(true)}
                >
                  <Send className="w-4 h-4 mr-2" />
                  Send to Dept
                </Button>
              )}
              {canProcessPayment && (
                <Button 
                  disabled={!hasAnySentOrder || processingPayment} 
                  className="w-full"
                  title={!hasAnySentOrder ? "Send at least one order to departments first" : ""}
                  onClick={handleProcessPayment}
                >
                  {processingPayment ? (
                    <>
                      <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Processing...
                    </>
                  ) : (
                    <>
                      <CreditCard className="w-4 h-4 mr-2" />
                      Process Payment
                    </>
                  )}
                </Button>
              )}
              {canProcessPayment && (
                <Button
                  variant="outline"
                  disabled={!hasAnySentOrder}
                  onClick={printBillSummaryViaBrowser}
                  title={!hasAnySentOrder ? "Send at least one order first" : "Print running bill before payment"}
                >
                  <Printer className="w-4 h-4 mr-2" />
                  Running Bill
                </Button>
              )}
              {canRequestVoid && (
                <Button
                  variant="outline"
                  disabled={!hasAnySentOrder}
                  onClick={openVoidModal}
                >
                  Request Void
                </Button>
              )}
              {(canPrintReceipt || canProcessPayment) && (
                <Button
                  variant="outline"
                  disabled={!orderSent || orderItems.filter((item) => !item.isVoided).length === 0}
                  onClick={() => void handleReprintOrderSlip()}
                  title={
                    !orderSent
                      ? "Select a sent order tab first"
                      : "Reprint order slip for the selected order (for signing after void)"
                  }
                >
                  <Receipt className="w-4 h-4 mr-2" />
                  Reprint Order Slip
                </Button>
              )}
              {canReprintFinalBill && (
                <Button
                  variant="outline"
                  disabled={lastPaidOrderIds.length === 0}
                  onClick={() => void handleReprintFinalBill()}
                  title={
                    lastPaidOrderIds.length === 0
                      ? "Complete payment first to reprint the final bill"
                      : "Reprint final bill (official receipt copy)"
                  }
                >
                  <Printer className="w-4 h-4 mr-2" />
                  Reprint Final Bill
                </Button>
              )}
            </div>
          )}
          {isMonitorOnly && orderItems.length === 0 && (
            <p className="text-xs text-muted-foreground mt-4 text-center">
              Open this table as Staff to add items.
            </p>
          )}
          {!canAddToOrder && canProcessPayment && orderItems.length === 0 && (
            <p className="text-xs text-muted-foreground mt-4 text-center">
              Waiting for Staff to add items before you can process payment.
            </p>
          )}
        </div>
      </div>

      {/* Send to Department Modal */}
      <Dialog open={sendToDeptOpen} onOpenChange={setSendToDeptOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Printer className="w-5 h-5" />
              Send Order to Departments
            </DialogTitle>
            <p className="text-sm text-muted-foreground">
              Review the receipts that will be printed for each department before sending.
            </p>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
            {/* Bar Receipt */}
            {barItems.length > 0 && (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                    <Wine className="w-4 h-4 text-amber-600" />
                    <span className="font-medium text-amber-800 dark:text-amber-200">Printing Receipt for Bar</span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0 h-8"
                    onClick={() => printDeptReceipt("BAR", "Drinks & Beverages", barItems, displayOrderNumber)}
                  >
                    <Printer className="w-4 h-4 mr-1" />
                    Print
                  </Button>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-6 font-mono text-sm">
                  <div className="text-center mb-4">
                    <h3 className="text-xl font-bold tracking-wider">BAR</h3>
                    <p className="text-xs text-muted-foreground">Drinks & Beverages</p>
                  </div>
                  
                  <div className="space-y-1 mb-4 text-xs">
                    <div className="flex justify-between">
                      <span>Order No:</span>
                      <span className="font-semibold">{displayOrderNumber}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Date:</span>
                      <span>{sendPreviewNow.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Time:</span>
                      <span>{sendPreviewNow.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Area:</span>
                      <span>{table.area}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Table:</span>
                      <span className="font-semibold">Table {table.name}</span>
                    </div>
                  </div>

                  <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3">
                    <p className="font-bold mb-2">ITEMS</p>
                    <div className="space-y-2">
                      {barItems.map((item) => (
                        <div key={item.productId} className="flex justify-between">
                          <span>{item.quantity}x {item.name}{item.specialRequest && <em className="text-xs text-muted-foreground ml-1">({item.specialRequest})</em>}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 text-xs">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Encoder:</span>
                      <span>{user?.name || "Staff"}</span>
                    </div>
                  </div>

                  <div className="text-center mt-4 text-xs text-muted-foreground">
                    ================================
                  </div>
                </div>
              </div>
            )}

            {/* Kitchen Receipt */}
            {kitchenItems.length > 0 && (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="bg-green-500/10 border-b border-green-500/30 px-4 py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                    <ChefHat className="w-4 h-4 text-green-600" />
                    <span className="font-medium text-green-800 dark:text-green-200">Printing Receipt for Kitchen</span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0 h-8"
                    onClick={() => printDeptReceipt("KITCHEN", "Food Orders", kitchenItems, displayOrderNumber)}
                  >
                    <Printer className="w-4 h-4 mr-1" />
                    Print
                  </Button>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-6 font-mono text-sm">
                  <div className="text-center mb-4">
                    <h3 className="text-xl font-bold tracking-wider">KITCHEN</h3>
                    <p className="text-xs text-muted-foreground">Food Orders</p>
                  </div>
                  
                  <div className="space-y-1 mb-4 text-xs">
                    <div className="flex justify-between">
                      <span>Order No:</span>
                      <span className="font-semibold">{displayOrderNumber}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Date:</span>
                      <span>{sendPreviewNow.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Time:</span>
                      <span>{sendPreviewNow.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Area:</span>
                      <span>{table.area}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Table:</span>
                      <span className="font-semibold">Table {table.name}</span>
                    </div>
                  </div>

                  <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3">
                    <p className="font-bold mb-2">ITEMS</p>
                    <div className="space-y-2">
                      {kitchenItems.map((item) => (
                        <div key={item.productId} className="flex justify-between">
                          <span>{item.quantity}x {item.name}{item.specialRequest && <em className="text-xs text-muted-foreground ml-1">({item.specialRequest})</em>}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 text-xs">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Encoder:</span>
                      <span>{user?.name || "Staff"}</span>
                    </div>
                  </div>

                  <div className="text-center mt-4 text-xs text-muted-foreground">
                    ================================
                  </div>
                </div>
              </div>
            )}

            {/* LD Receipt (if any) */}
            {ldItems.length > 0 && (
              <div className="border border-border rounded-lg overflow-hidden">
                <div className="bg-purple-500/10 border-b border-purple-500/30 px-4 py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
                    <span className="font-medium text-purple-800 dark:text-purple-200">Printing Receipt for LD</span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="shrink-0 h-8"
                    onClick={() => printDeptReceipt("LD", "LD Orders", ldItems, displayOrderNumber)}
                  >
                    <Printer className="w-4 h-4 mr-1" />
                    Print
                  </Button>
                </div>
                <div className="bg-white dark:bg-zinc-900 p-6 font-mono text-sm">
                  <div className="text-center mb-4">
                    <h3 className="text-xl font-bold tracking-wider">LD</h3>
                    <p className="text-xs text-muted-foreground">LD Orders</p>
                  </div>
                  
                  <div className="space-y-1 mb-4 text-xs">
                    <div className="flex justify-between">
                      <span>Order No:</span>
                      <span className="font-semibold">{displayOrderNumber}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Date:</span>
                      <span>{sendPreviewNow.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Time:</span>
                      <span>{sendPreviewNow.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Area:</span>
                      <span>{table.area}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Table:</span>
                      <span className="font-semibold">Table {table.name}</span>
                    </div>
                  </div>

                  <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3">
                    <p className="font-bold mb-2">ITEMS</p>
                    <div className="space-y-3">
                      {(() => {
                        const byLady: Record<string, typeof ldItems> = {};
                        for (const item of ldItems) {
                          const key = item.servedByName || "Unassigned";
                          if (!byLady[key]) byLady[key] = [];
                          byLady[key].push(item);
                        }
                        return Object.entries(byLady).map(([ladyName, ladyItems]) => (
                          <div key={ladyName}>
                            <p className="text-xs font-bold border-b border-dashed border-gray-300 dark:border-gray-600 pb-1 mb-1">{ladyName}</p>
                            {ladyItems.map((item, i) => (
                              <div key={i} className="flex justify-between pl-2">
                                <span>{item.quantity}x {item.name}{item.specialRequest && <em className="text-xs text-muted-foreground ml-1">({item.specialRequest})</em>}</span>
                              </div>
                            ))}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>

                  <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 text-xs">
                    <div className="flex justify-between text-muted-foreground">
                      <span>Encoder:</span>
                      <span>{user?.name || "Staff"}</span>
                    </div>
                  </div>

                  <div className="text-center mt-4 text-xs text-muted-foreground">
                    ================================
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Summary */}
          <div className="mt-6 p-4 bg-muted/50 rounded-lg">
            <div className="flex flex-wrap gap-4 text-sm">
              {barItems.length > 0 && (
                <div className="flex items-center gap-2">
                  <Wine className="w-4 h-4 text-amber-600" />
                  <span><strong>{barItems.length}</strong> item(s) to Bar</span>
                </div>
              )}
              {kitchenItems.length > 0 && (
                <div className="flex items-center gap-2">
                  <ChefHat className="w-4 h-4 text-green-600" />
                  <span><strong>{kitchenItems.length}</strong> item(s) to Kitchen</span>
                </div>
              )}
              {ldItems.length > 0 && (
                <div className="flex items-center gap-2">
                  <span><strong>{ldItems.length}</strong> item(s) to LD</span>
                </div>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-3 mt-6">
            <Button 
              variant="outline" 
              onClick={() => setSendToDeptOpen(false)}
              disabled={sending}
            >
              Cancel
            </Button>
            <Button 
              onClick={handleConfirmSend}
              disabled={sending}
              className="flex-1 bg-green-600 hover:bg-green-700"
            >
              {sending ? (
                <>
                  <div className="w-4 h-4 mr-2 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Printer className="w-4 h-4 mr-2" />
                  Confirm & Send
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Method Selection Modal */}
      <Dialog open={paymentMethodModalOpen} onOpenChange={setPaymentMethodModalOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5" />
              Select Payment Method
            </DialogTitle>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-4">
            {/* Left: Order Summary */}
            <div className="bg-muted/30 rounded-xl p-5">
              <div className="flex items-start justify-between gap-2 mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <span className="text-primary font-bold text-sm">RA</span>
                  </div>
                  <div>
                    <p className="font-semibold">{posSettings.businessName || "Rabbit Alley"}</p>
                    <p className="text-xs text-muted-foreground">
                      {sentTabs.length > 1 ? `Table bill (${sentTabs.length} orders)` : `Order #${formatOrderDisplayNumber(sentTabs[0]?.orderNumber, sentTabs[0]?.id)}`}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={printBillSummaryViaBrowser}
                  title="Print total bill summary before payment"
                >
                  <Printer className="w-3.5 h-3.5 mr-1" />
                  Print Bill
                </Button>
              </div>

              {/* Items - combined from all sent orders (voided hidden); cashier can mark as complimentary at bill-out */}
              <div className="space-y-3 mb-4 max-h-[350px] overflow-y-auto">
                {paymentDisplayItems.map((item, idx) => (
                  <div key={item.id ? `item-${item.id}` : `${item.productId}-${idx}`} className={`flex justify-between items-start gap-2 text-sm ${item.isComplimentary ? "text-purple-600" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium flex items-center gap-1 flex-wrap">
                        {item.name}
                        {item.isComplimentary && <Gift className="w-3 h-3 shrink-0" />}
                        {canProcessPayment && item.id && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 shrink-0 text-purple-600 hover:text-purple-700 hover:bg-purple-500/10"
                            title={item.isComplimentary ? "Remove complimentary" : "Mark as complimentary"}
                            onClick={async () => {
                              try {
                                await api.orderItems.setComplimentary(item.id!, !item.isComplimentary);
                                await refetchOrders();
                              } catch {
                                toast.error("Failed to update complimentary");
                              }
                            }}
                          >
                            <Gift className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Qty: {item.quantity}
                        {item.isComplimentary && " (Compli)"}
                        {item.department === "LD" && item.servedByName && (
                          <span className="ml-1 text-purple-500 font-medium">· {item.servedByName}</span>
                        )}
                        {item.specialRequest && (
                          <span className="ml-1 italic">· {item.specialRequest}</span>
                        )}
                      </p>
                    </div>
                    <p className={`font-medium shrink-0 ${item.isComplimentary ? "line-through" : ""}`}>
                      {formatCurrency(item.subtotal)}
                    </p>
                  </div>
                ))}
              </div>

              {/* Totals - combined */}
              <div className="border-t border-border pt-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(combinedSubtotal)}</span>
                </div>
                {combinedComplimentary > 0 && (
                  <div className="flex justify-between text-sm text-purple-600">
                    <span>Less Complimentary</span>
                    <span>-{formatCurrency(combinedComplimentary)}</span>
                  </div>
                )}
                {appliedDiscount && (
                  <div className="flex justify-between text-sm text-green-600">
                    <span>Discount ({appliedDiscount.name})</span>
                    <span>-{formatCurrency(discountAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{serviceLabel}</span>
                  <span>{formatCurrency(discountedServiceCharge)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{taxLabel}</span>
                  <span>{formatCurrency(discountedTax)}</span>
                </div>
                {hasCardSurcharge && !useSplitPayment && (
                  <div className="flex justify-between text-sm text-amber-600">
                    <span>Card Surcharge ({posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}%)</span>
                    <span>+{formatCurrency(cardSurcharge)}</span>
                  </div>
                )}
                {useSplitPayment && splitCardSurcharge > 0 && (
                  <div className="flex justify-between text-sm text-amber-600">
                    <span>Card Surcharge ({posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}%)</span>
                    <span>+{formatCurrency(splitCardSurcharge)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-lg pt-2 border-t border-border">
                  <span>Total</span>
                  <span className="text-primary">{formatCurrency(finalTotal)}</span>
                </div>
                {useSplitPayment && splitPayments.some((sp) => Number(sp.amount) > 0) && (
                  <div className="pt-3 mt-2 border-t border-dashed border-border space-y-1">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Payment breakdown</p>
                    {splitPayments.map((sp, idx) => {
                      const amt = Number(sp.amount) || 0;
                      if (amt <= 0) return null;
                      const label = sp.method === "charge" ? `Charge (${splitChargeNames[idx] || (chargeSplitsCount === 1 ? chargeCustomerName : "") || "—"})` : formatPaymentMethodLabel(sp.method);
                      return (
                        <div key={idx} className="flex justify-between text-sm">
                          <span>{label}</span>
                          <span>{formatCurrency(amt)}</span>
                        </div>
                      );
                    })}
                    <div className="flex justify-between text-sm font-medium pt-1">
                      <span>Split total</span>
                      <span>{formatCurrency(splitTotal)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Payment Methods */}
            <div className="space-y-4">
              {/* Payment Method Buttons */}
              <div className={`grid grid-cols-2 gap-3 ${useSplitPayment ? "opacity-50 pointer-events-none" : ""}`}>
                <button type="button" onClick={() => setSelectedPaymentMethod("cash")} className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 ${selectedPaymentMethod === "cash" ? "border-green-500 bg-green-500/10" : "border-border hover:border-green-500/50"}`}>
                  <Banknote className={`w-6 h-6 ${selectedPaymentMethod === "cash" ? "text-green-500" : "text-muted-foreground"}`} />
                  <span className={`text-sm font-medium ${selectedPaymentMethod === "cash" ? "text-green-600" : ""}`}>Cash</span>
                </button>
                <button type="button" onClick={() => setSelectedPaymentMethod("gcash")} className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 ${selectedPaymentMethod === "gcash" ? "border-blue-500 bg-blue-500/10" : "border-border hover:border-blue-500/50"}`}>
                  <Smartphone className={`w-6 h-6 ${selectedPaymentMethod === "gcash" ? "text-blue-500" : "text-muted-foreground"}`} />
                  <span className={`text-sm font-medium ${selectedPaymentMethod === "gcash" ? "text-blue-600" : ""}`}>GCash</span>
                </button>
                <button type="button" onClick={() => setSelectedPaymentMethod("bank")} className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 ${selectedPaymentMethod === "bank" ? "border-cyan-500 bg-cyan-500/10" : "border-border hover:border-cyan-500/50"}`}>
                  <Building2 className={`w-6 h-6 ${selectedPaymentMethod === "bank" ? "text-cyan-500" : "text-muted-foreground"}`} />
                  <span className={`text-sm font-medium ${selectedPaymentMethod === "bank" ? "text-cyan-600" : ""}`}>Bank</span>
                </button>
                <button type="button" onClick={() => setSelectedPaymentMethod("debit")} className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 relative ${selectedPaymentMethod === "debit" ? "border-purple-500 bg-purple-500/10" : "border-border hover:border-purple-500/50"}`}>
                  <CreditCard className={`w-6 h-6 ${selectedPaymentMethod === "debit" ? "text-purple-500" : "text-muted-foreground"}`} />
                  <span className={`text-sm font-medium ${selectedPaymentMethod === "debit" ? "text-purple-600" : ""}`}>Debit</span>
                  <span className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-600">
                    +{posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}%
                  </span>
                </button>
                <button type="button" onClick={() => setSelectedPaymentMethod("credit")} className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 relative ${selectedPaymentMethod === "credit" ? "border-orange-500 bg-orange-500/10" : "border-border hover:border-orange-500/50"}`}>
                  <CreditCard className={`w-6 h-6 ${selectedPaymentMethod === "credit" ? "text-orange-500" : "text-muted-foreground"}`} />
                  <span className={`text-sm font-medium ${selectedPaymentMethod === "credit" ? "text-orange-600" : ""}`}>Credit</span>
                  <span className="absolute top-1 right-1 text-[9px] px-1 py-0.5 rounded bg-amber-500/20 text-amber-600">
                    +{posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}%
                  </span>
                </button>
                <button type="button" onClick={() => setChargeAuthModalOpen(true)} className={`p-3 rounded-xl border-2 transition-all flex flex-col items-center gap-1.5 col-span-2 ${selectedPaymentMethod === "charge" ? "border-amber-600 bg-amber-500/10" : "border-border hover:border-amber-500/50"}`}>
                  <Receipt className={`w-6 h-6 ${selectedPaymentMethod === "charge" ? "text-amber-600" : "text-muted-foreground"}`} />
                  <span className={`text-sm font-medium ${selectedPaymentMethod === "charge" ? "text-amber-700" : ""}`}>Charge / Utang</span>
                  <span className="text-[9px] text-muted-foreground">Manager auth required</span>
                </button>
              </div>

              {/* Manual payment amount entry */}
              {!useSplitPayment && selectedPaymentMethod === "charge" && chargeCustomerName && (
                <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-amber-700 dark:text-amber-300">Charge / Utang</p>
                      <p className="text-xs text-amber-600 dark:text-amber-400">Customer: {chargeCustomerName}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-red-500 hover:text-red-600"
                      onClick={() => { setSelectedPaymentMethod("cash"); setChargeCustomerName(""); }}
                    >
                      <X className="w-3 h-3 mr-1" />
                      Remove
                    </Button>
                  </div>
                </div>
              )}
              {!useSplitPayment && showAmountEntry && (
                <div className="space-y-3 p-4 bg-muted/30 rounded-xl">
                  <label className="text-sm font-medium">{amountEntryLabel}</label>
                  <Input
                    type="number"
                    placeholder={`Enter ${amountEntryLabel.toLowerCase()}...`}
                    value={amountTendered}
                    onChange={(e) => setAmountTendered(e.target.value)}
                    className="text-lg font-semibold"
                  />
                  {showAmountEntry && amountTendered && parseFloat(amountTendered) >= finalTotal && changeAmount > 0 && (
                    <div className="flex justify-between text-sm pt-2 border-t border-border">
                      <span className="text-muted-foreground">Change</span>
                      <span className="font-bold">{formatCurrency(changeAmount)}</span>
                    </div>
                  )}
                  {amountTendered && parseFloat(amountTendered) < finalTotal && (
                    <p className="text-xs text-red-500">Amount is less than total due</p>
                  )}
                  
                  {/* Quick Amount Buttons */}
                  <div className="grid grid-cols-4 gap-2 pt-2">
                    {[100, 200, 500, 1000].map((amt) => (
                      <Button
                        key={amt}
                        variant="outline"
                        size="sm"
                        onClick={() => setAmountTendered(String(amt))}
                      >
                        ₱{amt}
                      </Button>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => setAmountTendered(String(finalTotal))}
                  >
                    Exact Amount ({formatCurrency(finalTotal)})
                  </Button>
                </div>
              )}

              {/* Multiple Payment / Split */}
              <div className="p-4 bg-muted/30 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Multiple Payment (Split)</span>
                  <Button
                    variant={useSplitPayment ? "default" : "outline"}
                    size="sm"
                    onClick={() => {
                      setUseSplitPayment((prev) => !prev);
                      setSelectedPaymentMethod("cash");
                      setChargeCustomerName("");
                    }}
                  >
                    {useSplitPayment ? "On" : "Off"}
                  </Button>
                </div>
                {useSplitPayment && (
                  <div className="space-y-2">
                    {splitPayments.map((split, idx) => (
                      <div key={idx} className="space-y-1">
                        <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={split.amount}
                            onChange={(e) =>
                              setSplitPayments((prev) =>
                                prev.map((row, rowIdx) =>
                                  rowIdx === idx ? { ...row, amount: e.target.value } : row
                                )
                              )
                            }
                            placeholder="Amount"
                          />
                          <select
                            value={split.method}
                            onChange={(e) => {
                              const newMethod = e.target.value as SplitMethod;
                              setSplitPayments((prev) =>
                                prev.map((row, rowIdx) =>
                                  rowIdx === idx ? { ...row, method: newMethod } : row
                                )
                              );
                              if (newMethod !== "charge") {
                                setSplitChargeNames((prev) => { const n = { ...prev }; delete n[idx]; return n; });
                              }
                            }}
                            className="h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                          >
                            <option value="cash">Cash</option>
                            <option value="gcash">GCash</option>
                            <option value="bank">Bank</option>
                            <option value="debit">Debit (+{posSettings.cardSurcharge}%)</option>
                            <option value="credit">Credit (+{posSettings.cardSurcharge}%)</option>
                            <option value="charge">Charge/Utang</option>
                          </select>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-10 w-10"
                            disabled={splitPayments.length <= 2}
                            onClick={() => {
                              setSplitPayments((prev) => prev.filter((_, rowIdx) => rowIdx !== idx));
                              setSplitChargeNames((prev) => {
                                const n: Record<number, string> = {};
                                Object.entries(prev).forEach(([k, v]) => {
                                  const ki = Number(k);
                                  if (ki < idx) n[ki] = v;
                                  else if (ki > idx) n[ki - 1] = v;
                                });
                                return n;
                              });
                            }}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        </div>
                        {split.method === "charge" && chargeSplitsCount > 1 && (
                          <Input
                            placeholder="Customer name (required for charge)"
                            value={splitChargeNames[idx] || ""}
                            onChange={(e) =>
                              setSplitChargeNames((prev) => ({ ...prev, [idx]: e.target.value }))
                            }
                            className="text-sm"
                          />
                        )}
                        {(isCardPaymentMethod(split.method)) && Number(split.amount) > 0 && (
                          <p className="text-xs text-blue-600">
                            Card fee: +{formatCurrency(Number(split.amount) * cardSurchargeDecimal)} = {formatCurrency(Number(split.amount) * (1 + cardSurchargeDecimal))} collected
                          </p>
                        )}
                      </div>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() =>
                        setSplitPayments((prev) => [...prev, { amount: "", method: "cash" }])
                      }
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      Add split
                    </Button>
                    <p className={`text-xs ${Math.abs(splitRemaining) < 0.01 ? "text-green-600" : "text-amber-600"}`}>
                      {Math.abs(splitRemaining) < 0.01
                        ? `Split total matches bill amount${splitCardSurcharge > 0 ? `. Card fee: +${formatCurrency(splitCardSurcharge)}` : ""}.`
                        : `Remaining: ${formatCurrency(splitRemaining)} (enter amounts to match ${formatCurrency(discountedTotal)})`}
                    </p>
                    {/* When exactly one split is Charge/Utang, show one required customer name field so Pay Now can be enabled */}
                    {chargeSplitsCount === 1 && (() => {
                      const chargeIdx = splitPayments.findIndex((sp) => sp.method === "charge");
                      if (chargeIdx === -1) return null;
                      const value = (splitChargeNames[chargeIdx] || "").trim() || chargeCustomerName;
                      return (
                        <div className="pt-2 space-y-1">
                          <label className="text-xs font-medium text-amber-700 dark:text-amber-400">Customer name (required for charge)</label>
                          <Input
                            placeholder="Enter customer name for Charge/Utang"
                            value={value}
                            onChange={(e) => {
                              const v = e.target.value;
                              setChargeCustomerName(v);
                              setSplitChargeNames((prev) => ({ ...prev, [chargeIdx]: v }));
                            }}
                            className="text-sm border-amber-500/50 focus-visible:ring-amber-500"
                          />
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Discount Section */}
              <div className="p-4 bg-muted/30 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <Tag className="w-4 h-4" />
                    Discount
                  </span>
                  {appliedDiscount ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                      onClick={() => setAppliedDiscount(null)}
                    >
                      <X className="w-3 h-3 mr-1" />
                      Remove
                    </Button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => setDiscountModalOpen(true)}
                      >
                        <Percent className="w-3 h-3 mr-1" />
                        Apply Discount
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        onClick={() => {
                          const amountRaw = window.prompt("Enter exact discount amount:");
                          if (amountRaw === null) return;
                          const amount = Number(amountRaw);
                          if (!Number.isFinite(amount) || amount <= 0) {
                            toast.error("Enter a valid discount amount");
                            return;
                          }
                          if (amount > combinedChargeable) {
                            toast.error("Discount cannot exceed subtotal");
                            return;
                          }
                          const exactDiscount = {
                            id: "exact_amount",
                            name: "Exact Amount",
                            type: "Applied",
                            value: String(amount),
                          };
                          if (canApproveDiscounts) {
                            setAppliedDiscount(exactDiscount);
                          } else {
                            setPendingDiscount(exactDiscount);
                            setManagerAuthModalOpen(true);
                            setManagerEmployeeId("");
                            setManagerPassword("");
                            setManagerAuthError(null);
                          }
                        }}
                      >
                        Exact Amount
                      </Button>
                    </div>
                  )}
                </div>
                {appliedDiscount && (
                  <div className="flex items-center justify-between p-2 bg-green-500/10 border border-green-500/30 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-green-700 dark:text-green-300">{appliedDiscount.name}</p>
                      <p className="text-xs text-green-600 dark:text-green-400">
                        {appliedDiscount.value.includes("%") ? appliedDiscount.value : `₱${appliedDiscount.value}`} off
                      </p>
                    </div>
                    <span className="text-sm font-bold text-green-600">-{formatCurrency(discountAmount)}</span>
                  </div>
                )}
              </div>

              {/* Card Surcharge Notice */}
              {hasCardSurcharge && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    A {posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}% surcharge ({formatCurrency(cardSurcharge)}) will be added for card payments.
                  </p>
                </div>
              )}

              {useSplitPayment && !splitValid && chargeSplitsCount > 0 && Math.abs(splitRemaining) < 0.01 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Enter customer name for Charge/Utang above to enable Pay Now.
                </p>
              )}
              {/* Confirm Button */}
              <Button
                className="w-full h-12 text-lg"
                onClick={handleConfirmPayment}
                disabled={
                  (useSplitPayment && !splitValid) ||
                  (showAmountEntry && (!amountTendered || parseFloat(amountTendered) < finalTotal)) ||
                  (!useSplitPayment && selectedPaymentMethod === "charge" && !chargeCustomerName.trim())
                }
              >
                Pay Now - {formatCurrency(finalTotal)}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Discount Selection Modal */}
      <Dialog open={discountModalOpen} onOpenChange={setDiscountModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="w-5 h-5" />
              Select Discount
            </DialogTitle>
          </DialogHeader>
          
          <div className="space-y-3 mt-4 max-h-[400px] overflow-y-auto">
            {availableDiscounts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No discounts available
              </p>
            ) : (
              availableDiscounts.map((discount) => (
                <button
                  key={discount.id}
                  type="button"
                  onClick={() => {
                    if (canApproveDiscounts) {
                      setAppliedDiscount(discount);
                      setDiscountModalOpen(false);
                    } else {
                      setPendingDiscount(discount);
                      setDiscountModalOpen(false);
                      setManagerAuthModalOpen(true);
                      setManagerEmployeeId("");
                      setManagerPassword("");
                      setManagerAuthError(null);
                    }
                  }}
                  className="w-full p-4 rounded-xl border-2 border-border hover:border-green-500 hover:bg-green-500/5 transition-all text-left flex items-center justify-between group"
                >
                  <div>
                    <p className="font-medium group-hover:text-green-600">{discount.name}</p>
                    {discount.category && (
                      <p className="text-xs text-muted-foreground">{discount.category}</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-green-600">
                      {discount.value.includes("%") ? discount.value : `₱${discount.value}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {discount.value.includes("%") ? "off subtotal" : "fixed discount"}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>

          <div className="flex gap-3 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setDiscountModalOpen(false)}>
              Cancel
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Charge / Utang Authorization Modal - Manager + Customer Name required */}
      <Dialog open={chargeAuthModalOpen} onOpenChange={(open) => { setChargeAuthModalOpen(open); if (!open) setChargeAuthCustomerName(""); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Receipt className="w-5 h-5" />
              Charge / Utang – Manager Authorization
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Manager must authorize and enter customer name for charge/credit payment.
          </p>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-medium">Manager Employee ID</label>
              <Input
                value={managerEmployeeId}
                onChange={(e) => { setManagerEmployeeId(e.target.value); setManagerAuthError(null); }}
                placeholder="e.g. MGR001"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Manager Password</label>
              <Input
                type="password"
                value={managerPassword}
                onChange={(e) => { setManagerPassword(e.target.value); setManagerAuthError(null); }}
                placeholder="Enter manager password"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Customer Name *</label>
              <Input
                value={chargeAuthCustomerName}
                onChange={(e) => { setChargeAuthCustomerName(e.target.value); setManagerAuthError(null); }}
                placeholder="e.g. Juan Dela Cruz"
                className="mt-1"
              />
            </div>
            {managerAuthError && <p className="text-sm text-destructive">{managerAuthError}</p>}
          </div>
          <div className="flex gap-3 mt-6">
            <Button variant="outline" className="flex-1" onClick={() => { setChargeAuthModalOpen(false); setChargeAuthCustomerName(""); }}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!managerEmployeeId.trim() || !managerPassword || !chargeAuthCustomerName.trim() || managerAuthLoading}
              onClick={async () => {
                setManagerAuthLoading(true);
                setManagerAuthError(null);
                try {
                  await api.auth.verifyManager(managerEmployeeId.trim(), managerPassword, { action: "charge", customerName: chargeAuthCustomerName.trim() });
                  setSelectedPaymentMethod("charge");
                  setChargeCustomerName(chargeAuthCustomerName.trim());
                  setChargeAuthModalOpen(false);
                  setChargeAuthCustomerName("");
                  setManagerEmployeeId("");
                  setManagerPassword("");
                  toast.success("Charge authorized");
                } catch (e) {
                  setManagerAuthError(e instanceof Error ? e.message : "Authorization failed");
                } finally {
                  setManagerAuthLoading(false);
                }
              }}
            >
              {managerAuthLoading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Verifying…
                </span>
              ) : (
                "Verify & Proceed"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* LD / Ladies Drink - Select Lady Modal */}
      <Dialog open={ladyModalOpen} onOpenChange={(open) => { setLadyModalOpen(open); if (!open) setPendingLdProduct(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="w-5 h-5" />
              Select Lady
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Assign this LD drink to a lady for incentive tracking.
          </p>
          {pendingLdProduct && (
            <p className="text-sm font-medium">
              {pendingLdProduct.name} — {formatCurrency(pendingLdProduct.price)}
            </p>
          )}
          <div className="space-y-2 mt-3">
            <label className="text-sm font-medium">Lady</label>
            <select
              value={selectedLady}
              onChange={(e) => setSelectedLady(e.target.value)}
              className="w-full h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">— Select —</option>
              {ldLadies.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
            {ldLadies.length === 0 && (
              <p className="text-xs text-amber-600">No ladies found. Add staff members in the Staff tab first.</p>
            )}
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => { setLadyModalOpen(false); setPendingLdProduct(null); }}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!selectedLady}
              onClick={() => {
                if (!pendingLdProduct || !selectedLady) return;
                const lady = ldLadies.find((l) => l.id === selectedLady);
                const variants = pendingLdProduct.priceVariants || [];
                if (variants.length > 1) {
                  setPricePickProduct(pendingLdProduct);
                  setPricePickContext({ servedBy: selectedLady, servedByName: lady?.name });
                  setLadyModalOpen(false);
                  setPendingLdProduct(null);
                  setSelectedLady("");
                  setSelectedLdLadyForCategory(selectedLady);
                  return;
                }
                doAddToOrder(pendingLdProduct, selectedLady, lady?.name);
                setSelectedLdLadyForCategory(selectedLady);
                setLadyModalOpen(false);
                setPendingLdProduct(null);
                setSelectedLady("");
              }}
            >
              Add to Order
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Price variant picker — same SKU, different price */}
      <Dialog
        open={!!pricePickProduct}
        onOpenChange={(open) => {
          if (!open) {
            setPricePickProduct(null);
            setPricePickContext(null);
          }
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Select price</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {pricePickProduct?.name} (SKU {pricePickProduct?.sku}) — inventory uses one stock item.
          </p>
          <div className="space-y-2 mt-2">
            {(pricePickProduct?.priceVariants || []).map((v) => (
              <Button
                key={String(v.id ?? v.label)}
                type="button"
                variant="outline"
                className="w-full justify-between"
                onClick={() => {
                  if (!pricePickProduct) return;
                  doAddToOrder(
                    pricePickProduct,
                    pricePickContext?.servedBy,
                    pricePickContext?.servedByName,
                    pricePickContext?.specialRequest,
                    { priceId: v.id ?? null, unitPrice: Number(v.price) }
                  );
                  setPricePickProduct(null);
                  setPricePickContext(null);
                }}
              >
                <span>{v.label}</span>
                <span>{formatCurrency(v.price)}</span>
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Request Void Modal - Select items to void, then manager credentials */}
      <Dialog open={voidModalOpen} onOpenChange={setVoidModalOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5" />
              Void Items
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Select the item(s) to void. Manager must enter credentials. Voided items will show &quot;Voided&quot; and your name on the receipt.
          </p>
          {voidableItems.length > 0 ? (
            <>
              <div className="flex items-center justify-between border-b border-border pb-2">
                <Label className="text-sm font-medium">Items to void</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() =>
                    setVoidSelectedIds(voidSelectedIds.length === voidableItems.length ? [] : voidableItems.map((i) => i.id))
                  }
                >
                  {voidSelectedIds.length === voidableItems.length ? "Clear selection" : "Select all"}
                </Button>
              </div>
              <div className="overflow-y-auto max-h-[220px] border border-border rounded-md p-2 space-y-1">
                {voidableItems.map((item) => (
                  <label
                    key={item.id}
                    className="flex items-center gap-3 py-2 px-2 rounded hover:bg-muted/50 cursor-pointer"
                  >
                    <Checkbox
                      checked={voidSelectedIds.includes(item.id)}
                      onCheckedChange={(checked) => {
                        if (checked) setVoidSelectedIds((prev) => [...prev, item.id]);
                        else setVoidSelectedIds((prev) => prev.filter((id) => id !== item.id));
                      }}
                    />
                    <span className="flex-1 text-sm">
                      {item.quantity}x {item.name}
                      {item.specialRequest && <span className="text-muted-foreground ml-1">({item.specialRequest})</span>}
                    </span>
                    <span className="text-sm font-medium">{formatCurrency(item.subtotal)}</span>
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-sm text-muted-foreground">
                No items to void on this table. The ticket may be on another table, or the tab number may not match the printed slip (use lookup below).
              </p>
              <div className="space-y-2 border border-border rounded-md p-3">
                <Label className="text-sm font-medium">Find order from printed slip</Label>
                <div className="flex gap-2">
                  <Input
                    value={voidLookupQuery}
                    onChange={(e) => setVoidLookupQuery(e.target.value)}
                    placeholder="e.g. 20240603-0034 or 34"
                    className="h-9"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={voidLookupLoading || !voidLookupQuery.trim()}
                    onClick={async () => {
                      setVoidLookupLoading(true);
                      setVoidLookupResults(null);
                      try {
                        const res = await api.orders.lookup(voidLookupQuery.trim());
                        setVoidLookupResults(res.matches);
                        if (!res.matches.length) toast.error("No order found");
                      } catch (e) {
                        toast.error(e instanceof Error ? e.message : "Lookup failed");
                      } finally {
                        setVoidLookupLoading(false);
                      }
                    }}
                  >
                    {voidLookupLoading ? "…" : "Find"}
                  </Button>
                </div>
                {voidLookupResults?.map((m) => (
                  <div key={m.orderId} className="text-sm flex flex-wrap items-center justify-between gap-2 py-1 border-t border-border/50">
                    <span>
                      <span className="font-medium">{m.orderNumber}</span>
                      {" — "}
                      {m.area} Table {m.tableName ?? m.tableId ?? "?"}
                      {m.status !== "pending" ? ` (${m.status})` : ""}
                      {m.voided ? " [voided]" : ""}
                    </span>
                    {m.tableId && m.status === "pending" && !m.voided && m.tableId !== tableId && (
                      <Button type="button" size="sm" variant="outline" onClick={() => { setVoidModalOpen(false); navigate(`/pos/table/${m.tableId}`); }}>
                        Open table
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <form onSubmit={handleRequestVoid} className="space-y-4 mt-4">
            <div>
              <Label>Reason (required)</Label>
              <Input
                value={voidReason}
                onChange={(e) => { setVoidReason(e.target.value); setVoidError(null); }}
                placeholder="e.g. Wrong order, guest cancelled"
                className="mt-1"
                required
                minLength={3}
              />
            </div>
            <div>
              <Label>Manager Employee ID</Label>
              <Input
                value={voidEmployeeId}
                onChange={(e) => { setVoidEmployeeId(e.target.value); setVoidError(null); }}
                placeholder="e.g. MGR001"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={voidPassword}
                onChange={(e) => { setVoidPassword(e.target.value); setVoidError(null); }}
                placeholder="Manager password"
                className="mt-1"
              />
            </div>
            {voidError && <p className="text-sm text-destructive">{voidError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setVoidModalOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={voiding || voidSelectedIds.length === 0}>
                {voiding ? "Voiding…" : voidSelectedIds.length === 0 ? "Select items to void" : `Void ${voidSelectedIds.length} item${voidSelectedIds.length === 1 ? "" : "s"}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Item Comment Modal */}
      <Dialog open={!!commentModal} onOpenChange={(open) => { if (!open) setCommentModal(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-amber-500" />
              Item Comment
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <Input
              autoFocus
              placeholder="Enter comment or special request..."
              value={commentModal?.value ?? ""}
              onChange={(e) => setCommentModal((prev) => prev ? { ...prev, value: e.target.value } : prev)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (commentModal) updateItemComment(commentModal.productId, commentModal.servedBy, commentModal.value);
                  setCommentModal(null);
                }
                if (e.key === "Escape") setCommentModal(null);
              }}
            />
            <p className="text-xs text-muted-foreground">This will appear on the order chit and receipt.</p>
          </div>
          <DialogFooter>
            {commentModal?.value && (
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => {
                if (commentModal) updateItemComment(commentModal.productId, commentModal.servedBy, "");
                setCommentModal(null);
              }}>
                Clear
              </Button>
            )}
            <Button variant="outline" onClick={() => setCommentModal(null)}>Cancel</Button>
            <Button onClick={() => {
              if (commentModal) updateItemComment(commentModal.productId, commentModal.servedBy, commentModal.value);
              setCommentModal(null);
            }}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Per-item Void Modal */}
      <Dialog open={itemVoidModalOpen} onOpenChange={(open) => { setItemVoidModalOpen(open); if (!open) setPendingVoidItem(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5" />
              Void Item
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {pendingVoidItem && (
              <span>Void &quot;{pendingVoidItem.name}&quot;? Manager must enter credentials.</span>
            )}
          </p>
          <form onSubmit={handleItemVoid} className="space-y-4 mt-4">
            <div>
              <Label>Reason (required)</Label>
              <Input
                value={itemVoidReason}
                onChange={(e) => { setItemVoidReason(e.target.value); setItemVoidError(null); }}
                placeholder="e.g. Wrong item, guest cancelled"
                className="mt-1"
                required
                minLength={3}
              />
            </div>
            <div>
              <Label>Manager Employee ID</Label>
              <Input
                value={itemVoidEmployeeId}
                onChange={(e) => { setItemVoidEmployeeId(e.target.value); setItemVoidError(null); }}
                placeholder="e.g. MGR001"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Password</Label>
              <Input
                type="password"
                value={itemVoidPassword}
                onChange={(e) => { setItemVoidPassword(e.target.value); setItemVoidError(null); }}
                placeholder="Manager password"
                className="mt-1"
              />
            </div>
            {itemVoidError && <p className="text-sm text-destructive">{itemVoidError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setItemVoidModalOpen(false); setPendingVoidItem(null); }}>Cancel</Button>
              <Button type="submit" disabled={itemVoiding}>{itemVoiding ? "Voiding…" : "Void Item"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Manager Authorization Modal (when Cashier applies discount) */}
      <Dialog
        open={managerAuthModalOpen}
        onOpenChange={(open) => {
          setManagerAuthModalOpen(open);
          if (!open) setPendingDiscount(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="w-5 h-5" />
              Manager Authorization
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Manager must enter credentials to apply discount
            {pendingDiscount && (
              <span className="block mt-2 font-medium text-foreground">
                Discount: {pendingDiscount.name}
              </span>
            )}
          </p>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-medium">Manager Employee ID</label>
              <Input
                value={managerEmployeeId}
                onChange={(e) => {
                  setManagerEmployeeId(e.target.value);
                  setManagerAuthError(null);
                }}
                placeholder="e.g. MGR001"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Password</label>
              <Input
                type="password"
                value={managerPassword}
                onChange={(e) => {
                  setManagerPassword(e.target.value);
                  setManagerAuthError(null);
                }}
                placeholder="Enter manager password"
                className="mt-1"
              />
            </div>
            {managerAuthError && (
              <p className="text-sm text-destructive">{managerAuthError}</p>
            )}
          </div>
          <div className="flex gap-3 mt-6">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setManagerAuthModalOpen(false);
                setPendingDiscount(null);
              }}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={!managerEmployeeId.trim() || !managerPassword || managerAuthLoading}
              onClick={async () => {
                if (!pendingDiscount) return;
                setManagerAuthLoading(true);
                setManagerAuthError(null);
                try {
                  await api.auth.verifyManager(managerEmployeeId.trim(), managerPassword, { discountName: pendingDiscount.name, discountId: pendingDiscount.id });
                  setAppliedDiscount(pendingDiscount);
                  setPendingDiscount(null);
                  setManagerAuthModalOpen(false);
                  setManagerEmployeeId("");
                  setManagerPassword("");
                  toast.success("Discount applied");
                } catch (e) {
                  setManagerAuthError(e instanceof Error ? e.message : "Authorization failed");
                } finally {
                  setManagerAuthLoading(false);
                }
              }}
            >
              {managerAuthLoading ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Verifying…
                </span>
              ) : (
                "Verify & Apply"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Payment Processing Modal */}
      <Dialog open={paymentModalOpen} onOpenChange={() => {}}>
        <DialogContent className="max-w-md [&>button]:hidden">
          <VisuallyHidden>
            <DialogTitle>Payment Processing</DialogTitle>
          </VisuallyHidden>
          <div className="flex flex-col items-center">
            {/* Status Header */}
            <div className="mb-6 text-center">
              {paymentStep === "processing" && (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-500/10 flex items-center justify-center">
                    <CreditCard className="w-8 h-8 text-blue-500 animate-pulse" />
                  </div>
                  <h3 className="text-lg font-semibold">Processing Payment</h3>
                  <p className="text-sm text-muted-foreground">Please wait...</p>
                </>
              )}
              {paymentStep === "printing" && (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-amber-500/10 flex items-center justify-center relative">
                    <Printer className="w-8 h-8 text-amber-500" />
                    <span className="absolute -top-1 -right-1 w-4 h-4 bg-amber-500 rounded-full animate-ping" />
                  </div>
                  <h3 className="text-lg font-semibold">Printing Receipt</h3>
                  <p className="text-sm text-muted-foreground">LogicOwl OJ-8030 (80mm)</p>
                </>
              )}
              {paymentStep === "done" && (
                <>
                  <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/10 flex items-center justify-center">
                    <svg className="w-8 h-8 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-green-600">Payment Complete!</h3>
                  {lastReceiptSentToBackend ? (
                    <p className="text-sm text-muted-foreground mb-4">Receipt was sent to the printer. No browser print.</p>
                  ) : (
                    <>
                      <p className="text-sm text-muted-foreground mb-2">Receipt was not sent to printer automatically.</p>
                      <p className="text-xs text-muted-foreground mb-2">For <strong>LAN printers</strong>: set <code className="bg-muted px-1 rounded">PRINTER_INTERFACE=tcp://IP:9100</code> in <code className="bg-muted px-1 rounded">server/.env</code> (comma-separated for 3 areas), restart the server, then assign in <strong>Settings</strong>. For USB, click &quot;Print receipt&quot; below and choose the printer in the dialog.</p>
                    </>
                  )}
                  <div className="flex gap-3 justify-center flex-wrap">
                    {canReprintFinalBill && lastPaidOrderIds.length > 0 && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void handleReprintFinalBill(lastPaidOrderIds)}
                      >
                        <Printer className="w-4 h-4 mr-2" />
                        Reprint Final Bill
                      </Button>
                    )}
                    {canPrintReceipt && lastReceiptForPrint && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                          printReceiptViaBrowser(lastReceiptForPrint!);
                          toast.info("In the dialog, select your printer (e.g. XPrinter) then click Print.");
                        }}
                      >
                        <Printer className="w-4 h-4 mr-2" />
                        Print Receipt Copy
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant={lastReceiptSentToBackend ? "default" : "outline"}
                      onClick={() => {
                        setPaymentModalOpen(false);
                        setLastReceiptForPrint(null);
                        setLastReceiptSentToBackend(false);
                        clearPendingBillState();
                        navigate("/pos");
                      }}
                    >
                      Done
                    </Button>
                  </div>
                </>
              )}
            </div>

            {/* Receipt Preview — matches dept chit card style */}
            <div className={`w-full border border-border rounded-lg overflow-hidden transition-all duration-500 ${paymentStep === "printing" ? "animate-pulse" : ""}`}>
              {/* Printing Animation Overlay */}
              {paymentStep === "printing" && (
                <div className="absolute inset-0 bg-gradient-to-b from-transparent via-amber-500/5 to-transparent animate-[scan_1.5s_ease-in-out_infinite]" />
              )}

              <div className="bg-white dark:bg-zinc-900 p-6 font-mono text-sm relative">
                {/* Header */}
                <div className="text-center mb-4">
                  {posSettings.businessName?.trim() && (
                    <h3 className="text-xl font-bold tracking-wider">{posSettings.businessName.trim()}</h3>
                  )}
                  {posSettings.address?.trim() && (
                    <p className="text-xs text-muted-foreground mt-1">{posSettings.address.trim()}</p>
                  )}
                  {posSettings.contact?.trim() && (
                    <p className="text-xs text-muted-foreground">{posSettings.contact.trim()}</p>
                  )}
                </div>

                {/* Order Info */}
                <div className="space-y-1 mb-4 text-xs">
                  <div className="flex justify-between">
                    <span>Order #:</span>
                    <span className="font-semibold">{formatOrderDisplayNumber(sentTabs[0]?.orderNumber, sentTabs[0]?.id)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Date:</span>
                    <span>{new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Time:</span>
                    <span>{new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Area:</span>
                    <span>{table?.area}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Table:</span>
                    <span className="font-semibold">Table {table?.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Cashier:</span>
                    <span>{user?.name || "Staff"}</span>
                  </div>
                </div>

                {/* Items — ALL items, scrollable */}
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3">
                  <p className="font-bold mb-2">ITEMS</p>
                  <div className="space-y-1 text-xs max-h-48 overflow-y-auto">
                    {paymentDisplayItems.map((item, idx) => (
                      <div key={`pay-${idx}-${item.productId}`} className="flex justify-between gap-2">
                        <span className="flex-1 min-w-0 break-words pr-2">
                          {item.quantity}x {item.name}
                          {item.department === "LD" && item.servedByName && (
                            <em className="text-muted-foreground ml-1 not-italic"> [{item.servedByName}]</em>
                          )}
                          {item.isComplimentary && (
                            <em className="text-purple-500 ml-1 not-italic">(Compli)</em>
                          )}
                          {item.specialRequest && (
                            <em className="text-muted-foreground ml-1 text-[10px]">({item.specialRequest})</em>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums">{formatCurrency(item.subtotal)}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Totals */}
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3 space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span>Subtotal:</span>
                    <span className="tabular-nums">{formatCurrency(combinedSubtotal)}</span>
                  </div>
                  {combinedComplimentary > 0 && (
                    <div className="flex justify-between">
                      <span>Less Compli:</span>
                      <span className="tabular-nums">-{formatCurrency(combinedComplimentary)}</span>
                    </div>
                  )}
                  {appliedDiscount && (
                    <div className="flex justify-between">
                      <span>Discount ({appliedDiscount.name}):</span>
                      <span className="tabular-nums">-{formatCurrency(discountAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span>{serviceLabel}:</span>
                    <span className="tabular-nums">{formatCurrency(discountedServiceCharge)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>{taxLabel}:</span>
                    <span className="tabular-nums">{formatCurrency(discountedTax)}</span>
                  </div>
                  {(hasCardSurcharge || (useSplitPayment && splitCardSurcharge > 0)) && (
                    <div className="flex justify-between">
                      <span>Card Fee ({posSettings.cardSurcharge.toFixed(2).replace(/\.00$/, "")}%):</span>
                      <span className="tabular-nums">{formatCurrency(useSplitPayment ? splitCardSurcharge : cardSurcharge)}</span>
                    </div>
                  )}
                </div>

                {/* Total (prominent) */}
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3">
                  <div className="flex justify-between font-bold text-sm">
                    <span>TOTAL:</span>
                    <span className="tabular-nums">{formatCurrency(finalTotal)}</span>
                  </div>
                </div>

                {/* Payment Info */}
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 mb-3 space-y-1 text-xs">
                  {lastReceiptForPrint && (paymentStep === "printing" || paymentStep === "done") ? (
                    <>
                      <div className="flex justify-between">
                        <span>Payment:</span>
                        <span className={lastReceiptForPrint.paymentMethod.startsWith("Split") ? "" : "uppercase"}>
                          {lastReceiptForPrint.paymentMethod}
                        </span>
                      </div>
                      <div className="flex justify-between font-bold">
                        <span>Amount Paid:</span>
                        <span className="tabular-nums">{formatCurrency(lastReceiptForPrint.amountPaid)}</span>
                      </div>
                      {(lastReceiptForPrint.change ?? 0) > 0 ||
                      MANUAL_AMOUNT_METHODS.includes(
                        lastReceiptForPrint.paymentMethod.toLowerCase() as PaymentMethod
                      ) ? (
                        <div className="flex justify-between">
                          <span>Change:</span>
                          <span className="tabular-nums">
                            {formatCurrency(lastReceiptForPrint.change ?? 0)}
                          </span>
                        </div>
                      ) : null}
                    </>
                  ) : useSplitPayment ? (
                    <>
                      <div className="flex justify-between font-medium">
                        <span>Payment:</span>
                        <span>SPLIT</span>
                      </div>
                      {splitPayments.map((sp, idx) => (
                        <div key={idx} className="flex justify-between pl-2">
                          <span>{sp.method === "charge" ? `Charge (${splitChargeNames[idx] || "—"})` : sp.method.toUpperCase()}:</span>
                          <span className="tabular-nums">{sp.amount ? formatCurrency(Number(sp.amount)) : "—"}</span>
                        </div>
                      ))}
                    </>
                  ) : (
                    <>
                      <div className="flex justify-between">
                        <span>Payment:</span>
                        <span>{selectedPaymentMethod.toUpperCase()}</span>
                      </div>
                      <div className="flex justify-between font-bold">
                        <span>Amount Paid:</span>
                        <span className="tabular-nums">{formatCurrency(lastReceiptForPrint?.amountPaid ?? finalTotal)}</span>
                      </div>
                      {!useSplitPayment && MANUAL_AMOUNT_METHODS.includes(selectedPaymentMethod) && (
                        <div className="flex justify-between">
                          <span>Change:</span>
                          <span className="tabular-nums">
                            {formatCurrency(lastReceiptForPrint?.change ?? 0)}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Footer */}
                <div className="border-t border-dashed border-gray-300 dark:border-gray-600 pt-3 text-xs text-muted-foreground">
                  <div className="flex justify-between">
                    <span>Cashier:</span>
                    <span>{user?.name || "Staff"}</span>
                  </div>
                </div>
                <div className="text-center mt-4 text-xs text-muted-foreground space-y-1">
                  <p>================================</p>
                  {posSettings.receiptFooter?.trim() && (
                    <p className="font-semibold text-foreground">{posSettings.receiptFooter.trim()}</p>
                  )}
                  <p>Please come again</p>
                  <p>================================</p>
                  <p className="mt-1">This serves as your OFFICIAL RECEIPT</p>
                  {posSettings.vatTin?.trim() && <p>VAT Reg TIN: {posSettings.vatTin.trim()}</p>}
                </div>

                {/* Printing line animation */}
                {paymentStep === "printing" && (
                  <div className="absolute left-0 right-0 h-0.5 bg-amber-500 animate-[printLine_1.5s_ease-in-out_infinite]" style={{ top: "var(--print-line-pos, 0)" }} />
                )}
              </div>
            </div>

            {/* Printer Info */}
            {paymentStep === "printing" && (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span>Connected to OJ-8030 Printer</span>
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
