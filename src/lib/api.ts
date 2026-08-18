import { STORAGE_USER, STORAGE_PERMISSIONS, STORAGE_AUTH_TOKEN, RECEIPT_PRINTER_STORAGE_KEY } from "@/lib/storage-keys";
export { RECEIPT_PRINTER_STORAGE_KEY };

const API = import.meta.env.VITE_API_URL || "";

function getStoredUser(): { id?: string; employeeId?: string; name?: string; role?: string; branchId?: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_USER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getAuthToken(): string | null {
  const token = localStorage.getItem(STORAGE_AUTH_TOKEN);
  return token && token.trim() ? token.trim() : null;
}

/** Branch ID for multi-branch: from logged-in user, default 1 */
function getBranchId(): string {
  const user = getStoredUser();
  return user?.branchId ?? "1";
}

async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const branchId = getBranchId();
  const user = getStoredUser();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Branch-Id": branchId,
    ...(options?.headers as Record<string, string>),
  };
  if (user?.id) headers["X-User-Id"] = user.id;
  if (user?.employeeId) headers["X-Employee-Id"] = user.employeeId;
  if (user?.name) headers["X-User-Name"] = user.name;
  if (user?.role) headers["X-User-Role"] = user.role;
  const authToken = getAuthToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${API}${path}`, {
    ...options,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
    localStorage.removeItem(STORAGE_USER);
    localStorage.removeItem(STORAGE_PERMISSIONS);
  }
  if (!res.ok) {
    const err = new Error((data as { error?: string }).error || "Request failed") as Error & {
      status?: number;
      data?: unknown;
    };
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
}

async function fetchPrintHtml(path: string, body: unknown): Promise<string> {
  const branchId = getBranchId();
  const user = getStoredUser();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Branch-Id": branchId,
  };
  if (user?.id) headers["X-User-Id"] = user.id;
  if (user?.employeeId) headers["X-Employee-Id"] = user.employeeId;
  if (user?.name) headers["X-User-Name"] = user.name;
  if (user?.role) headers["X-User-Role"] = user.role;
  const authToken = getAuthToken();
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  if (res.status === 401) {
    localStorage.removeItem(STORAGE_AUTH_TOKEN);
    localStorage.removeItem(STORAGE_USER);
    localStorage.removeItem(STORAGE_PERMISSIONS);
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || "Request failed");
  }
  return res.text();
}

export interface OrderItem {
  /** From API when order is loaded (for per-item void) */
  id?: string;
  productId: string;
  /** Price variant used (same SKU / inventory identity) */
  productPriceId?: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  subtotal: number;
  department: "Bar" | "Kitchen" | "LD";
  sentToDept?: boolean;
  /** Complimentary (free) item — tracked in UI and receipt */
  isComplimentary?: boolean;
  /** Staff ID who served this item (for commission) */
  servedBy?: string;
  /** Staff display name for served-by (UI only) */
  servedByName?: string;
  /** Guest note per item (e.g. no onions) */
  specialRequest?: string | null;
  /** Item was voided by manager */
  isVoided?: boolean;
  /** Manager name who voided (for receipt) */
  voidedByName?: string | null;
}

export interface Order {
  id: string;
  tableId: string;
  status: string;
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
  employeeId?: string;
  orderDate?: string;
}

export interface Branch {
  id: number;
  name: string;
  code: string;
  address?: string;
  active: boolean;
}

export const api = {
  auth: {
    verifyManager: (employeeId: string, password: string, opts?: { discountName?: string; discountId?: string; action?: "charge"; customerName?: string }) =>
      fetchApi<{ ok: boolean; managerName: string }>("/api/auth/verify-manager", {
        method: "POST",
        body: JSON.stringify({
          employeeId,
          password,
          discountName: opts?.discountName,
          discountId: opts?.discountId,
          action: opts?.action,
          customerName: opts?.customerName,
        }),
      }),
  },
  branches: {
    list: () => fetchApi<Branch[]>("/api/branches"),
  },
  charges: {
    list: (params?: { customerName?: string; status?: string; from?: string; to?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.customerName) q.set("customerName", params.customerName);
      if (params?.status) q.set("status", params.status);
      if (params?.from) q.set("from", params.from);
      if (params?.to) q.set("to", params.to);
      if (params?.limit) q.set("limit", String(params.limit));
      return fetchApi<ChargeTransaction[]>("/api/charges" + (q.toString() ? "?" + q.toString() : ""));
    },
    markPaid: (id: string, paidBy?: string, opts?: { paymentMethod?: string; shiftId?: string | number }) =>
      fetchApi<{ ok: boolean; collectionMethod?: string; shiftId?: number | null }>(`/api/charges/${id}/mark-paid`, {
        method: "PATCH",
        body: JSON.stringify({
          paidBy,
          paymentMethod: opts?.paymentMethod,
          shiftId: opts?.shiftId,
        }),
      }),
  },
  auditLogs: {
    list: (params?: { from?: string; to?: string; userId?: string; employeeId?: string; action?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.from) q.set("from", params.from);
      if (params?.to) q.set("to", params.to);
      if (params?.userId) q.set("userId", params.userId);
      if (params?.employeeId) q.set("employeeId", params.employeeId);
      if (params?.action) q.set("action", params.action);
      if (params?.limit) q.set("limit", String(params.limit));
      return fetchApi<Array<{
        id: number;
        userId: number | null;
        employeeId: string | null;
        userName: string | null;
        roleName: string | null;
        action: string;
        entityType: string | null;
        entityId: string | null;
        details: Record<string, unknown> | null;
        createdAt: string;
      }>>("/api/audit-logs?" + q.toString());
    },
  },
  dashboard: {
    stats: () =>
      fetchApi<{
        todaysOrders: number;
        todaysSales: number;
        todaysLdSales: number;
        openTables: number;
        pendingOrders: number;
        myLd?: {
          ldCountPaid: number;
          ldCountOpen: number;
          ldAmountPaid: number;
          ldCommission: number;
          ldIncentive: number;
          commissionRate: number;
          incentiveRate: number;
        };
      }>("/api/dashboard/stats"),
    tables: () =>
      fetchApi<
        Array<{
          id: string;
          name: string;
          area: string;
          status: string;
          currentOrderId?: string;
          lockedByEmployeeId?: string;
          lockedByName?: string;
        }>
      >("/api/dashboard/tables"),
    createTable: (body: { name: string; area: string }) =>
      fetchApi<{ id: string; name: string; area: string; status: string; currentOrderId?: string }>("/api/dashboard/tables", { method: "POST", body: JSON.stringify(body) }),
    updateTable: (id: string, body: { name?: string; area?: string; status?: string }) =>
      fetchApi<{ id: string; name: string; area: string; status: string; currentOrderId?: string }>(`/api/dashboard/tables/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    deleteTable: (id: string) => fetchApi<{ ok: boolean }>(`/api/dashboard/tables/${id}`, { method: "DELETE" }),
  },
  pos: {
    tableSession: (tableId: string) =>
      fetchApi<{
        table: { id: string; name: string; area: string; status: string; currentOrderId?: string };
        orders: Array<Order & { orderNumber: string; items: OrderItem[]; voidedAt?: string | null; voidedByName?: string | null }>;
        tableStatus: string;
      }>(`/api/pos/tables/${tableId}/session`),
    claimTable: (tableId: string) =>
      fetchApi<{ ok: boolean; claimed: boolean; sessionId?: number }>(`/api/pos/tables/${tableId}/claim`, { method: "POST" }),
    releaseTable: (tableId: string) =>
      fetchApi<{ ok: boolean; released: boolean }>(`/api/pos/tables/${tableId}/release`, { method: "POST" }),
  },
  orders: {
    create: (body: { tableId: string; employeeId?: string; items: OrderItem[]; subtotal: number; tax: number; total: number }) =>
      fetchApi<{ ok: boolean; orderId: string; orderNumber: string }>("/api/orders", { method: "POST", body: JSON.stringify(body) }),
    addItems: (orderId: string, items: OrderItem[]) =>
      fetchApi<{ ok: boolean; subtotal: number; tax: number; total: number }>(`/api/orders/${orderId}/items`, { method: "POST", body: JSON.stringify({ items }) }),
    getByTable: (tableId: string) =>
      fetchApi<{
        orders: Array<Order & { orderNumber?: string; items: OrderItem[]; voidedAt?: string | null; voidedByName?: string | null }>;
        tableStatus: "available" | "occupied";
      }>(`/api/orders/table/${tableId}`),
    lookup: (orderNumber: string) =>
      fetchApi<{
        matches: Array<{
          orderId: string;
          orderNumber: string;
          tableId: string | null;
          tableName: string | null;
          area: string | null;
          status: string;
          voided: boolean;
        }>;
      }>(`/api/orders/lookup?orderNumber=${encodeURIComponent(orderNumber)}`),
    pay: (
      orderId: string,
      paymentMethodOrBody?:
        | string
        | {
            paymentMethod?: string;
            discountAmount?: number;
            customerName?: string;
            splits?: Array<{ amount: number; paymentMethod: string; customerName?: string }>;
            amountReceived?: number;
          }
    ) => {
      const body =
        typeof paymentMethodOrBody === "string" || paymentMethodOrBody == null
          ? { paymentMethod: paymentMethodOrBody }
          : paymentMethodOrBody;
      return fetchApi<{
        ok: boolean;
        total?: number;
        discount?: number;
        tax?: number;
        changeAmount?: number;
        amountReceived?: number;
      }>(`/api/orders/${orderId}/pay`, { method: "PATCH", body: JSON.stringify(body) });
    },
    void: (orderId: string, data: { employeeId: string; password: string; reason: string }) =>
      fetchApi<{ ok: boolean; voidedByName: string }>(`/api/orders/${orderId}/void`, { method: "POST", body: JSON.stringify(data) }),
    detail: (orderId: string) =>
      fetchApi<{
        id: string; orderNumber: string; table: string; area: string; employee: string;
        subtotal: number; discount: number; tax: number; total: number;
        status: string; paymentMethod: string | null; createdAt: string; updatedAt: string;
        items: Array<{
          id: string; name: string; quantity: number; unitPrice: number; subtotal: number;
          discount: number; department: string; specialRequest: string | null;
          isComplimentary: boolean; isVoided: boolean; servedByName: string | null;
        }>;
      }>(`/api/orders/${orderId}/detail`),
    receiptSnapshot: (orderId: string) =>
      fetchApi<{
        id: string;
        orderId: string;
        paymentMethod: string | null;
        createdAt: string;
        receipt: {
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
        };
      }>(`/api/orders/${orderId}/receipt-snapshot`),
    /** Read-only final bill reprint from stored snapshot (audited). Cashier/Manager only. */
    reprintFinalBill: (orderId: string, source?: string) =>
      fetchApi<{
        ok: boolean;
        orderId: string;
        snapshotId: string;
        receipt: Record<string, unknown>;
      }>(`/api/orders/${orderId}/reprint-final-bill`, {
        method: "POST",
        body: JSON.stringify({ source: source || "pos" }),
      }),
    reprintFinalBills: (orderIds: string[], source?: string) =>
      fetchApi<{
        ok: boolean;
        receipts: Array<{ orderId: string; snapshotId: string; receipt: Record<string, unknown> }>;
      }>("/api/orders/reprint-final-bills", {
        method: "POST",
        body: JSON.stringify({ orderIds, source: source || "sales_report" }),
      }),
  },
  orderItems: {
    void: (itemId: string, data: { employeeId: string; password: string; reason: string }) =>
      fetchApi<{ ok: boolean; voidedByName: string }>(`/api/order-items/${itemId}/void`, { method: "PATCH", body: JSON.stringify(data) }),
    setComplimentary: (itemId: string, isComplimentary: boolean) =>
      fetchApi<{ ok: boolean; isComplimentary: boolean }>(`/api/order-items/${itemId}/complimentary`, { method: "PATCH", body: JSON.stringify({ isComplimentary }) }),
  },
  products: {
    list: (params?: { search?: string; category?: string; department?: string; area?: "Lounge" | "Club" | "LD" }) => {
      const q = new URLSearchParams();
      if (params?.search) q.set("search", params.search);
      if (params?.category) q.set("category", params.category);
      if (params?.department) q.set("department", params.department);
      if (params?.area) q.set("area", params.area);
      return fetchApi<
        Array<{
          id: string;
          sku: string;
          name: string;
          description?: string;
          category: string;
          sub_category?: string;
          department: string;
          price: number;
          priceId?: string | null;
          cost: number;
          commission: number;
          status: string;
          pricesByArea?: { Lounge?: number; Club?: number; LD?: number };
          prices?: Array<{
            id?: string | null;
            label: string;
            area?: string | null;
            price: number;
            effectiveFrom?: string | null;
            effectiveTo?: string | null;
            isDefault?: boolean;
          }>;
          priceVariants?: Array<{ id?: string | null; label: string; price: number; area?: string | null }>;
          stockQty?: number;
        }>
      >("/api/products?" + q.toString());
    },
    create: (body: {
      sku: string;
      name: string;
      description?: string;
      category?: string;
      sub_category?: string;
      department?: string;
      price?: number;
      cost?: number;
      commission?: number;
      status?: string;
      stockQty?: number;
      pricesByArea?: { Lounge?: number; Club?: number; LD?: number };
      prices?: Array<{
        label: string;
        area?: string | null;
        price: number;
        effectiveFrom?: string | null;
        effectiveTo?: string | null;
        isDefault?: boolean;
      }>;
    }) =>
      fetchApi<{
        id: string;
        sku: string;
        name: string;
        description?: string;
        category: string;
        sub_category?: string;
        department: string;
        price: number;
        cost: number;
        commission: number;
        status: string;
        pricesByArea?: Record<string, number>;
        prices?: unknown[];
        stockQty?: number;
      }>("/api/products", { method: "POST", body: JSON.stringify(body) }),
    update: (
      id: string,
      body: {
        sku: string;
        name: string;
        description?: string;
        category?: string;
        sub_category?: string;
        department?: string;
        price?: number;
        cost?: number;
        commission?: number;
        status?: string;
        stockQty?: number;
        pricesByArea?: { Lounge?: number; Club?: number; LD?: number };
        prices?: Array<{
          label: string;
          area?: string | null;
          price: number;
          effectiveFrom?: string | null;
          effectiveTo?: string | null;
          isDefault?: boolean;
        }>;
      }
    ) =>
      fetchApi<{
        id: string;
        sku: string;
        name: string;
        description?: string;
        category: string;
        sub_category?: string;
        department: string;
        price: number;
        cost: number;
        commission: number;
        status: string;
        pricesByArea?: Record<string, number>;
        prices?: unknown[];
        stockQty?: number;
      }>(`/api/products/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    setStatus: (id: string, status: string) => fetchApi<{ ok: boolean }>(`/api/products/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    delete: (id: string) => fetchApi<{ ok: boolean }>(`/api/products/${id}`, { method: "DELETE" }),
  },
  staff: {
    ldLadies: () =>
      fetchApi<Array<{ id: string; code: string; name: string }>>("/api/staff/ld-ladies"),
    roles: () =>
      fetchApi<Array<{ id: string; name: string }>>("/api/staff/roles"),
    list: () => fetchApi<Array<{ 
      id: string; code: string; name: string; nickname: string; type: string; 
      allowance: number; hourly: number; budget: number; commissionRate: number;
      incentiveRate: number; tableIncentive?: number; hasQuota?: boolean; quotaAmount?: number;
      hasLogin: boolean; status: string 
    }>>("/api/staff"),
    create: (body: { 
      code: string; name: string; nickname?: string; type?: string; allowance?: number; hourly?: number;
      budget?: number; commissionRate?: number; incentiveRate?: number; tableIncentive?: number;
      hasQuota?: boolean; quotaAmount?: number; password?: string 
    }) =>
      fetchApi<{ 
        id: string; code: string; name: string; nickname: string; type: string;
        allowance: number; hourly: number; budget: number; commissionRate: number;
        incentiveRate: number; tableIncentive: number; hasQuota: boolean; quotaAmount: number;
        hasLogin: boolean; status: string 
      }>("/api/staff", { method: "POST", body: JSON.stringify(body) }),
    setStatus: (id: string, status: "active" | "inactive") =>
      fetchApi<{ ok: boolean; status: string }>(`/api/staff/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }),
    delete: (id: string) => fetchApi<{ ok: boolean }>(`/api/staff/${id}`, { method: "DELETE" }),
    update: (id: string, body: { 
      code?: string; name?: string; nickname?: string; type?: string; allowance?: number; hourly?: number;
      budget?: number; commissionRate?: number; incentiveRate?: number; tableIncentive?: number;
      hasQuota?: boolean; quotaAmount?: number; status?: string 
    }) =>
      fetchApi<{ 
        id: string; code: string; name: string; nickname: string; type: string;
        allowance: number; hourly: number; budget: number; commissionRate: number;
        incentiveRate: number; tableIncentive: number; hasQuota: boolean; quotaAmount: number;
        hasLogin: boolean; status: string;
        autoRecompute?: { ok: boolean; from?: string; to?: string; computed?: number; error?: string } | null;
      }>(`/api/staff/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    resetPassword: (id: string, password: string) =>
      fetchApi<{ ok: boolean }>(`/api/staff/${id}/password`, { method: "PATCH", body: JSON.stringify({ password }) }),
  },
  discounts: {
    list: () => fetchApi<Array<{ id: string; name: string; type: string; category?: string | null; applicableTo: string; value: string; validFrom?: string | null; validTo?: string | null; status: string; creator: string }>>("/api/discounts"),
    create: (body: { name: string; type?: string; category?: string; applicableTo?: string; value: string; validFrom?: string; validTo?: string }) =>
      fetchApi<{ id: string; name: string; type: string; category?: string | null; applicableTo: string; value: string; validFrom?: string | null; validTo?: string | null; status: string; creator: string }>("/api/discounts", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: { name: string; type?: string; category?: string | null; applicableTo?: string; value: string; validFrom?: string | null; validTo?: string | null; status?: string }) =>
      fetchApi<{ id: string; name: string; type: string; category?: string | null; applicableTo: string; value: string; validFrom?: string | null; validTo?: string | null; status: string; creator: string }>(
        `/api/discounts/${id}`,
        { method: "PUT", body: JSON.stringify(body) }
      ),
    remove: (id: string) => fetchApi<{ ok: boolean }>(`/api/discounts/${id}`, { method: "DELETE" }),
    approve: (id: string) => fetchApi<{ ok: boolean }>(`/api/discounts/${id}/approve`, { method: "PATCH" }),
    reject: (id: string) => fetchApi<{ ok: boolean }>(`/api/discounts/${id}/reject`, { method: "PATCH" }),
  },
  reports: {
    sales: (
      from?: string,
      to?: string,
      dayStartHour?: number | null,
      filters?: { tableId?: string; waiterId?: string; sessionId?: string | number }
    ) => {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to || from || new Date().toISOString().slice(0, 10));
      if (dayStartHour != null && dayStartHour >= 0 && dayStartHour <= 23) q.set("dayStartHour", String(dayStartHour));
      if (filters?.tableId) q.set("tableId", filters.tableId);
      if (filters?.waiterId) q.set("waiterId", filters.waiterId);
      if (filters?.sessionId != null && String(filters.sessionId).trim() !== "") {
        q.set("sessionId", String(filters.sessionId));
      }
      return fetchApi<{
        list: Array<{
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
        }>;
        groups?: Array<{
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
          orders: Array<{
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
          }>;
        }>;
        summary: {
          totalOrders: number;
          totalSessions?: number;
          paidOrders?: number;
          totalSales: number;
          totalDiscounts: number;
          totalComplimentary: number;
          totalTax: number;
          totalCardSurcharge: number;
          openTabsCount?: number;
          openTabsTotal?: number;
        };
      }>("/api/reports/sales?" + q.toString());
    },
    products: (
      from?: string,
      to?: string,
      dayStartHour?: number | null,
      filters?: {
        sku?: string;
        category?: string;
        tableId?: string;
        sessionId?: string | number;
        sortBy?: "quantity" | "revenue" | "sku" | "name";
        sortDir?: "asc" | "desc";
      }
    ) => {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to || from || new Date().toISOString().slice(0, 10));
      if (dayStartHour != null && dayStartHour >= 0 && dayStartHour <= 23) q.set("dayStartHour", String(dayStartHour));
      if (filters?.sku) q.set("sku", filters.sku);
      if (filters?.category) q.set("category", filters.category);
      if (filters?.tableId) q.set("tableId", filters.tableId);
      if (filters?.sessionId != null && String(filters.sessionId).trim() !== "") {
        q.set("sessionId", String(filters.sessionId));
      }
      if (filters?.sortBy) q.set("sortBy", filters.sortBy);
      if (filters?.sortDir) q.set("sortDir", filters.sortDir);
      return fetchApi<{
        list: Array<{
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
        }>;
        summary: { totalSkus: number; totalQuantity: number; totalRevenue: number };
        definition?: string;
      }>("/api/reports/products?" + q.toString());
    },
    voids: (
      from?: string,
      to?: string,
      filters?: {
        staffId?: string;
        staffName?: string;
        product?: string;
        tableId?: string;
        q?: string;
      },
      dayStartHour?: number | null
    ) => {
      const params = new URLSearchParams();
      if (from) params.set("from", from);
      if (to) params.set("to", to || from || new Date().toISOString().slice(0, 10));
      if (dayStartHour != null && dayStartHour >= 0 && dayStartHour <= 23) params.set("dayStartHour", String(dayStartHour));
      if (filters?.staffId) params.set("staffId", filters.staffId);
      if (filters?.staffName) params.set("staffName", filters.staffName);
      if (filters?.product) params.set("product", filters.product);
      if (filters?.tableId) params.set("tableId", filters.tableId);
      if (filters?.q) params.set("q", filters.q);
      return fetchApi<{
        list: Array<{
          id: string;
          voidType: string;
          orderId: string | null;
          orderItemId: string | null;
          productId: string | null;
          productSku: string | null;
          productName: string;
          quantity: number;
          unitPrice: number;
          amount: number;
          tableId: string | null;
          tableName: string;
          tableArea: string | null;
          sessionId: number | null;
          voidedBy: string | null;
          voidedByName: string;
          voidedByEmployeeId: string | null;
          voidedAt: string | null;
          voidedAtDisplay: string;
          reason: string;
        }>;
        summary: { totalVoids: number; totalQuantity: number; totalAmount: number; listed?: number; truncated?: boolean; limit?: number };
      }>("/api/reports/voids?" + params.toString());
    },
    payroll: (from?: string, to?: string, dayStartHour?: number | null) => {
      const q = new URLSearchParams();
      if (from) q.set("from", from);
      if (to) q.set("to", to || from || new Date().toISOString().slice(0, 10));
      if (dayStartHour != null && dayStartHour >= 0 && dayStartHour <= 23) q.set("dayStartHour", String(dayStartHour));
      type PayrollRowApi = {
        id: string; employeeId: string; name: string; defaultAllowance: number; perHour: number;
        allowance: number; hours: number; commission: number; incentives: number; adjustments: number; deductions: number;
        total: number; netPayout: number; status: string; approvedBy: string | null;
        ldCount?: number; ldCountRealtime?: number; ldAmount?: number; timeIn?: string | null;
        incentivesBreakdown?: Array<{ title: string; amount: number }> | null;
        adjustmentsBreakdown?: Array<{ title: string; amount: number }> | null;
        deductionsBreakdown?: Array<{ title: string; amount: number }> | null;
      };
      return fetchApi<
        | PayrollRowApi[]
        | { rows: PayrollRowApi[]; totalLdQtyPaid?: number; totalLdQtyOpen?: number; totalLdQtyRealtime?: number; openLdTables?: Array<{ tableId: string; tableCode?: string; ldCount: number }> }
      >("/api/reports/payroll?" + q.toString());
    },
    updatePayout: (id: string, body: {
      incentives?: number;
      adjustments?: number;
      deductions?: number;
      incentivesBreakdown?: Array<{ title: string; amount: number }>;
      adjustmentsBreakdown?: Array<{ title: string; amount: number }>;
      deductionsBreakdown?: Array<{ title: string; amount: number }>;
    }) =>
      fetchApi<{ ok: boolean }>(`/api/reports/payroll/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    approvePayout: (id: string, approvedBy?: string) => fetchApi<{ ok: boolean }>(`/api/reports/payroll/${id}/approve`, { method: "PATCH", body: JSON.stringify({ approvedBy }) }),
    computePayouts: (from?: string, to?: string, dayStartHour?: number | null) => 
      fetchApi<{ ok: boolean; computed: number; results: Array<{ employeeId: string; name: string; allowance: number; commission: number; incentives: number; total: number; quotaReached: boolean }> }>(
        "/api/reports/payroll/compute", 
        {
          method: "POST",
          body: JSON.stringify({
            from,
            to,
            ...(dayStartHour != null && dayStartHour >= 0 && dayStartHour <= 23 ? { dayStartHour } : {}),
          }),
        }
      ),
    payrollById: (id: string) =>
      fetchApi<{
        id: string; userId: string; employeeId: string; name: string; perHour: number; periodFrom: string; periodTo: string;
        allowance: number; hours: number; commission: number; incentives: number; adjustments: number; deductions: number;
        gross: number; total: number; netPayout: number; status: string; approvedBy: string | null;
      }>(`/api/reports/payroll/${id}`),
    payrollLdByTable: (payoutId: string, opts?: { from?: string; to?: string; dayStartHour?: number | null }) => {
      const q = new URLSearchParams();
      if (opts?.from) q.set("from", opts.from);
      if (opts?.to) q.set("to", opts.to);
      if (opts?.dayStartHour != null && opts.dayStartHour >= 0 && opts.dayStartHour <= 23) {
        q.set("dayStartHour", String(opts.dayStartHour));
      }
      const qs = q.toString();
      return fetchApi<{
        name: string;
        totalLdAll: number;
        ownLdCount: number;
        incentiveRate: number;
        incentives: number;
        tables: Array<{ tableCode: string; ldCount: number }>;
      }>(`/api/reports/payroll/${payoutId}/ld-by-table${qs ? `?${qs}` : ""}`);
    },
    /** Save X/Z report (or other print) HTML to project prints folder — no "Save As" dialog */
    savePrint: (body: { type: string; html: string }) =>
      fetchApi<{ ok: boolean; filename?: string; path?: string }>("/api/reports/save-print", { method: "POST", body: JSON.stringify(body) }),
  },
  print: {
    printers: () =>
      fetchApi<{ printers: Array<{ name: string; isDefault?: boolean; displayName?: string; isNetwork?: boolean }>; error?: string }>("/api/print/printers"),
    addPrinter: (body: { name: string; interface: string; type?: string }) =>
      fetchApi<{ ok: boolean; message?: string; error?: string }>("/api/print/printers", { method: "POST", body: JSON.stringify(body) }),
    receipt: (
      receipt: {
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
        items: Array<{ name: string; quantity: number; subtotal: number; isComplimentary?: boolean }>;
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
      },
      printerName?: string | null
    ) =>
      fetchApi<{ ok: boolean; error?: string; fallback?: boolean }>("/api/print/receipt", {
        method: "POST",
        body: JSON.stringify({ receipt, printerName: printerName || undefined }),
      }),
    deptReceipt: (body: {
      dept: string;
      title: string;
      subtitle: string;
      items: Array<{ name: string; quantity: number; servedByName?: string; specialRequest?: string | null }>;
      table: string;
      area: string;
      encoder: string;
      orderNumber: string;
      date: string;
      time: string;
      printerName?: string | null;
    }) =>
      fetchApi<{ ok: boolean; error?: string; fallback?: boolean }>("/api/print/dept-receipt", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    orderSlip: (body: {
      orderId: string;
      table: string;
      area: string;
      waiter: string;
      date: string;
      time: string;
      subtotal: number;
      items: Array<{ name: string; quantity: number; subtotal: number; servedByName?: string | null; specialRequest?: string | null }>;
      printerName?: string | null;
      isReprint?: boolean;
    }) =>
      fetchApi<{ ok: boolean; error?: string }>("/api/print/order-slip", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    payslip: (payslip: {
      employeeId: string; name: string; periodFrom: string; periodTo: string;
      allowance: number; hours: number; perHour: number; commission: number; incentives: number;
      ldCount?: number;
      incentivesBreakdown?: Array<{ title: string; amount: number }>;
      adjustments: number;
      adjustmentsBreakdown?: Array<{ title: string; amount: number }>;
      deductions: number;
      deductionsBreakdown?: Array<{ title: string; amount: number }>;
      gross: number; netPayout: number; status: string; approvedBy?: string | null;
    }) => fetchApi<{ ok: boolean; error?: string; fallback?: boolean }>("/api/print/payslip", { method: "POST", body: JSON.stringify({ payslip }) }),
    runningBill: (body: Record<string, unknown>) =>
      fetchApi<{ ok: boolean; error?: string; fallback?: boolean }>("/api/print/running-bill", { method: "POST", body: JSON.stringify(body) }),
    receiptHtml: (receipt: Record<string, unknown>) => fetchPrintHtml("/api/print/receipt-html", { receipt }),
    runningBillHtml: (body: Record<string, unknown>) => fetchPrintHtml("/api/print/running-bill-html", body),
    orderSlipHtml: (body: Record<string, unknown>) => fetchPrintHtml("/api/print/order-slip-html", body),
    /** ESC/POS base64 for QZ Tray (browser → local USB thermal) */
    qzPayload: {
      receipt: (receipt: Record<string, unknown>) =>
        fetchApi<{ base64: string }>("/api/print/qz-payload/receipt", { method: "POST", body: JSON.stringify({ receipt }) }),
      deptReceipt: (body: Record<string, unknown>) =>
        fetchApi<{ base64: string }>("/api/print/qz-payload/dept-receipt", { method: "POST", body: JSON.stringify(body) }),
      orderSlip: (body: Record<string, unknown>) =>
        fetchApi<{ base64: string }>("/api/print/qz-payload/order-slip", { method: "POST", body: JSON.stringify(body) }),
      runningBill: (body: Record<string, unknown>) =>
        fetchApi<{ base64: string }>("/api/print/qz-payload/running-bill", { method: "POST", body: JSON.stringify(body) }),
      payslip: (payslip: Record<string, unknown>) =>
        fetchApi<{ base64: string }>("/api/print/qz-payload/payslip", { method: "POST", body: JSON.stringify({ payslip }) }),
    },
  },
  // ============================================================================
  // ATTENDANCE (TIME TRACKING)
  // ============================================================================
  attendance: {
    clockIn: (userId: string) =>
      fetchApi<{ id: number; userId: string; workDate: string; timeIn: string; timeOut: string | null; breakMinutes: number }>(
        "/api/attendance/clock-in",
        { method: "POST", body: JSON.stringify({ userId }) }
      ),
    clockOut: (userId: string) =>
      fetchApi<{ id: number; userId: string; workDate: string; timeIn: string; timeOut: string; breakMinutes: number }>(
        "/api/attendance/clock-out",
        { method: "POST", body: JSON.stringify({ userId }) }
      ),
    getToday: (userId: string) =>
      fetchApi<{ id: number; userId: string; workDate: string; timeIn: string; timeOut: string | null; breakMinutes: number } | null>(
        `/api/attendance/today?userId=${userId}`
      ),
    list: (params?: { userId?: string; from?: string; to?: string }) => {
      const q = new URLSearchParams();
      if (params?.userId) q.set("userId", params.userId);
      if (params?.from) q.set("from", params.from);
      if (params?.to) q.set("to", params.to || params.from || new Date().toISOString().slice(0, 10));
      return fetchApi<Array<{
        id: number; userId: string; employeeId: string; name: string;
        workDate: string; timeIn: string; timeOut: string | null; breakMinutes: number;
      }>>("/api/attendance?" + q.toString());
    },
  },
  // ============================================================================
  // SHIFT MANAGEMENT
  // ============================================================================
  shifts: {
    getCurrent: (userId: string) => 
      fetchApi<Shift | null>(`/api/shifts/current?userId=${userId}`),
    open: (userId: string, openingCash: number) =>
      fetchApi<Shift>("/api/shifts/open", { method: "POST", body: JSON.stringify({ userId, openingCash }) }),
    getSummary: (shiftId: string) =>
      fetchApi<ShiftSummary>(`/api/shifts/${shiftId}/summary`),
    close: (shiftId: string, data: { actualCash: number; cashCount?: CashCountItem[]; varianceReason?: string; notes?: string }) =>
      fetchApi<Shift>(`/api/shifts/${shiftId}/close`, { method: "POST", body: JSON.stringify(data) }),
    approve: (shiftId: string, approvedBy: string) =>
      fetchApi<Shift>(`/api/shifts/${shiftId}/approve`, { method: "POST", body: JSON.stringify({ approvedBy }) }),
    list: (params?: { userId?: string; status?: string; dateFrom?: string; dateTo?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.userId) q.set("userId", params.userId);
      if (params?.status) q.set("status", params.status);
      if (params?.dateFrom) q.set("dateFrom", params.dateFrom);
      if (params?.dateTo) q.set("dateTo", params.dateTo);
      if (params?.limit) q.set("limit", String(params.limit));
      return fetchApi<ShiftListItem[]>("/api/shifts?" + q.toString());
    },
  },
  // ============================================================================
  // PAYMENT CONVERSIONS (digital -> cash, e.g. pasahod)
  // ============================================================================
  conversions: {
    create: (data: { fromMethod: string; toMethod?: string; amount: number; notes?: string; shiftId?: number }) =>
      fetchApi<PaymentConversion>("/api/conversions", { method: "POST", body: JSON.stringify(data) }),
    list: (params?: { shiftId?: string; from?: string; to?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.shiftId) q.set("shiftId", params.shiftId);
      if (params?.from) q.set("from", params.from);
      if (params?.to) q.set("to", params.to);
      if (params?.limit) q.set("limit", String(params.limit));
      return fetchApi<PaymentConversion[]>("/api/conversions" + (q.toString() ? "?" + q.toString() : ""));
    },
  },
  // ============================================================================
  // REFUNDS
  // ============================================================================
  refunds: {
    create: (data: { orderId: number; originalPaymentMethod: string; refundAmount: number; refundMethod: string; reason: string; requestedBy: string; shiftId?: string }) =>
      fetchApi<Refund>("/api/refunds", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: { status: string; approvedBy?: string }) =>
      fetchApi<Refund>(`/api/refunds/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    list: (params?: { orderId?: string; status?: string; dateFrom?: string; dateTo?: string }) => {
      const q = new URLSearchParams();
      if (params?.orderId) q.set("orderId", params.orderId);
      if (params?.status) q.set("status", params.status);
      if (params?.dateFrom) q.set("dateFrom", params.dateFrom);
      if (params?.dateTo) q.set("dateTo", params.dateTo);
      return fetchApi<RefundListItem[]>("/api/refunds?" + q.toString());
    },
  },
  // ============================================================================
  // PAYMENT VOIDS
  // ============================================================================
  paymentVoids: {
    create: (data: { orderId: number; paymentMethod: string; voidedAmount: number; reason: string; requestedBy: string; shiftId?: string }) =>
      fetchApi<PaymentVoid>("/api/payment-voids", { method: "POST", body: JSON.stringify(data) }),
    update: (id: string, data: { status: string; approvedBy?: string }) =>
      fetchApi<PaymentVoid>(`/api/payment-voids/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  },
  // ============================================================================
  // SPLIT PAYMENTS
  // ============================================================================
  splitPayments: {
    create: (orderId: string, splits: Array<{ amount: number; paymentMethod: string }>) =>
      fetchApi<SplitPayment[]>("/api/split-payments", { method: "POST", body: JSON.stringify({ orderId, splits }) }),
    pay: (splitId: string, processedBy: string) =>
      fetchApi<SplitPayment>(`/api/split-payments/${splitId}/pay`, { method: "PUT", body: JSON.stringify({ processedBy }) }),
    getForOrder: (orderId: string) =>
      fetchApi<SplitPayment[]>(`/api/split-payments/${orderId}`),
  },
  // ============================================================================
  // TABLE TRANSFERS
  // ============================================================================
  tables: {
    payAll: (
      tableId: string,
      paymentMethod?: string,
      discountName?: string,
      discountAmount?: number,
      customerName?: string,
      splits?: Array<{ amount: number; paymentMethod: string; customerName?: string }>,
      extras?: { amountReceived?: number }
    ) =>
      fetchApi<{
        ok: boolean;
        orderIds: string[];
        orderNumbers?: string[];
        subtotal: number;
        discount: number;
        tax: number;
        total: number;
        cardSurcharge?: number;
        change?: number;
        amountReceived?: number;
      }>(
        `/api/tables/${tableId}/pay-all`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentMethod,
            discountName,
            discountAmount,
            customerName,
            splits,
            amountReceived: extras?.amountReceived,
          }),
        }
      ),
    /** Server-authoritative bill total (mirrors pay-all math) to prevent cashier-vs-server drift. */
    billPreview: (
      tableId: string,
      body: {
        paymentMethod?: string;
        discountAmount?: number;
        splits?: Array<{ amount: number; paymentMethod: string }>;
      }
    ) =>
      fetchApi<{
        subtotal: number;
        complimentary: number;
        discount: number;
        tax: number;
        serviceCharge: number;
        cardSurcharge: number;
        baseTotal: number;
        total: number;
      }>(`/api/tables/${tableId}/bill-preview`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    runningBillSnapshot: (tableId: string) =>
      fetchApi<{
        id: string;
        tableId: string;
        createdAt: string;
        receipt: Record<string, unknown>;
      }>(`/api/tables/${tableId}/running-bill-snapshot`),
    transfer: (data: { orderId?: string; fromTable: string; toTable: string; transferredBy: string; reason?: string; transferAll?: boolean }) =>
      fetchApi<{ ok: boolean; message: string; action?: "move" | "swap" }>("/api/tables/transfer", { method: "POST", body: JSON.stringify(data) }),
    merge: (data: { sourceOrderId: string; targetOrderId: string; transferredBy: string; reason?: string }) =>
      fetchApi<{ ok: boolean; message: string }>("/api/tables/merge", { method: "POST", body: JSON.stringify(data) }),
    getTransfers: (orderId: string) =>
      fetchApi<TableTransfer[]>(`/api/tables/transfers/${orderId}`),
  },
  // ============================================================================
  // WAITER TABLE ASSIGNMENTS
  // ============================================================================
  assignments: {
    /** Tables assigned to the currently logged-in waiter */
    getMyTables: () =>
      fetchApi<Array<{ id: string; name: string; area: string; status: string; currentOrderId?: string }>>(
        "/api/waiter/assigned-tables"
      ),
    /** All Staff users with their assigned tables (for manager UI) */
    getWaitersWithTables: () =>
      fetchApi<Array<{
        id: string;
        code: string;
        name: string;
        status: string;
        assignedTables: Array<{ tableId: string; tableName: string; area: string }>;
      }>>("/api/manager/waiters"),
    /** Replace all table assignments for a waiter */
    save: (waiterId: string, tableIds: string[]) =>
      fetchApi<{ ok: boolean; assigned: number }>("/api/manager/waiter-assignments", {
        method: "POST",
        body: JSON.stringify({ waiterId, tableIds }),
      }),
  },
  // ============================================================================
  // SETTINGS (business config — persisted in database)
  // ============================================================================
  settings: {
    /** Fetch all settings from DB as a key→value map. */
    get: () => fetchApi<Record<string, string>>("/api/settings"),
    /** Upsert one or more settings rows. */
    save: (data: Record<string, string>) =>
      fetchApi<{ ok: boolean }>("/api/settings", { method: "PUT", body: JSON.stringify(data) }),
  },
  database: {
    backup: () =>
      fetchApi<{ ok: boolean; filename: string; path: string }>("/api/database/backup", { method: "POST" }),
    listBackups: () =>
      fetchApi<Array<{ filename: string; size: number; createdAt: string; path: string }>>("/api/database/backups"),
  },
  system: {
    createShortcut: () =>
      fetchApi<{ ok: boolean; message: string }>("/api/system/create-shortcut", { method: "POST" }),
  },
};

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface Shift {
  id: number;
  user_id: number;
  shift_date: string;
  start_time: string;
  end_time: string | null;
  status: "open" | "closed" | "approved";
  opening_cash: number;
  total_cash_sales: number;
  total_card_sales: number;
  total_gcash_sales: number;
  total_bank_sales: number;
  total_refunds: number;
  total_voids: number;
  expected_cash: number;
  actual_cash: number | null;
  cash_variance: number | null;
  variance_reason: string | null;
  approved_by: number | null;
  approved_at: string | null;
  notes: string | null;
}

export interface ShiftListItem extends Shift {
  user_name: string;
}

export interface ShiftSummary {
  shift: Shift;
  sales: {
    cash: number;
    card: number;
    gcash: number;
    bank: number;
    charge?: number;
    total: number;
    tenderTotal?: number;
    transactionCount: number;
  };
  chargeCollections?: {
    cash: number;
    card: number;
    gcash: number;
    bank: number;
    total: number;
  };
  conversionCash?: number;
  refunds: number;
  voids: number;
  conversions?: Array<{ fromMethod: string; toMethod: string; amount: number; notes?: string; convertedBy?: string; convertedAt?: string }>;
  expectedCash: number;
}

export interface PaymentConversion {
  id: number;
  shiftId?: number;
  fromMethod: string;
  toMethod: string;
  amount: number;
  notes?: string;
  convertedBy?: string;
  convertedAt: string;
}

export interface ChargeTransaction {
  id: number;
  orderIds?: string;
  customerName: string;
  amount: number;
  status: "pending" | "paid" | "cancelled";
  collectionMethod?: string | null;
  shiftId?: number | null;
  chargedAt: string;
  paidAt?: string;
  chargedBy?: string;
  paidBy?: string;
  notes?: string;
}

export interface CashCountItem {
  denomination: string;
  quantity: number;
  subtotal: number;
}

export interface Refund {
  id: number;
  order_id: number;
  original_payment_method: string;
  refund_amount: number;
  refund_method: string;
  reason: string;
  status: "pending" | "approved" | "completed" | "rejected";
  requested_by: number;
  approved_by: number | null;
  shift_id: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface RefundListItem extends Refund {
  table_id: string;
  requested_by_name: string;
}

export interface PaymentVoid {
  id: number;
  order_id: number;
  payment_method: string;
  voided_amount: number;
  reason: string;
  status: "pending" | "approved" | "completed" | "rejected";
  requested_by: number;
  approved_by: number | null;
  shift_id: number | null;
  created_at: string;
  completed_at: string | null;
}

export interface SplitPayment {
  id: number;
  order_id: number;
  split_number: number;
  amount: number;
  payment_method: string;
  status: "pending" | "paid";
  paid_at: string | null;
  processed_by: number | null;
}

export interface TableTransfer {
  id: number;
  order_id: number;
  from_table: string;
  to_table: string;
  transfer_type: "move" | "merge" | "split";
  transferred_by: number;
  transferred_by_name: string;
  reason: string | null;
  created_at: string;
}
