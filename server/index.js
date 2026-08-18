/**
 * Rabbit Alley POS - API (MySQL)
 * Auth: POST /api/auth/login
 * Dashboard: GET /api/dashboard/stats, GET /api/dashboard/tables
 * Products: GET/POST/PUT/PATCH /api/products
 * Staff: GET/POST/PUT /api/staff
 * Discounts: GET/POST/PATCH /api/discounts
 * Reports: GET /api/reports/sales, GET /api/reports/payroll, PATCH approve
 * Print: POST /api/print/receipt
 */
import "dotenv/config";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { execFile } from "child_process";
import { promisify } from "util";
import express from "express";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
import cors from "cors";
import compression from "compression";
import bcrypt from "bcrypt";
import mysql from "mysql2/promise";
import ThermalPrinter from "node-thermal-printer";
import { buildCustomerReceipt, buildDeptChit, buildOrderSlip, buildRunningBill, buildPayslip } from "./lib/receiptEscPos.js";
import { printEscPosBuffer, resolvePrinterInterface } from "./lib/printToThermal.js";
import { buildCustomerReceiptHtml, buildRunningBillHtml, buildOrderSlipHtml } from "./lib/receiptBrowserHtml.js";
import {
  computePayslipGross,
  computePayslipNet,
  ensurePayoutsSchema,
  LATEST_PAYOUT_PER_USER_JOIN,
  latestPayoutPerUserParams,
  dedupePayrollRows,
} from "./lib/payrollTotals.js";
import { allocateOrderNumber, formatOrderDisplayNumber } from "./lib/orderNumbers.js";
import {
  normalizePaymentMethod,
  isCardPaymentMethod,
  getShiftTenderSales,
  getShiftChargeCollections,
} from "./lib/paymentMethods.js";
import {
  fetchOrderItemsByOrderIds,
  fetchPendingOrdersForTable,
  mapOrderHeaderRow,
} from "./lib/orderQueries.js";
import { getWaiterDayStats } from "./lib/waiterStats.js";
import { localDateString } from "./lib/localDate.js";
import {
  buildTimestampDayFilter,
  buildRevenueDayAndCreatedFilter,
  preferredPayoutPeriod,
  operationalExclusiveEndDate,
  REVENUE_DAY_SESSION_JOIN,
} from "./lib/revenueDay.js";
import {
  ensureTableSessionsSchema,
  ensureSessionForOrder,
  closeOpenSessionForTable,
  vacateTableIfIdle,
  transferOpenSession,
  swapOpenSessions,
  mergeSessions,
  migrateLegacySessions,
  attachOrderToSession,
  getOpenSession,
  claimTableForWaiter,
  assertWaiterOwnsTable,
  isFloorWaiter,
  releaseTableClaimIfIdle,
  closeStaleOpenSessionIfNeeded,
  appendLivePendingSessionFilter,
  fetchLivePendingOrderIds,
} from "./lib/tableSessions.js";
import {
  ensureProductPricingSchema,
  listPricesForProducts,
  filterApplicablePrices,
  resolvePriceFromVariants,
  replaceProductPrices,
  pricesFromLegacyPayload,
  pricesByAreaFromList,
  migrateProductPrices,
} from "./lib/productPricing.js";
import {
  ensureProductStockSchema,
  getStockMap,
  consumeStockForPaidOrderIds,
  restoreStockForPaidOrderIds,
  setStockQty,
  migrateProductStock,
} from "./lib/productStock.js";
import {
  ensureVoidLogSchema,
  logVoidsForOrderItems,
  logVoidsForOrder,
  logPaymentVoidForOrder,
  backfillLegacyVoids,
  normalizeVoidReason,
} from "./lib/voidLog.js";
import { createDatabaseBackup, listBackups } from "./lib/backup.js";

const INSECURE_AUTH_TOKEN_SECRET = "rabbit-alley-pos-change-this-secret";

const {
  DB_HOST = "localhost",
  DB_PORT = 3306,
  DB_USER = "root",
  DB_PASSWORD = "",
  DB_DATABASE = "rabbit_alley_pos",
  PORT = 8000,
  PRINTER_TYPE = "epson", // epson, star, etc
  PRINTER_INTERFACE = "", // Leave empty to auto-detect, or set like "\\\\localhost\\XP-K200L" or "tcp://192.168.1.100"
  PRINTER_TIMEOUT = "10000", // Socket timeout in ms for network printers (default 10s)
  AUTH_TOKEN_SECRET: AUTH_TOKEN_SECRET_ENV,
  AUTH_TOKEN_TTL_SECONDS = "43200",
  NODE_ENV,
} = process.env;

const isProduction = String(NODE_ENV || "").toLowerCase() === "production";
const AUTH_TOKEN_SECRET = String(AUTH_TOKEN_SECRET_ENV || "").trim();
if (!AUTH_TOKEN_SECRET || AUTH_TOKEN_SECRET === INSECURE_AUTH_TOKEN_SECRET) {
  if (isProduction) {
    console.error(
      "FATAL: AUTH_TOKEN_SECRET must be set to a strong unique value in production (server/.env). Refusing to start."
    );
    process.exit(1);
  }
  if (!AUTH_TOKEN_SECRET) {
    console.warn(
      "[Auth] AUTH_TOKEN_SECRET is not set. Using an insecure development default. Set AUTH_TOKEN_SECRET in server/.env before production."
    );
  } else {
    console.warn(
      "[Auth] AUTH_TOKEN_SECRET is still the insecure default. Set a unique secret in server/.env before production."
    );
  }
}
const resolvedAuthTokenSecret = AUTH_TOKEN_SECRET || INSECURE_AUTH_TOKEN_SECRET;

const printerOptions = { timeout: Math.max(3000, Number(PRINTER_TIMEOUT) || 10000) };

// Map PRINTER_TYPE env to node-thermal-printer type (epson = ESC/POS, works for most generic thermal printers)
const PRINTER_TYPES_MAP = {
  epson: ThermalPrinter.types.EPSON,
  star: ThermalPrinter.types.STAR,
  brother: ThermalPrinter.types.BROTHER,
  daruma: ThermalPrinter.types.DARUMA,
  tanca: ThermalPrinter.types.TANCA,
  custom: ThermalPrinter.types.CUSTOM,
};
const printerType = PRINTER_TYPES_MAP[String(PRINTER_TYPE || "epson").toLowerCase()] || ThermalPrinter.types.EPSON;

// Ethernet printing: set PRINTER_INTERFACE=tcp://IP:9100 in .env. No "printer" package required.
const isSystemPrinterInterface = String(PRINTER_INTERFACE || "").toLowerCase().startsWith("printer:");
function getPrinterDriver() {
  return null;
}

/** Get Windows printer list for Settings dropdown (PowerShell on Windows). Ethernet printer from .env is added separately. */
function getWindowsPrinterList() {
  if (process.platform === "win32") {
    try {
      const { execSync } = require("child_process");
      const out = execSync(
        'powershell -NoProfile -Command "Get-Printer | Select-Object -ExpandProperty Name"',
        { encoding: "utf8", timeout: 5000 }
      );
      const names = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      return names.map((name) => ({ name, isDefault: false }));
    } catch (e) {
      // ignore
    }
  }
  return [];
}

/** Parse PRINTER_INTERFACE: single value or comma-separated list (e.g. tcp://IP:9100,tcp://IP2:9100). Returns array of { interface, displayName }. */
function getEthernetPrintersFromEnv() {
  const raw = (PRINTER_INTERFACE || "").trim();
  if (!raw) return [];
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list
    .filter((iface) => iface.toLowerCase().startsWith("tcp://") || iface.toLowerCase().startsWith("socket://"))
    .map((iface) => ({
      interface: iface,
      displayName: iface.replace(/^socket:\/\//i, "").replace(/^tcp:\/\//i, ""),
    }));
}

const ethernetPrintersFromEnv = getEthernetPrintersFromEnv();
if (ethernetPrintersFromEnv.length > 0) {
  console.log("[Print] Ethernet printer(s) from .env →", ethernetPrintersFromEnv.map((p) => p.interface).join(", "));
}

const app = express();
app.use(compression()); // Compress all responses
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" })); // Limit request body size

/** Public API routes (no auth token required). All other /api/* require authentication. */
const PUBLIC_API_ROUTES = new Set(["POST /api/auth/login"]);

app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) return next();
  if (req.method === "OPTIONS") return next();
  const routeKey = `${req.method} ${req.path}`;
  if (PUBLIC_API_ROUTES.has(routeKey)) return next();
  return requireAuth(req, res, next);
});

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      port: Number(DB_PORT),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });
  }
  return pool;
}

/**
 * Run a query that uses oi.is_voided; if the column doesn't exist, re-run without it.
 * Returns the rows from whichever version succeeds.
 */
async function queryWithVoidFallback(db, sqlWithVoid, sqlWithout, params) {
  try {
    const [rows] = await db.execute(sqlWithVoid, params);
    return rows;
  } catch (e) {
    if (e.code === "ER_BAD_FIELD_ERROR") {
      const [rows] = await db.execute(sqlWithout, params);
      return rows;
    }
    throw e;
  }
}

/** MySQL DATE → 'YYYY-MM-DD' without UTC off-by-one (PH/local calendar day). */
function toSqlDateString(val) {
  if (val == null) return null;
  if (typeof val === "string") return val.slice(0, 10);
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(val).slice(0, 10);
}

/** Attribute LD order_items to a staff user (served_by = users.id, else order opener code). */
const PAYROLL_LD_STAFF_SQL = "(oi.served_by = ? OR (oi.served_by IS NULL AND o.employee_id = ?))";
/**
 * Paid LD always counts. Pending LD only counts while the table session is still open.
 * Leftover pending lines on a closed/vacated table are excluded (they never appear in Product sales).
 */
const PAYROLL_LD_STATUS_SQL = `(
  o.status = 'paid'
  OR (o.status = 'pending' AND (ts.id IS NULL OR ts.closed_at IS NULL))
)`;
/** Complimentary LD does not earn commission/incentive. */
const PAYROLL_LD_NON_COMP_SQL = "COALESCE(oi.is_complimentary, 0) = 0";
/** Whole-order voids — used only in queries that already have a voided_at fallback. */
const PAYROLL_LD_ORDER_NOT_VOID_SQL = "(o.voided_at IS NULL)";

/** Floor areas shown in Dashboard/POS and payroll LD breakdown (excludes LD room). */
const PAYROLL_FLOOR_AREAS_SQL = "'Lounge', 'Club'";

/** Normalize table codes for matching (KTV 1 / KTV1 / KTV_1 → KTV1). */
function normalizePayrollTableKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/_/g, "")
    .toUpperCase();
}

/**
 * Map an orders.table_id value to the current Dashboard/POS row.
 * Handles id/name drift, spacing, case, and re-added ids (e.g. C4 vs C4_<timestamp>).
 */
function resolvePosTableForOrderTableId(orderTableId, posTableRows) {
  const raw = String(orderTableId ?? "").trim();
  if (!raw || raw === "—") return null;

  const byId = new Map(posTableRows.map((pt) => [pt.id, pt]));
  if (byId.has(raw)) return byId.get(raw);

  const byExactName = posTableRows.filter((pt) => pt.name === raw);
  if (byExactName.length === 1) return byExactName[0];

  const norm = normalizePayrollTableKey(raw);
  const byNorm = posTableRows.filter(
    (pt) => normalizePayrollTableKey(pt.name) === norm || normalizePayrollTableKey(pt.id) === norm
  );
  if (byNorm.length === 1) return byNorm[0];

  const byLegacyId = posTableRows.filter((pt) => pt.id.startsWith(`${raw}_`));
  if (byLegacyId.length === 1) return byLegacyId[0];

  const lower = raw.toLowerCase();
  const byCase = posTableRows.filter(
    (pt) => pt.name.toLowerCase() === lower || pt.id.toLowerCase() === lower
  );
  if (byCase.length === 1) return byCase[0];

  return null;
}

/**
 * Merge pos_tables (Dashboard/POS master list) with per-staff LD counts from orders.
 * Table labels always come from the live pos_tables name, not legacy seed ids (C1/C2/C3).
 */
async function buildPayrollLdTableBreakdown(db, branchId, dateClause, dateParams, staffParams) {
  const tableRows = await queryWithVoidFallback(
    db,
    `SELECT COALESCE(o.table_id, '—') AS tableId,
            SUM(oi.quantity) AS ldCount
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ${REVENUE_DAY_SESSION_JOIN}
     WHERE o.branch_id = ? AND oi.department = 'LD'
       AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
       AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
       AND COALESCE(oi.is_voided,0) = 0
       AND ${PAYROLL_LD_NON_COMP_SQL}
       AND ${PAYROLL_LD_STAFF_SQL}
     GROUP BY o.table_id`,
    `SELECT COALESCE(o.table_id, '—') AS tableId,
            SUM(oi.quantity) AS ldCount
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ${REVENUE_DAY_SESSION_JOIN}
     WHERE o.branch_id = ? AND oi.department = 'LD'
       AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
       AND ${PAYROLL_LD_STAFF_SQL}
     GROUP BY o.table_id`,
    [branchId, ...dateParams, ...staffParams]
  );

  const ldByOrderTableId = new Map();
  for (const r of tableRows || []) {
    const id = String(r.tableId ?? r.tableid ?? "—");
    if (id === "—") continue;
    ldByOrderTableId.set(id, (ldByOrderTableId.get(id) || 0) + Number(r.ldCount ?? r.ldcount ?? 0));
  }

  const [posTableRows] = await db.execute(
    `SELECT id, name, area FROM pos_tables
     WHERE branch_id = ? AND area IN (${PAYROLL_FLOOR_AREAS_SQL})
     ORDER BY FIELD(area, 'Lounge', 'Club'), name`,
    [branchId]
  );

  const ldByPosTableId = new Map();
  const unmatched = new Map();

  for (const [orderTableId, ldCount] of ldByOrderTableId) {
    const resolved = resolvePosTableForOrderTableId(orderTableId, posTableRows);
    if (resolved) {
      ldByPosTableId.set(resolved.id, (ldByPosTableId.get(resolved.id) || 0) + ldCount);
    } else {
      unmatched.set(orderTableId, (unmatched.get(orderTableId) || 0) + ldCount);
    }
  }

  const tables = [];
  for (const pt of posTableRows) {
    const ldCount = ldByPosTableId.get(pt.id) || 0;
    if (ldCount <= 0) continue;
    tables.push({
      tableId: pt.id,
      tableCode: pt.name,
      area: pt.area,
      ldCount,
    });
  }

  for (const [orderTableId, ldCount] of unmatched) {
    if (ldCount <= 0) continue;
    tables.push({
      tableId: orderTableId,
      tableCode: orderTableId,
      area: null,
      ldCount,
    });
  }

  return tables;
}

/** Set table_visit_id to MIN(non-voided pending id) for all non-voided pending rows on a table (excludes voided orders to prevent session merge in reports). */
async function reconcileTableVisitIds(db, branchId, tableId) {
  if (!tableId) return;
  try {
    const session = await getOpenSession(db, branchId, tableId);
    const live = appendLivePendingSessionFilter(session);
    const [r] = await db.execute(
      `SELECT MIN(id) AS anchor FROM orders
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}`,
      [branchId, tableId, ...live.params]
    );
    const anchor = r[0]?.anchor != null ? Number(r[0].anchor) : null;
    if (anchor == null) return;
    await db.execute(
      `UPDATE orders SET table_visit_id = ?
       WHERE branch_id = ? AND table_id = ? AND status = 'pending' AND voided_at IS NULL
       ${live.sql}`,
      [anchor, branchId, tableId, ...live.params]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
  }
}

/** 4h gap on same table ⇒ new “visit” when table_visit_id was never stored (legacy rows). */
const LEGACY_SALES_VISIT_GAP_MS = 4 * 60 * 60 * 1000;
/** Paid rows farther apart than this are treated as separate sessions in the legacy (null visit-id) path. */
const PAID_SESSION_GAP_MS = 1 * 60 * 1000; // 1 min - proper visit-ids prevent merges; legacy null-row guard only
function toMs(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function assignSalesVisitGroupMeta(rows, legacyGapMs = LEGACY_SALES_VISIT_GAP_MS) {
  const needsLegacy = rows.filter((r) => r.tableId && (r.tableVisitId == null || r.tableVisitId === ""));
  const byTable = new Map();
  for (const r of needsLegacy) {
    const tk = String(r.tableId);
    if (!byTable.has(tk)) byTable.set(tk, []);
    byTable.get(tk).push(r);
  }
  for (const arr of byTable.values()) {
    arr.sort((a, b) => {
      const ta = toMs(a.time);
      const tb = toMs(b.time);
      if (ta !== tb) return ta - tb;
      return Number(a.id) - Number(b.id);
    });
    let anchor = Number(arr[0].id);
    arr[0]._legacyVisitAnchor = anchor;
    for (let i = 1; i < arr.length; i++) {
      const prevT = toMs(arr[i - 1].time);
      const curT = toMs(arr[i].time);
      const prevStatus = String(arr[i - 1].status || "").toLowerCase();
      const curStatus = String(arr[i].status || "").toLowerCase();
      const paidToPendingBoundary = prevStatus === "paid" && curStatus === "pending";
      const paidToPaidBoundary = prevStatus === "paid" && curStatus === "paid" && Math.max(0, curT - prevT) > PAID_SESSION_GAP_MS;
      if (curT - prevT > legacyGapMs || paidToPendingBoundary || paidToPaidBoundary) {
        anchor = Number(arr[i].id);
      }
      arr[i]._legacyVisitAnchor = anchor;
    }
  }

  for (const r of rows) {
    const tid = r.tableId != null && String(r.tableId).trim() !== "" ? String(r.tableId) : "";
    const tvRaw = r.tableVisitId;
    const tv = tvRaw != null && tvRaw !== "" ? Number(tvRaw) : NaN;
    const fallbackAnchor = r._legacyVisitAnchor != null ? Number(r._legacyVisitAnchor) : Number(r.id);
    const anchor = Number.isFinite(tv) && tv > 0 ? tv : fallbackAnchor;
    r._visitAnchor = anchor;
    r._visitBaseKey = tid ? `visit-${tid}-${anchor}` : `solo-${r.id}`;
  }

  // Final pass: split mixed status/timing buckets into deterministic per-session groups.
  const byBase = new Map();
  for (const r of rows) {
    const key = String(r._visitBaseKey || `solo-${r.id}`);
    if (!byBase.has(key)) byBase.set(key, []);
    byBase.get(key).push(r);
  }
  for (const [baseKey, arr] of byBase.entries()) {
    arr.sort((a, b) => {
      const aStatus = String(a.status || "").toLowerCase();
      const bStatus = String(b.status || "").toLowerCase();
      const aMs = aStatus === "paid" ? toMs(a.updatedAt) || toMs(a.time) : toMs(a.time);
      const bMs = bStatus === "paid" ? toMs(b.updatedAt) || toMs(b.time) : toMs(b.time);
      if (aMs !== bMs) return aMs - bMs;
      return Number(a.id) - Number(b.id);
    });
    let segment = 1;
    arr[0]._visitGroupKey = `${baseKey}-s${segment}`;
    for (let i = 1; i < arr.length; i++) {
      const prev = arr[i - 1];
      const cur = arr[i];
      const prevStatus = String(prev.status || "").toLowerCase();
      const curStatus = String(cur.status || "").toLowerCase();
      const prevMs = prevStatus === "paid" ? toMs(prev.updatedAt) || toMs(prev.time) : toMs(prev.time);
      const curMs = curStatus === "paid" ? toMs(cur.updatedAt) || toMs(cur.time) : toMs(cur.time);
      const gap = Math.max(0, curMs - prevMs);
      const statusChanged = prevStatus !== curStatus;
      const paidGapBoundary = prevStatus === "paid" && curStatus === "paid" && gap > PAID_SESSION_GAP_MS;
      const pendingGapBoundary = prevStatus === "pending" && curStatus === "pending" && gap > legacyGapMs;
      if (statusChanged || paidGapBoundary || pendingGapBoundary) {
        segment += 1;
      }
      cur._visitGroupKey = `${baseKey}-s${segment}`;
    }
  }
}

function row(r) {
  return r && typeof r === "object" ? Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), v])
  ) : r;
}

/** Normalize UI staff type into a valid web role. */
function normalizeStaffRoleName(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "administrator" || value === "admin") return "Administrator";
  if (value === "operations staff" || value === "operations_staff" || value === "cashier" || value === "bartender") {
    return "Operations Staff";
  }
  return "Staff";
}

async function getWebRoleIdByName(db, roleName) {
  const [roleRows] = await db.execute(
    "SELECT id FROM roles WHERE guard = 'web' AND LOWER(name) = LOWER(?) LIMIT 1",
    [roleName]
  );
  if (roleRows.length) return Number(roleRows[0].id);
  const [fallbackRows] = await db.execute(
    "SELECT id FROM roles WHERE guard = 'web' AND LOWER(name) = 'staff' LIMIT 1"
  );
  if (fallbackRows.length) return Number(fallbackRows[0].id);
  return 1;
}

/** Branch for multi-branch: only from authenticated session (never client headers). */
function getBranchId(req) {
  if (req.authUser?.branchId != null && String(req.authUser.branchId).trim()) {
    return String(req.authUser.branchId);
  }
  return "1";
}

function roundCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function base64UrlEncode(data) {
  return Buffer.from(data, "utf8").toString("base64url");
}

function base64UrlDecode(data) {
  return Buffer.from(String(data || ""), "base64url").toString("utf8");
}

function signToken(payloadBase64) {
  return crypto.createHmac("sha256", resolvedAuthTokenSecret).update(payloadBase64).digest("base64url");
}

function issueAuthToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(1800, Number(AUTH_TOKEN_TTL_SECONDS) || 43200);
  const payload = {
    ...claims,
    iat: now,
    exp: now + ttl,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = signToken(encoded);
  return `${encoded}.${signature}`;
}

function verifyAuthToken(token) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) {
    const err = new Error("Invalid auth token");
    err.status = 401;
    throw err;
  }
  const expected = signToken(encoded);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    const err = new Error("Invalid auth token");
    err.status = 401;
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    const err = new Error("Invalid auth token");
    err.status = 401;
    throw err;
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload?.sub || !payload?.exp || now >= Number(payload.exp)) {
    const err = new Error("Session expired");
    err.status = 401;
    throw err;
  }
  return payload;
}

async function getAuthenticatedUserById(db, userId) {
  const [rows] = await db.execute(
    `SELECT u.id, u.employee_id, u.name, u.branch_id, u.role_id, r.name AS role_name
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = ? AND u.active = 1 AND r.guard = 'web'
     LIMIT 1`,
    [userId]
  );
  if (!rows.length) {
    const err = new Error("Invalid session");
    err.status = 401;
    throw err;
  }
  const user = rows[0];
  const [permRows] = await db.execute(
    `SELECT p.name FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ?`,
    [user.role_id]
  );
  return {
    id: String(user.id),
    employeeId: user.employee_id,
    name: user.name,
    branchId: String(user.branch_id ?? 1),
    roleId: String(user.role_id),
    roleName: user.role_name,
    permissions: permRows.map((r) => String(r.name)),
  };
}

async function resolveAuthenticatedRequest(req) {
  if (req.authUser) return req.authUser;
  const authHeader = String(req.headers.authorization || "");
  if (!authHeader.startsWith("Bearer ")) {
    const err = new Error("Authentication required");
    err.status = 401;
    throw err;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  const claims = verifyAuthToken(token);
  const db = await getPool();
  const authUser = await getAuthenticatedUserById(db, claims.sub);

  if (claims.branchId && String(claims.branchId) !== authUser.branchId) {
    const err = new Error("Invalid session branch");
    err.status = 401;
    throw err;
  }
  const requestedBranch = req.headers["x-branch-id"] || req.query?.branchId;
  if (requestedBranch && String(requestedBranch).trim() && String(requestedBranch).trim() !== authUser.branchId) {
    const err = new Error("Cross-branch access denied");
    err.status = 403;
    throw err;
  }

  req.authUser = authUser;
  req.headers["x-user-id"] = authUser.id;
  req.headers["x-employee-id"] = authUser.employeeId;
  req.headers["x-user-name"] = authUser.name;
  req.headers["x-user-role"] = authUser.roleName;
  req.headers["x-branch-id"] = authUser.branchId;
  return authUser;
}

function authErrorResponse(res, err) {
  const status = Number(err?.status) || 500;
  if (status >= 500) {
    console.error("Auth middleware error:", err);
    return res.status(500).json({ error: "Authentication failed" });
  }
  return res.status(status).json({ error: err?.message || "Authentication failed" });
}

async function requireAuth(req, res, next) {
  try {
    await resolveAuthenticatedRequest(req);
    next();
  } catch (err) {
    authErrorResponse(res, err);
  }
}

function requireAnyPermission(...permissionNames) {
  return async (req, res, next) => {
    try {
      const authUser = await resolveAuthenticatedRequest(req);
      if (!permissionNames.length) return next();
      const hasPermission = permissionNames.some((name) => authUser.permissions.includes(name));
      if (!hasPermission) {
        return res.status(403).json({ error: `Missing permission: ${permissionNames.join(" or ")}` });
      }
      next();
    } catch (err) {
      authErrorResponse(res, err);
    }
  };
}

async function loadPosFinancialSettings(db) {
  const [rows] = await db.execute(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tax_rate','service_charge_mode','service_charge_value')"
  );
  const map = {};
  for (const r of rows || []) map[r.setting_key] = r.setting_value;
  return {
    taxRate: Math.max(0, Number(map.tax_rate ?? 0) || 0) / 100,
    serviceChargeMode: String(map.service_charge_mode || "percent") === "fixed" ? "fixed" : "percent",
    serviceChargeValue: Math.max(0, Number(map.service_charge_value ?? 0) || 0),
  };
}

function computeServiceCharge(baseAmount, settings) {
  const base = Math.max(0, Number(baseAmount) || 0);
  if (settings.serviceChargeMode === "fixed") return roundCurrency(settings.serviceChargeValue);
  return roundCurrency(base * (settings.serviceChargeValue / 100));
}

async function calculateOrderTotalsFromItems(db, orderId, settings = null) {
  const activeSettings = settings || await loadPosFinancialSettings(db);
  const rows = await queryWithVoidFallback(
    db,
    `SELECT COALESCE(SUM(CASE WHEN COALESCE(is_voided,0) = 0 THEN subtotal ELSE 0 END), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN COALESCE(is_voided,0) = 0 AND is_complimentary = 1 THEN subtotal ELSE 0 END), 0) AS complimentary
     FROM order_items WHERE order_id = ?`,
    `SELECT COALESCE(SUM(subtotal), 0) AS subtotal,
            COALESCE(SUM(CASE WHEN is_complimentary = 1 THEN subtotal ELSE 0 END), 0) AS complimentary
     FROM order_items WHERE order_id = ?`,
    [orderId]
  );
  const subtotal = roundCurrency(rows[0]?.subtotal ?? 0);
  const complimentary = roundCurrency(rows[0]?.complimentary ?? 0);
  const chargeable = Math.max(0, roundCurrency(subtotal - complimentary));
  const tax = roundCurrency(chargeable * activeSettings.taxRate);
  const serviceCharge = computeServiceCharge(chargeable, activeSettings);
  const total = roundCurrency(chargeable + tax + serviceCharge);
  return { subtotal, complimentary, chargeable, tax, serviceCharge, total };
}

async function updateOrderTotalsFromItems(db, orderId, settings = null) {
  const computed = await calculateOrderTotalsFromItems(db, orderId, settings);
  await db.execute(
    "UPDATE orders SET subtotal = ?, tax = ?, total = ?, updated_at = NOW() WHERE id = ?",
    [computed.subtotal, computed.tax, computed.total, orderId]
  );
  return computed;
}

/** Persist paid order money fields; includes service_charge / card_surcharge when columns exist. */
async function persistPaidOrderFinancials(db, {
  orderId,
  paymentMethod,
  discount = 0,
  tax = 0,
  serviceCharge = 0,
  cardSurcharge = 0,
  total,
}) {
  try {
    await db.execute(
      `UPDATE orders SET status = 'paid', payment_method = ?, discount = ?, tax = ?,
        service_charge = ?, card_surcharge = ?, total = ? WHERE id = ?`,
      [paymentMethod, discount, tax, serviceCharge, cardSurcharge, total, orderId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    await db.execute(
      `UPDATE orders SET status = 'paid', payment_method = ?, discount = ?, tax = ?, total = ? WHERE id = ?`,
      [paymentMethod, discount, tax, total, orderId]
    );
  }
}

/**
 * When a paid order is payment-voided, cancel or shrink matching pending charge/utang rows
 * so AR does not keep a bill that was reversed.
 */
async function reconcileChargesAfterPaymentVoid(db, branchId, orderId, orderTotal) {
  const oid = String(orderId);
  let charges;
  try {
    [charges] = await db.execute(
      `SELECT id, order_ids, amount, notes FROM charge_transactions
       WHERE branch_id = ? AND status = 'pending'
         AND FIND_IN_SET(?, REPLACE(COALESCE(order_ids, ''), ' ', '')) > 0`,
      [branchId, oid]
    );
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE" || e.code === "ER_BAD_FIELD_ERROR") return 0;
    throw e;
  }
  let touched = 0;
  for (const c of charges || []) {
    const ids = String(c.order_ids || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const remaining = ids.filter((id) => String(id) !== oid);
    const noteSuffix = " [cancelled/adjusted: payment void]";
    if (!remaining.length) {
      try {
        await db.execute(
          `UPDATE charge_transactions
           SET status = 'cancelled',
               notes = LEFT(CONCAT(COALESCE(notes, ''), ?), 255)
           WHERE id = ? AND branch_id = ?`,
          [noteSuffix, c.id, branchId]
        );
      } catch (e) {
        if (e.code === "ER_BAD_FIELD_ERROR" || e.code === "ER_TRUNCATED_WRONG_VALUE_FOR_FIELD" || e.code === "ER_WRONG_VALUE_FOR_TYPE") {
          // Older ENUM without cancelled — delete the orphan AR row
          await db.execute(`DELETE FROM charge_transactions WHERE id = ? AND branch_id = ? AND status = 'pending'`, [
            c.id,
            branchId,
          ]);
        } else throw e;
      }
    } else {
      const newAmount = Math.max(0, Math.round((Number(c.amount) - Number(orderTotal || 0)) * 100) / 100);
      await db.execute(
        `UPDATE charge_transactions
         SET order_ids = ?, amount = ?,
             notes = LEFT(CONCAT(COALESCE(notes, ''), ?), 255)
         WHERE id = ? AND branch_id = ?`,
        [remaining.join(","), newAmount, noteSuffix, c.id, branchId]
      );
    }
    touched += 1;
  }
  return touched;
}

async function sumShiftCashConversions(db, shiftId) {
  try {
    const [rows] = await db.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM payment_conversions
       WHERE shift_id = ? AND LOWER(to_method) = 'cash'`,
      [shiftId]
    );
    return Number(rows[0]?.total || 0);
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE" || e.code === "ER_BAD_FIELD_ERROR") return 0;
    throw e;
  }
}

async function resolveTableArea(db, branchId, tableId) {
  const [rows] = await db.execute(
    "SELECT area FROM pos_tables WHERE branch_id = ? AND id = ? LIMIT 1",
    [branchId, tableId]
  );
  return rows[0]?.area || null;
}

async function normalizeIncomingItems(db, area, incomingItems) {
  const productIds = Array.from(
    new Set(
      (Array.isArray(incomingItems) ? incomingItems : [])
        .map((item) => String(item?.productId || "").trim())
        .filter(Boolean)
    )
  );
  const productMap = new Map();
  if (productIds.length > 0) {
    const placeholders = productIds.map(() => "?").join(",");
    const [products] = await db.execute(
      `SELECT id, sku, name, department, price FROM products WHERE id IN (${placeholders})`,
      productIds
    );
    const pricesMap = await listPricesForProducts(db, productIds);
    // Legacy area prices fallback when product_prices empty
    let areaMap = {};
    try {
      const [apRows] = await db.execute(
        `SELECT product_id, area, price FROM product_area_prices WHERE product_id IN (${placeholders})`,
        productIds
      );
      for (const p of apRows || []) {
        const key = String(p.product_id);
        if (!areaMap[key]) areaMap[key] = {};
        areaMap[key][String(p.area)] = Number(p.price);
      }
    } catch (e) {
      if (e.code !== "ER_NO_SUCH_TABLE") throw e;
    }
    for (const p of products || []) {
      const key = String(p.id);
      const variants = pricesMap[key] || [];
      productMap.set(key, {
        id: key,
        sku: p.sku || null,
        name: p.name,
        department: p.department,
        basePrice: Number(p.price ?? 0),
        variants,
        areaPrices: areaMap[key] || {},
      });
    }
  }

  const normalized = [];
  for (const item of incomingItems || []) {
    const productId = String(item?.productId || "").trim();
    const product = productId ? productMap.get(productId) : null;
    const quantity = Math.max(1, parseInt(String(item?.quantity ?? 1), 10) || 1);
    const preferredPriceId = item?.productPriceId || item?.priceId || null;
    let productPriceId = null;
    let resolvedUnitPrice;
    if (product) {
      const chosen = resolvePriceFromVariants(product.variants, area, null, preferredPriceId);
      if (chosen) {
        resolvedUnitPrice = chosen.price;
        productPriceId = chosen.id;
      } else if (area && product.areaPrices[area] != null) {
        resolvedUnitPrice = Number(product.areaPrices[area]);
      } else {
        resolvedUnitPrice = product.basePrice;
      }
    } else {
      resolvedUnitPrice = Math.max(0, Number(item?.unitPrice ?? 0) || 0);
    }
    const gross = roundCurrency(quantity * resolvedUnitPrice);
    const requestedDiscount = Math.max(0, Number(item?.discount ?? 0) || 0);
    const discount = Math.min(gross, roundCurrency(requestedDiscount));
    const subtotal = roundCurrency(gross - discount);
    const name = String(product?.name || item?.name || "Item").trim().slice(0, 120);
    const specialRequest = item?.specialRequest && String(item.specialRequest).trim()
      ? String(item.specialRequest).trim().slice(0, 255)
      : null;
    const servedBy = item?.servedBy ? parseInt(String(item.servedBy), 10) : null;
    normalized.push({
      productId: product ? product.id : (productId || null),
      productSku: product?.sku || null,
      productPriceId,
      name,
      quantity,
      unitPrice: roundCurrency(resolvedUnitPrice),
      discount,
      subtotal,
      department: String(product?.department || item?.department || "Bar"),
      isComplimentary: !!item?.isComplimentary,
      servedBy: Number.isFinite(servedBy) ? servedBy : null,
      specialRequest,
    });
  }
  return normalized;
}

async function insertOrderItemRow(db, orderId, item) {
  try {
    await db.execute(
      `INSERT INTO order_items (order_id, product_id, product_sku, product_price_id, product_name, quantity, unit_price, discount, subtotal, department, sent_to_dept, is_complimentary, served_by, special_request)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      [
        orderId,
        item.productId || null,
        item.productSku || null,
        item.productPriceId || null,
        item.name,
        item.quantity,
        item.unitPrice,
        item.discount || 0,
        item.subtotal,
        item.department || "Bar",
        item.isComplimentary ? 1 : 0,
        item.servedBy,
        item.specialRequest,
      ]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    try {
      await db.execute(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, discount, subtotal, department, sent_to_dept, is_complimentary, served_by, special_request)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        [
          orderId,
          item.productId || null,
          item.name,
          item.quantity,
          item.unitPrice,
          item.discount || 0,
          item.subtotal,
          item.department || "Bar",
          item.isComplimentary ? 1 : 0,
          item.servedBy,
          item.specialRequest,
        ]
      );
    } catch (e2) {
      if (e2.code !== "ER_BAD_FIELD_ERROR") throw e2;
      await db.execute(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, discount, subtotal, department, sent_to_dept, is_complimentary, served_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          orderId,
          item.productId || null,
          item.name,
          item.quantity,
          item.unitPrice,
          item.discount || 0,
          item.subtotal,
          item.department || "Bar",
          item.isComplimentary ? 1 : 0,
          item.servedBy,
        ]
      );
    }
  }
}

async function loadReceiptSettingsMap(db) {
  const [rows] = await db.execute(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('business_name','business_address','business_contact','receipt_footer','vat_tin','tax_rate','service_charge_mode','service_charge_value','card_surcharge')"
  );
  const map = {};
  for (const r of rows || []) map[r.setting_key] = r.setting_value;
  return map;
}

function buildReceiptLabels(settingsMap) {
  const taxRatePct = Math.max(0, Number(settingsMap.tax_rate ?? 0) || 0);
  const serviceChargeMode = String(settingsMap.service_charge_mode || "percent") === "fixed" ? "fixed" : "percent";
  const serviceChargeValue = Math.max(0, Number(settingsMap.service_charge_value ?? 0) || 0);
  return {
    taxLabel: taxRatePct > 0 ? `VAT (${roundCurrency(taxRatePct)}%)` : "Tax",
    serviceLabel: serviceChargeMode === "fixed"
      ? `Service (Fixed ₱${serviceChargeValue.toFixed(2)})`
      : `Service (${roundCurrency(serviceChargeValue)}%)`,
  };
}

async function saveReceiptSnapshot(db, payload) {
  try {
    await db.execute(
      `INSERT INTO receipt_snapshots
        (branch_id, snapshot_type, order_id, table_id, table_visit_id, session_id, payment_method, receipt_json, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.branchId,
        payload.snapshotType,
        payload.orderId ?? null,
        payload.tableId ?? null,
        payload.tableVisitId ?? null,
        payload.sessionId ?? null,
        payload.paymentMethod ?? null,
        JSON.stringify(payload.receipt || {}),
        payload.createdBy ?? null,
      ]
    );
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") {
      console.warn("[receipt_snapshots] Table missing — official receipt not archived for reprint");
      return;
    }
    if (e.code === "ER_BAD_FIELD_ERROR") {
      try {
        await db.execute(
          `INSERT INTO receipt_snapshots
            (branch_id, snapshot_type, order_id, table_id, table_visit_id, payment_method, receipt_json, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.branchId,
            payload.snapshotType,
            payload.orderId ?? null,
            payload.tableId ?? null,
            payload.tableVisitId ?? null,
            payload.paymentMethod ?? null,
            JSON.stringify(payload.receipt || {}),
            payload.createdBy ?? null,
          ]
        );
      } catch (e2) {
        console.warn("[receipt_snapshots] Failed to save receipt snapshot:", e2.message);
      }
      return;
    }
    console.warn("[receipt_snapshots] Failed to save receipt snapshot:", e.message);
    throw e;
  }
}

async function resolveCurrentPayrollPeriod(db, branchId) {
  const [rows] = await db.execute(
    `SELECT p.period_from AS periodFrom, p.period_to AS periodTo
     FROM payouts p
     JOIN users u ON u.id = p.user_id
     WHERE u.branch_id = ?
     ORDER BY p.period_to DESC, p.period_from DESC
     LIMIT 1`,
    [branchId]
  );
  if (rows.length > 0) {
    return {
      fromDate: toSqlDateString(rows[0].periodFrom),
      toDate: toSqlDateString(rows[0].periodTo),
    };
  }
  const today = localDateString();
  return { fromDate: today, toDate: today };
}

/** LD lines on paid and open (pending) tabs count toward daily payroll — see PAYROLL_LD_* near top. */

async function computePayrollForPeriod(db, branchId, fromDate, toDate, dayStartHour = null) {
  const startHour =
    dayStartHour != null
      ? Math.min(23, Math.max(0, parseInt(String(dayStartHour), 10) || 0))
      : null;
  const { periodFrom, periodTo } = preferredPayoutPeriod(fromDate, toDate, startHour);
  const { sql: dateSql, params: dateParams } = buildRevenueDayAndCreatedFilter({
    startHour,
    fromDate,
    toDate,
    noSessionTsCol: "o.updated_at",
    noSessionDateCol: "o.order_date",
  });
  // dateSql already includes leading AND; strip for WHERE-first usage after JOINs
  const dateClause = dateSql.replace(/^\s*AND\s*/, "");

  const totalLdRows = await queryWithVoidFallback(
    db,
    `SELECT COALESCE(SUM(oi.quantity),0) AS totalLd
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ${REVENUE_DAY_SESSION_JOIN}
     WHERE o.branch_id = ? AND oi.department = 'LD'
       AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
       AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
       AND COALESCE(oi.is_voided,0) = 0
       AND ${PAYROLL_LD_NON_COMP_SQL}`,
    `SELECT COALESCE(SUM(oi.quantity),0) AS totalLd
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     ${REVENUE_DAY_SESSION_JOIN}
     WHERE o.branch_id = ? AND oi.department = 'LD'
       AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}`,
    [branchId, ...dateParams]
  );
  const totalLdAll = Number(totalLdRows[0]?.totalLd ?? 0);

  const [staffList] = await db.execute(
    `SELECT id, employee_id, name, allowance, hourly, budget, commission_rate, incentive_rate, table_incentive, has_quota, quota_amount
     FROM users WHERE active = 1 AND branch_id = ?`,
    [branchId]
  );

  const results = [];
  for (const staff of staffList) {
    const ldRows = await queryWithVoidFallback(
      db,
      `SELECT COALESCE(SUM(oi.quantity),0) AS ldCount,
              COALESCE(SUM(oi.subtotal),0) AS ldAmount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
        AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
         AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
         AND COALESCE(oi.is_voided,0) = 0
         AND ${PAYROLL_LD_NON_COMP_SQL}
         AND ${PAYROLL_LD_STAFF_SQL}`,
      `SELECT COALESCE(SUM(oi.quantity),0) AS ldCount,
              COALESCE(SUM(oi.subtotal),0) AS ldAmount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
        AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
         AND ${PAYROLL_LD_STAFF_SQL}`,
      [branchId, ...dateParams, staff.id, staff.employee_id]
    );

    const ldCount = Number(ldRows[0]?.ldCount || 0);
    const ldAmount = Number(ldRows[0]?.ldAmount || 0);
    const commissionRate = Number(staff.commission_rate || 0);
    const rate = Number(staff.incentive_rate || 0);
    const tableIncentiveRate = Number(staff.table_incentive || 0);
    const hasQuota = !!staff.has_quota;
    const quotaAmount = Number(staff.quota_amount || 0);
    const budget = Number(staff.budget || 0);

    // Distinct tables where this staff had LD (matches ld-by-table / Lounge+Club attribution).
    let tableCount = 0;
    try {
      const tableRows = await queryWithVoidFallback(
        db,
        `SELECT COUNT(DISTINCT o.table_id) AS tableCount
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         ${REVENUE_DAY_SESSION_JOIN}
         WHERE o.branch_id = ? AND oi.department = 'LD'
           AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
           AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
           AND COALESCE(oi.is_voided,0) = 0
           AND ${PAYROLL_LD_NON_COMP_SQL}
           AND ${PAYROLL_LD_STAFF_SQL}
           AND o.table_id IS NOT NULL AND o.table_id <> ''`,
        `SELECT COUNT(DISTINCT o.table_id) AS tableCount
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         ${REVENUE_DAY_SESSION_JOIN}
         WHERE o.branch_id = ? AND oi.department = 'LD'
           AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
           AND ${PAYROLL_LD_STAFF_SQL}
           AND o.table_id IS NOT NULL AND o.table_id <> ''`,
        [branchId, ...dateParams, staff.id, staff.employee_id]
      );
      tableCount = Number(tableRows[0]?.tableCount || tableRows[0]?.tablecount || 0);
    } catch (_) {
      tableCount = 0;
    }

    // Quota gates commission / incentives / table pay when enabled (target = LD sales amount).
    const quotaReached = !hasQuota || ldAmount + 0.009 >= quotaAmount;
    let commission = quotaReached ? ldCount * commissionRate : 0;
    let branchIncentives = quotaReached ? totalLdAll * rate : 0;
    let tablePay = quotaReached ? tableCount * tableIncentiveRate : 0;
    const incentives = branchIncentives + tablePay;

    const [existing] = await db.execute(
      `SELECT id, incentives_breakdown, adjustments, deductions FROM payouts
       WHERE user_id = ? AND period_from = ? AND period_to = ?
       ORDER BY id DESC LIMIT 1`,
      [staff.id, periodFrom, periodTo]
    );

    const otherSum = (() => {
      if (!existing.length || !existing[0].incentives_breakdown) return 0;
      try {
        const b = typeof existing[0].incentives_breakdown === "string" ? JSON.parse(existing[0].incentives_breakdown) : existing[0].incentives_breakdown;
        return Array.isArray(b) ? b.reduce((s, x) => s + Number(x.amount || 0), 0) : 0;
      } catch (_) { return 0; }
    })();
    const adjustments = existing.length ? Number(existing[0].adjustments ?? 0) : 0;
    const deductions = existing.length ? Number(existing[0].deductions ?? 0) : 0;
    const total = budget + commission + incentives + otherSum + adjustments - deductions;

    if (existing.length > 0) {
      await db.execute(
        `UPDATE payouts SET allowance = ?, hours = ?, commission = ?, incentives = ?, total = ?, status = 'draft' WHERE id = ?`,
        [budget, 0, commission, incentives, total, existing[0].id]
      );
    } else {
      await db.execute(
        `INSERT INTO payouts (user_id, period_from, period_to, allowance, hours, commission, incentives, incentives_breakdown, total, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
        [staff.id, periodFrom, periodTo, budget, 0, commission, incentives, JSON.stringify([]), total]
      );
    }

    results.push({
      employeeId: staff.employee_id,
      name: staff.name,
      allowance: budget,
      commission,
      ldCount,
      ldAmount,
      tableCount,
      tablePay,
      quotaReached,
      hasQuota,
      quotaAmount,
      incentives,
      total,
    });
  }
  return results;
}

/** Acting user identity: only from authenticated session (never client headers). */
function getActingUser(req) {
  if (req.authUser) {
    return {
      userId: req.authUser.id,
      employeeId: req.authUser.employeeId,
      userName: req.authUser.name,
      userRole: req.authUser.roleName,
    };
  }
  return {
    userId: null,
    employeeId: null,
    userName: null,
    userRole: null,
  };
}

/** Write audit log - fire and forget, never block main flow */
async function logAudit(req, action, entityType = null, entityId = null, details = null) {
  const { userId, employeeId, userName, userRole } = getActingUser(req);
  const branchId = getBranchId(req);
  const ip = req.ip || req.connection?.remoteAddress || null;
  try {
    const db = await getPool();
    await db.execute(
      `INSERT INTO audit_logs (user_id, employee_id, user_name, role_name, action, entity_type, entity_id, details, ip_address, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId ? parseInt(userId, 10) : null,
        employeeId || null,
        userName || null,
        userRole || null,
        action,
        entityType,
        entityId ? String(entityId) : null,
        details ? JSON.stringify(details) : null,
        ip,
        branchId,
      ]
    );
  } catch (err) {
    console.warn("Audit log write failed:", err.message);
  }
}

/** Log with explicit user (e.g. login - no headers yet) */
async function logAuditWithUser(db, user, action, entityType = null, entityId = null, details = null) {
  try {
    await db.execute(
      `INSERT INTO audit_logs (user_id, employee_id, user_name, role_name, action, entity_type, entity_id, details, branch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        user.id || null,
        user.employeeId || user.employee_id || null,
        user.name || null,
        user.roleName || user.role_name || null,
        action,
        entityType,
        entityId ? String(entityId) : null,
        details ? JSON.stringify(details) : null,
        user.branch_id || user.branchId || 1,
      ]
    );
  } catch (err) {
    console.warn("Audit log write failed:", err.message);
  }
}

// ---------- Audit Logs ----------
app.get("/api/audit-logs", requireAnyPermission("view_audit_logs"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, userId, employeeId, action, limit = "200" } = req.query || {};
  try {
    const db = await getPool();
    let sql = `SELECT a.id, a.user_id AS userId, a.employee_id AS employeeId, a.user_name AS userName,
      a.role_name AS roleName, a.action, a.entity_type AS entityType, a.entity_id AS entityId,
      a.details, a.created_at AS createdAt
      FROM audit_logs a WHERE a.branch_id = ?`;
    const params = [branchId];
    if (from) {
      sql += " AND DATE(a.created_at) >= ?";
      params.push(from);
    }
    if (to) {
      sql += " AND DATE(a.created_at) <= ?";
      params.push(to);
    }
    if (userId) {
      sql += " AND a.user_id = ?";
      params.push(userId);
    }
    if (employeeId) {
      sql += " AND a.employee_id = ?";
      params.push(employeeId);
    }
    if (action) {
      sql += " AND a.action = ?";
      params.push(action);
    }
    sql += " ORDER BY a.created_at DESC LIMIT ?";
    params.push(Math.min(parseInt(String(limit), 10) || 200, 500));
    const [rows] = await db.execute(sql, params);
    res.json(rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      employeeId: r.employeeId,
      userName: r.userName,
      roleName: r.roleName,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      details: r.details ? (typeof r.details === "string" ? JSON.parse(r.details) : r.details) : null,
      createdAt: r.createdAt?.toISOString?.() || r.createdAt,
    })));
  } catch (err) {
    console.error("Audit logs error:", err);
    res.status(500).json({ error: "Failed to load audit logs" });
  }
});

// ---------- Branches (multi-branch) ----------
app.get("/api/branches", requireAuth, async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      "SELECT id, name, code, address, active FROM branches WHERE active = 1 ORDER BY name"
    );
    res.json(rows.map((r) => ({ id: r.id, name: r.name, code: r.code, address: r.address ?? undefined, active: !!r.active })));
  } catch (err) {
    console.error("Branches list error:", err);
    res.status(500).json({ error: "Failed to list branches" });
  }
});

// ---------- Auth ----------
app.post("/api/auth/login", async (req, res) => {
  const { employeeId, password } = req.body || {};
  if (!employeeId || !password) {
    return res.status(400).json({ error: "Employee ID and password are required" });
  }
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id, u.name, u.email, u.password_hash, u.role_id, u.branch_id, r.name AS role_name, b.name AS branch_name, b.code AS branch_code
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.employee_id = ? AND u.active = 1 AND r.guard = 'web'`,
      [String(employeeId).trim().toUpperCase()]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Invalid Employee ID or Password" });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid Employee ID or Password" });
    const [permRows] = await db.execute(
      `SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [user.role_id]
    );
    const branchId = user.branch_id != null ? String(user.branch_id) : "1";
    logAuditWithUser(db, { id: user.id, employee_id: user.employee_id, name: user.name, role_name: user.role_name, branch_id: branchId }, "auth_login", "user", String(user.id));

    // Auto clock-in: create attendance record for today if none exists
    try {
      const today = localDateString();
      const now = new Date();
      const [existing] = await db.execute(
        "SELECT 1 FROM attendance WHERE user_id = ? AND work_date = ?",
        [user.id, today]
      );
      if (existing.length === 0) {
        await db.execute(
          "INSERT INTO attendance (user_id, work_date, time_in, break_minutes) VALUES (?, ?, ?, 0)",
          [user.id, today, now]
        );
      }
    } catch (attErr) {
      if (attErr.code !== "ER_NO_SUCH_TABLE") console.error("Auto clock-in error:", attErr);
    }

    const authToken = issueAuthToken({
      sub: String(user.id),
      branchId,
      roleId: String(user.role_id),
    });

    res.json({
      user: {
        id: String(user.id),
        employeeId: user.employee_id,
        name: user.name,
        email: user.email,
        role: user.role_name.toLowerCase().replace(/\s+/g, "_"),
        branchId,
        branchName: user.branch_name || "Main Branch",
        branchCode: user.branch_code || "MAIN",
      },
      permissions: permRows.map((r) => r.name),
      authToken,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Verify manager for discount or charge (must have approve_discounts)
app.post("/api/auth/verify-manager", requireAuth, async (req, res) => {
  const { employeeId, password, discountName, discountId, action, customerName } = req.body || {};
  if (!employeeId || !password) {
    return res.status(400).json({ error: "Employee ID and password are required" });
  }
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id, u.name, u.password_hash, u.role_id, u.branch_id
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.employee_id = ? AND u.active = 1 AND r.guard = 'web'`,
      [String(employeeId).trim().toUpperCase()]
    );
    if (rows.length === 0) return res.status(401).json({ error: "Invalid Employee ID or Password" });
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid Employee ID or Password" });
    const [permRows] = await db.execute(
      `SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
      [user.role_id]
    );
    const permissions = permRows.map((r) => r.name);
    if (!permissions.includes("approve_discounts")) {
      return res.status(403).json({ error: "Only a Manager can authorize this action" });
    }
    const [roleRows] = await db.execute("SELECT name FROM roles WHERE id = ?", [user.role_id]);
    const roleName = roleRows[0]?.name || null;
    const branchId = user.branch_id != null ? String(user.branch_id) : getBranchId(req);
    if (action === "charge") {
      if (!customerName || !String(customerName).trim()) return res.status(400).json({ error: "Customer name is required for Charge/Utang" });
      logAuditWithUser(db, { id: user.id, employee_id: user.employee_id, name: user.name, role_name: roleName, branch_id: branchId }, "charge_authorize", "charge", null, { customerName: String(customerName).trim(), authorizedBy: user.name });
    } else {
      logAuditWithUser(db, { id: user.id, employee_id: user.employee_id, name: user.name, role_name: roleName, branch_id: branchId }, "discount_apply_authorize", "discount", discountId || null, { discountName: discountName || null, authorizedBy: user.name });
    }
    res.json({ ok: true, managerName: user.name });
  } catch (err) {
    console.error("Verify manager error:", err);
    res.status(500).json({ error: "Verification failed" });
  }
});

// ---------- Dashboard ----------
app.get("/api/dashboard/stats", requireAnyPermission("view_dashboard", "manage_pos"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const today = localDateString();
    const [ordersCount] = await db.execute(
      "SELECT COUNT(*) AS c FROM orders WHERE branch_id = ? AND order_date = ?",
      [branchId, today]
    );
    const [salesSum] = await db.execute(
      "SELECT COALESCE(SUM(total), 0) AS s FROM orders WHERE branch_id = ? AND order_date = ? AND status = 'paid'",
      [branchId, today]
    );
    const [openTables] = await db.execute(
      "SELECT COUNT(*) AS c FROM pos_tables WHERE branch_id = ? AND status = 'available'",
      [branchId]
    );
    const [pendingOrders] = await db.execute(
      "SELECT COUNT(*) AS c FROM orders WHERE branch_id = ? AND order_date = ? AND status = 'pending'",
      [branchId, today]
    );
    let todaysLdSales = 0;
    {
      const ldRows = await queryWithVoidFallback(
        db,
        `SELECT COALESCE(SUM(oi.subtotal),0) AS s FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.branch_id = ? AND o.order_date = ? AND o.status = 'paid'
           AND oi.department = 'LD' AND COALESCE(oi.is_voided,0) = 0
           AND COALESCE(oi.is_complimentary,0) = 0`,
        `SELECT COALESCE(SUM(oi.subtotal),0) AS s FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.branch_id = ? AND o.order_date = ? AND o.status = 'paid'
           AND oi.department = 'LD'`,
        [branchId, today]
      );
      todaysLdSales = Number(ldRows[0]?.s ?? 0);
    }

    const payload = {
      todaysOrders: Number(ordersCount[0]?.c ?? 0),
      todaysSales: Number(salesSum[0]?.s ?? 0),
      todaysLdSales,
      openTables: Number(openTables[0]?.c ?? 0),
      pendingOrders: Number(pendingOrders[0]?.c ?? 0),
    };

    const actingUserId = req.authUser?.id;
    if (actingUserId) {
      const myLd = await getWaiterDayStats(db, branchId, actingUserId, today);
      if (myLd) payload.myLd = myLd;
    }

    res.json(payload);
  } catch (err) {
    console.error("Dashboard stats error:", err);
    res.status(500).json({ error: "Failed to load stats" });
  }
});

app.get("/api/dashboard/tables", requireAnyPermission("view_dashboard", "manage_pos", "create_orders"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT pt.id, pt.name, pt.area, pt.status, pt.current_order_id AS currentOrderId,
              ts.waiter_id AS lockedByEmployeeId,
              COALESCE(NULLIF(TRIM(u.nickname), ''), u.name) AS lockedByName
       FROM pos_tables pt
       LEFT JOIN table_sessions ts
         ON ts.branch_id = pt.branch_id AND ts.table_id = pt.id AND ts.status = 'open'
       LEFT JOIN users u
         ON u.branch_id = pt.branch_id AND UPPER(u.employee_id) = UPPER(ts.waiter_id)
       WHERE pt.branch_id = ?
       ORDER BY pt.area, pt.name`,
      [branchId]
    );
    res.json(
      rows.map((r) => ({
        ...r,
        id: r.id,
        currentOrderId: r.currentOrderId ?? undefined,
        lockedByEmployeeId: r.lockedByEmployeeId ?? undefined,
        lockedByName: r.lockedByName ?? undefined,
      }))
    );
  } catch (err) {
    console.error("Dashboard tables error:", err);
    res.status(500).json({ error: "Failed to load tables" });
  }
});

// ---------- Orders ----------
app.post("/api/dashboard/tables", requireAnyPermission("manage_settings"), async (req, res) => {
  const { name, area } = req.body || {};
  const branchId = getBranchId(req);
  if (!name?.trim() || !area) return res.status(400).json({ error: "Name and area required" });
  const nameTrim = String(name).trim();
  const validAreas = ["Lounge", "Club", "LD"];
  if (!validAreas.includes(area)) return res.status(400).json({ error: "Area must be Lounge, Club, or LD" });
  try {
    const db = await getPool();
    let id = nameTrim.replace(/\s+/g, "_").slice(0, 16) || "T";
    const [existing] = await db.execute(
      "SELECT id FROM pos_tables WHERE branch_id = ? AND id = ?",
      [branchId, id]
    );
    if (existing.length > 0) {
      id = id + "_" + Date.now();
    }
    await db.execute(
      "INSERT INTO pos_tables (branch_id, id, name, area, status) VALUES (?, ?, ?, ?, 'available')",
      [branchId, id, nameTrim, area]
    );
    const [rows] = await db.execute(
      "SELECT id, name, area, status, current_order_id AS currentOrderId FROM pos_tables WHERE branch_id = ? AND id = ?",
      [branchId, id]
    );
    res.status(201).json({ ...rows[0], currentOrderId: rows[0].currentOrderId ?? undefined });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Table name/ID already exists" });
    console.error("Add table error:", err);
    res.status(500).json({ error: "Failed to add table" });
  }
});

app.put("/api/dashboard/tables/:id", requireAnyPermission("manage_settings"), async (req, res) => {
  const { id } = req.params;
  const branchId = getBranchId(req);
  const { name, area, status } = req.body || {};
  try {
    const db = await getPool();
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push("name = ?"); params.push(String(name).trim()); }
    if (area !== undefined) { updates.push("area = ?"); params.push(area); }
    if (status !== undefined) { updates.push("status = ?"); params.push(status); }
    if (params.length) { params.push(branchId, id); await db.execute(`UPDATE pos_tables SET ${updates.join(", ")} WHERE branch_id = ? AND id = ?`, params); }
    const [rows] = await db.execute(
      "SELECT id, name, area, status, current_order_id AS currentOrderId FROM pos_tables WHERE branch_id = ? AND id = ?",
      [branchId, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Table not found" });
    res.json({ ...rows[0], currentOrderId: rows[0].currentOrderId ?? undefined });
  } catch (err) {
    console.error("Update table error:", err);
    res.status(500).json({ error: "Failed to update table" });
  }
});

app.delete("/api/dashboard/tables/:id", requireAnyPermission("manage_settings"), async (req, res) => {
  const { id } = req.params;
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      "SELECT id, status, current_order_id FROM pos_tables WHERE branch_id = ? AND id = ?",
      [branchId, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Table not found" });
    if (rows[0].status !== "available" || rows[0].current_order_id) {
      return res.status(400).json({ error: "Only available tables with no active order can be removed" });
    }
    await db.execute("DELETE FROM pos_tables WHERE branch_id = ? AND id = ?", [branchId, id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete table error:", err);
    res.status(500).json({ error: "Failed to delete table" });
  }
});

// ---------- Orders ----------
// Create a new order (when sending to departments)
app.post("/api/orders", requireAnyPermission("create_orders", "manage_pos"), async (req, res) => {
  const { tableId, employeeId, items } = req.body || {};
  const branchId = getBranchId(req);
  if (!tableId || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Table ID and items are required" });
  }
  let conn;
  try {
    const db = await getPool();
    if (isFloorWaiter(req.authUser)) {
      await assertWaiterOwnsTable(db, branchId, tableId, req.authUser.employeeId);
    }
    conn = await db.getConnection();
    await conn.beginTransaction();
    const orderDate = localDateString();
    const settings = await loadPosFinancialSettings(conn);
    // Check if this is the first order of a fresh seating (table was available)
    const [tableRow] = await conn.execute(
      "SELECT status, area FROM pos_tables WHERE branch_id = ? AND id = ? FOR UPDATE",
      [branchId, tableId]
    );
    if (!tableRow.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Table not found" });
    }
    const isFreshSeating = tableRow[0]?.status === 'available';

    const normalizedItems = await normalizeIncomingItems(conn, tableRow[0]?.area || null, items);
    if (!normalizedItems.length) {
      await conn.rollback();
      return res.status(400).json({ error: "No valid order items provided" });
    }
    const subtotal = roundCurrency(normalizedItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0));
    const complimentary = roundCurrency(
      normalizedItems.reduce((sum, item) => sum + (item.isComplimentary ? Number(item.subtotal || 0) : 0), 0)
    );
    const chargeable = Math.max(0, roundCurrency(subtotal - complimentary));
    const tax = roundCurrency(chargeable * settings.taxRate);
    const serviceCharge = computeServiceCharge(chargeable, settings);
    const total = roundCurrency(chargeable + tax + serviceCharge);

    let orderNumber = null;
    try {
      orderNumber = await allocateOrderNumber(conn, branchId, orderDate);
    } catch (seqErr) {
      if (seqErr.code !== "ER_NO_SUCH_TABLE") throw seqErr;
    }

    let orderResult;
    try {
      [orderResult] = await conn.execute(
        `INSERT INTO orders (branch_id, order_number, table_id, status, subtotal, discount, tax, total, employee_id, order_date)
         VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
        [branchId, orderNumber, tableId, subtotal || 0, tax || 0, total || 0, employeeId || null, orderDate]
      );
    } catch (insErr) {
      if (insErr.code !== "ER_BAD_FIELD_ERROR") throw insErr;
      [orderResult] = await conn.execute(
        `INSERT INTO orders (branch_id, table_id, status, subtotal, discount, tax, total, employee_id, order_date)
         VALUES (?, ?, 'pending', ?, 0, ?, ?, ?, ?)`,
        [branchId, tableId, subtotal || 0, tax || 0, total || 0, employeeId || null, orderDate]
      );
      orderNumber = null;
    }
    const orderId = orderResult.insertId;
    if (!orderNumber) orderNumber = String(orderId);

    // Open a new table session on fresh seating; otherwise attach to the open session.
    try {
      await ensureSessionForOrder(conn, {
        branchId,
        tableId,
        orderId,
        waiterId: employeeId || null,
        isFreshSeating,
      });
    } catch (sessErr) {
      if (sessErr.code === "ER_NO_SUCH_TABLE") {
        if (isFreshSeating) {
          try {
            await conn.execute(`UPDATE orders SET table_visit_id = ? WHERE id = ?`, [orderId, orderId]);
          } catch (e) {
            if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
          }
        } else {
          await reconcileTableVisitIds(conn, branchId, tableId);
        }
      } else {
        throw sessErr;
      }
    }

    for (const item of normalizedItems) {
      await insertOrderItemRow(conn, orderId, item);
    }
    // Stock is deducted only on payment (consumed/sold), not on punch.

    await conn.execute(
      "UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?",
      [String(orderId), branchId, tableId]
    );
    await conn.commit();
    await logAudit(req, "order_create", "order", orderId, { tableId, itemCount: normalizedItems.length, total });
    res.json({ ok: true, orderId: String(orderId), orderNumber, subtotal, tax, total });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error("Create order error:", err);
    res.status(500).json({ error: "Failed to create order" });
  } finally {
    if (conn) conn.release();
  }
});

// Add items to existing order (L2: allow adding after sent, until billed)
app.post("/api/orders/:id/items", requireAnyPermission("create_orders", "edit_orders_after_send", "manage_pos"), async (req, res) => {
  const { id } = req.params;
  const { items: newItems } = req.body || {};
  const branchId = getBranchId(req);
  if (!newItems || !Array.isArray(newItems) || newItems.length === 0) {
    return res.status(400).json({ error: "Items array is required" });
  }
  let conn;
  try {
    const db = await getPool();
    conn = await db.getConnection();
    await conn.beginTransaction();
    const [orders] = await conn.execute(
      "SELECT id, branch_id, status, table_id FROM orders WHERE id = ? FOR UPDATE",
      [id]
    );
    if (!orders.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Order not found" });
    }
    const ord = orders[0];
    if (String(ord.branch_id) !== branchId) {
      await conn.rollback();
      return res.status(403).json({ error: "Order belongs to another branch" });
    }
    if (ord.status === "paid") {
      await conn.rollback();
      return res.status(400).json({ error: "Cannot add items to paid order" });
    }

    const tableArea = await resolveTableArea(conn, branchId, ord.table_id);
    const normalizedItems = await normalizeIncomingItems(conn, tableArea, newItems);
    if (!normalizedItems.length) {
      await conn.rollback();
      return res.status(400).json({ error: "No valid items provided" });
    }
    const settings = await loadPosFinancialSettings(conn);

    for (const item of normalizedItems) {
      const [existing] = await conn.execute(
        "SELECT id, quantity, subtotal FROM order_items WHERE order_id = ? AND product_id = ? AND department = ? AND is_complimentary = ? AND (COALESCE(served_by,0) = COALESCE(?,0)) AND COALESCE(product_price_id,0) = COALESCE(?,0) LIMIT 1",
        [id, item.productId || null, item.department || "Bar", item.isComplimentary ? 1 : 0, item.servedBy, item.productPriceId || null]
      ).catch(async (e) => {
        if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
        return conn.execute(
          "SELECT id, quantity, subtotal FROM order_items WHERE order_id = ? AND product_id = ? AND department = ? AND is_complimentary = ? AND (COALESCE(served_by,0) = COALESCE(?,0)) LIMIT 1",
          [id, item.productId || null, item.department || "Bar", item.isComplimentary ? 1 : 0, item.servedBy]
        );
      });
      if (existing.length) {
        const oldSub = Number(existing[0].subtotal);
        const newQty = Number(existing[0].quantity) + item.quantity;
        await conn.execute(
          "UPDATE order_items SET quantity = ?, subtotal = ? WHERE id = ?",
          [newQty, roundCurrency(oldSub + Number(item.subtotal || 0)), existing[0].id]
        );
      } else {
        await insertOrderItemRow(conn, id, { ...item, name: item.name || "Item" });
      }
    }
    // Stock is deducted only on payment (consumed/sold), not on punch.
    const totals = await updateOrderTotalsFromItems(conn, id, settings);
    await conn.commit();
    await logAudit(req, "order_add_items", "order", id, { itemCount: normalizedItems.length });
    res.json({ ok: true, subtotal: totals.subtotal, tax: totals.tax, total: totals.total });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error("Add order items error:", err);
    res.status(500).json({ error: "Failed to add items to order" });
  } finally {
    if (conn) conn.release();
  }
});

// Find pending order by printed order number (for void / wrong-table lookup)
app.get("/api/orders/lookup", requireAnyPermission("view_orders", "manage_pos", "request_voids"), async (req, res) => {
  const branchId = getBranchId(req);
  const raw = String(req.query.orderNumber || req.query.q || "").trim();
  if (!raw) return res.status(400).json({ error: "orderNumber required" });
  try {
    const db = await getPool();
    const normalized = raw.replace(/^#/, "");
    let orders = [];
    if (/^\d+$/.test(normalized) && normalized.length <= 6) {
      const padded = normalized.padStart(4, "0");
      [orders] = await db.execute(
        `SELECT o.id, o.order_number, o.table_id, o.status, o.voided_at,
                t.name AS tableName, t.area
         FROM orders o
         LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
         WHERE o.branch_id = ? AND (
           o.order_number LIKE ? OR o.order_number LIKE ?
         )
         ORDER BY o.id DESC LIMIT 5`,
        [branchId, `%-${padded}`, `%-${normalized}`]
      );
    } else {
      [orders] = await db.execute(
        `SELECT o.id, o.order_number, o.table_id, o.status, o.voided_at,
                t.name AS tableName, t.area
         FROM orders o
         LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
         WHERE o.branch_id = ? AND (o.order_number = ? OR o.id = ?)
         ORDER BY o.id DESC LIMIT 5`,
        [branchId, normalized, normalized]
      );
    }
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    res.json({
      matches: orders.map((o) => ({
        orderId: String(o.id),
        orderNumber: formatOrderDisplayNumber(o),
        tableId: o.table_id,
        tableName: o.tableName,
        area: o.area,
        status: o.status,
        voided: !!o.voided_at,
      })),
    });
  } catch (err) {
    console.error("Order lookup error:", err);
    res.status(500).json({ error: "Failed to look up order" });
  }
});

// Get single order detail with all items (for Sales Report history view)
app.get("/api/orders/:orderId/detail", requireAnyPermission("view_orders", "manage_pos"), async (req, res) => {
  const { orderId } = req.params;
  const branchId = getBranchId(req);
  // Strip "ORD-" prefix if present (sales report formats IDs as ORD-XX)
  const numericId = String(orderId).replace(/^ORD-/i, "");
  try {
    const db = await getPool();
    let orders;
    try {
      [orders] = await db.execute(
        `SELECT o.id, o.order_number, t.name AS tableName, t.area,
                o.employee_id, u.name AS employee,
                o.subtotal, o.discount, o.tax, o.total,
                o.status, o.payment_method, o.created_at, o.updated_at
         FROM orders o
         LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
         LEFT JOIN users u ON u.employee_id = o.employee_id
         WHERE o.id = ? AND o.branch_id = ?`,
        [numericId, branchId]
      );
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
      [orders] = await db.execute(
        `SELECT o.id, t.name AS tableName, t.area,
                o.employee_id, u.name AS employee,
                o.subtotal, o.discount, o.tax, o.total,
                o.status, o.payment_method, o.created_at, o.updated_at
         FROM orders o
         LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
         LEFT JOIN users u ON u.employee_id = o.employee_id
         WHERE o.id = ? AND o.branch_id = ?`,
        [numericId, branchId]
      );
    }
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    const order = orders[0];
    const [items] = await db.execute(
      `SELECT oi.id, oi.product_name AS name, oi.quantity, oi.unit_price, oi.subtotal,
              oi.discount, oi.department, oi.special_request,
              oi.is_complimentary, oi.is_voided,
              u.name AS servedByName
       FROM order_items oi
       LEFT JOIN users u ON u.id = oi.served_by
       WHERE oi.order_id = ?
       ORDER BY oi.id`,
      [numericId]
    );
    const mappedItems = items.map((i) => ({
        id: String(i.id),
        name: i.name,
        quantity: Number(i.quantity),
        unitPrice: Number(i.unit_price),
        subtotal: Number(i.subtotal),
        discount: Number(i.discount ?? 0),
        department: i.department,
        specialRequest: i.special_request ?? null,
        isComplimentary: !!i.is_complimentary,
        isVoided: !!i.is_voided,
        servedByName: i.servedByName ?? null,
      }));
    const liveSubtotal = mappedItems
      .filter((i) => !i.isVoided)
      .reduce((s, i) => s + i.subtotal, 0);
    const liveComplimentary = mappedItems
      .filter((i) => !i.isVoided && i.isComplimentary)
      .reduce((s, i) => s + i.subtotal, 0);
    const liveChargeable = Math.max(0, liveSubtotal - liveComplimentary);
    res.json({
      id: "ORD-" + order.id,
      orderNumber: formatOrderDisplayNumber(order),
      table: order.tableName,
      area: order.area,
      employee: order.employee || order.employee_id || "—",
      subtotal: liveSubtotal,
      discount: Number(order.discount ?? 0),
      tax: Number(order.tax ?? 0),
      total: liveChargeable,
      status: order.status,
      paymentMethod: order.payment_method ?? null,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      items: mappedItems,
    });
  } catch (err) {
    console.error("Order detail error:", err);
    res.status(500).json({ error: "Failed to load order detail" });
  }
});

// Get latest immutable official receipt snapshot for an order (historical reprint source).
app.get("/api/orders/:orderId/receipt-snapshot", requireAnyPermission("view_orders", "print_receipts", "manage_pos"), async (req, res) => {
  const branchId = getBranchId(req);
  const numericId = String(req.params.orderId).replace(/^ORD-/i, "");
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT id, receipt_json AS receiptJson, payment_method AS paymentMethod, created_at AS createdAt
       FROM receipt_snapshots
       WHERE branch_id = ? AND order_id = ? AND snapshot_type = 'official_receipt'
       ORDER BY id DESC
       LIMIT 1`,
      [branchId, numericId]
    );
    if (!rows.length) return res.status(404).json({ error: "Receipt snapshot not found" });
    const snapshot = rows[0];
    let receipt = snapshot.receiptJson;
    if (typeof receipt === "string") {
      try { receipt = JSON.parse(receipt); } catch { receipt = null; }
    }
    if (!receipt || typeof receipt !== "object") return res.status(500).json({ error: "Stored receipt snapshot is invalid" });
    res.json({
      id: String(snapshot.id),
      orderId: String(numericId),
      paymentMethod: snapshot.paymentMethod || null,
      createdAt: snapshot.createdAt?.toISOString?.() || snapshot.createdAt,
      receipt,
    });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.status(404).json({ error: "Receipt snapshot not available on this database yet" });
    console.error("Order receipt snapshot error:", err);
    res.status(500).json({ error: "Failed to load receipt snapshot" });
  }
});

async function buildOfficialReceiptFromOrder(db, branchId, orderId) {
  const numericId = String(orderId).replace(/^ORD-/i, "");
  if (!/^\d+$/.test(numericId)) return null;

  let orders;
  try {
    [orders] = await db.execute(
      `SELECT o.id, o.order_number, o.table_id, o.table_visit_id, o.session_id,
              o.payment_method, o.subtotal, o.discount, o.tax, o.total, o.status,
              o.employee_id, o.updated_at, o.created_at,
              t.name AS tableName, t.area,
              u.name AS employeeName
       FROM orders o
       LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
       LEFT JOIN users u ON u.employee_id = o.employee_id AND u.branch_id = o.branch_id
       WHERE o.id = ? AND o.branch_id = ?`,
      [numericId, branchId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [orders] = await db.execute(
      `SELECT o.id, o.table_id, o.payment_method, o.subtotal, o.discount, o.tax, o.total, o.status,
              o.employee_id, o.updated_at, o.created_at,
              t.name AS tableName, t.area,
              u.name AS employeeName
       FROM orders o
       LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
       LEFT JOIN users u ON u.employee_id = o.employee_id AND u.branch_id = o.branch_id
       WHERE o.id = ? AND o.branch_id = ?`,
      [numericId, branchId]
    );
  }
  if (!orders.length) return null;
  const order = orders[0];
  if (String(order.status) !== "paid") return null;

  const itemRows = await queryWithVoidFallback(
    db,
    `SELECT oi.product_name AS name, oi.quantity, oi.subtotal, oi.department,
            oi.is_complimentary AS isComplimentary, COALESCE(oi.is_voided,0) AS isVoided,
            oi.voided_by_name AS voidedByName, oi.special_request AS specialRequest,
            u.name AS servedByName
     FROM order_items oi
     LEFT JOIN users u ON u.id = oi.served_by
     WHERE oi.order_id = ?
     ORDER BY oi.id`,
    `SELECT oi.product_name AS name, oi.quantity, oi.subtotal, oi.department,
            oi.is_complimentary AS isComplimentary, 0 AS isVoided,
            NULL AS voidedByName, NULL AS specialRequest,
            u.name AS servedByName
     FROM order_items oi
     LEFT JOIN users u ON u.id = oi.served_by
     WHERE oi.order_id = ?
     ORDER BY oi.id`,
    [numericId]
  );

  const items = (itemRows || []).map((rowItem) => {
    const servedBySuffix = rowItem.department === "LD" && rowItem.servedByName ? ` [${rowItem.servedByName}]` : "";
    const noteSuffix = rowItem.specialRequest ? ` - ${rowItem.specialRequest}` : "";
    const baseName = `${rowItem.name}${servedBySuffix}${noteSuffix}`;
    const displayName = rowItem.isVoided
      ? `${rowItem.name} (VOIDED${rowItem.voidedByName ? ` by ${rowItem.voidedByName}` : ""})`
      : baseName;
    return {
      name: displayName,
      quantity: Number(rowItem.quantity || 0),
      subtotal: rowItem.isVoided ? 0 : roundCurrency(Number(rowItem.subtotal || 0)),
      isComplimentary: !!rowItem.isComplimentary,
      note: rowItem.specialRequest || undefined,
    };
  });

  const receiptSettingsMap = await loadReceiptSettingsMap(db);
  const labels = buildReceiptLabels(receiptSettingsMap);
  const finSettings = await loadPosFinancialSettings(db);

  const orderSubtotal = roundCurrency(Number(order.subtotal || 0));
  const orderDiscount = roundCurrency(Number(order.discount || 0));
  const orderTax = roundCurrency(Number(order.tax || 0));
  const orderTotal = roundCurrency(Number(order.total || 0));
  const orderComplimentary = roundCurrency(
    items.reduce((sum, item) => sum + (item.isComplimentary ? Number(item.subtotal || 0) : 0), 0)
  );
  const taxableBase = Math.max(0, roundCurrency(orderSubtotal - orderComplimentary - orderDiscount));
  const payMethod = String(order.payment_method || "cash");
  const pm = payMethod.toLowerCase();

  let orderCardSurcharge = 0;
  if (pm === "credit" || pm === "debit") {
    const expectedService = computeServiceCharge(taxableBase, finSettings);
    orderCardSurcharge = Math.max(0, roundCurrency(orderTotal - taxableBase - expectedService - orderTax));
  }

  const orderService = roundCurrency(Math.max(0, orderTotal - taxableBase - orderTax - orderCardSurcharge));
  const paidAt = order.updated_at || order.created_at;
  const dt = paidAt ? new Date(paidAt) : new Date();
  const tableLabel =
    order.tableName && order.area
      ? `${order.area} - ${order.tableName}`
      : order.table_id
        ? String(order.table_id)
        : "—";

  const receipt = {
    orderNumber: formatOrderDisplayNumber(order),
    date: dt.toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
    time: dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
    table: tableLabel,
    cashier: order.employeeName || order.employee_id || "Staff",
    businessName: String(receiptSettingsMap.business_name || "").trim(),
    businessAddress: String(receiptSettingsMap.business_address || "").trim(),
    businessContact: String(receiptSettingsMap.business_contact || "").trim(),
    receiptFooter: String(receiptSettingsMap.receipt_footer || "").trim(),
    vatTin: String(receiptSettingsMap.vat_tin || "").trim(),
    serviceLabel: labels.serviceLabel,
    taxLabel: labels.taxLabel,
    items,
    subtotal: orderSubtotal,
    complimentary: orderComplimentary > 0 ? orderComplimentary : undefined,
    discount: orderDiscount > 0 ? orderDiscount : undefined,
    serviceCharge: orderService,
    tax: orderTax,
    cardSurcharge: orderCardSurcharge > 0 ? orderCardSurcharge : undefined,
    total: orderTotal,
    amountDue: orderTotal,
    paymentMethod: payMethod,
    amountPaid: orderTotal,
    change: 0,
    originalPaymentMethod: payMethod,
    isReprint: true,
  };

  return {
    id: `order-${numericId}`,
    orderId: String(numericId),
    paymentMethod: payMethod,
    createdAt: dt.toISOString?.() || String(dt),
    source: "order_reconstruction",
    receipt,
  };
}

async function loadOfficialReceiptSnapshot(db, branchId, orderId) {
  const numericId = String(orderId).replace(/^ORD-/i, "");
  try {
    const [rows] = await db.execute(
      `SELECT id, receipt_json AS receiptJson, payment_method AS paymentMethod, created_at AS createdAt
       FROM receipt_snapshots
       WHERE branch_id = ? AND order_id = ? AND snapshot_type = 'official_receipt'
       ORDER BY id DESC
       LIMIT 1`,
      [branchId, numericId]
    );
    if (rows.length) {
      const snapshot = rows[0];
      let receipt = snapshot.receiptJson;
      if (typeof receipt === "string") {
        try {
          receipt = JSON.parse(receipt);
        } catch {
          receipt = null;
        }
      }
      if (receipt && typeof receipt === "object") {
        const paymentMethod = receipt.paymentMethod || snapshot.paymentMethod || null;
        return {
          id: String(snapshot.id),
          orderId: String(numericId),
          paymentMethod,
          createdAt: snapshot.createdAt?.toISOString?.() || snapshot.createdAt,
          source: "snapshot",
          receipt: {
            ...receipt,
            paymentMethod,
            originalPaymentMethod: paymentMethod,
            isReprint: true,
          },
        };
      }
    }
  } catch (err) {
    if (err.code !== "ER_NO_SUCH_TABLE") throw err;
  }
  return buildOfficialReceiptFromOrder(db, branchId, numericId);
}

async function getOrderReprintStatus(db, branchId, orderId) {
  const numericId = String(orderId).replace(/^ORD-/i, "");
  if (!/^\d+$/.test(numericId)) return "invalid";
  const [rows] = await db.execute(
    "SELECT status FROM orders WHERE id = ? AND branch_id = ? LIMIT 1",
    [numericId, branchId]
  );
  if (!rows.length) return "not_found";
  return String(rows[0].status) === "paid" ? "paid" : "unpaid";
}

/**
 * Reprint Final Bill — read-only. Returns stored snapshot with isReprint flag.
 * Does not create transactions, deduct stock, or alter sales totals.
 * Cashier (print_receipts) or Manager (approve_discounts / manage_settings).
 */
app.post(
  "/api/orders/:orderId/reprint-final-bill",
  requireAnyPermission("print_receipts", "approve_discounts", "manage_settings", "view_reports", "manage_pos"),
  async (req, res) => {
    const branchId = getBranchId(req);
    const numericId = String(req.params.orderId).replace(/^ORD-/i, "");
    const source = String(req.body?.source || "api").slice(0, 64);
    try {
      const db = await getPool();
      const snap = await loadOfficialReceiptSnapshot(db, branchId, numericId);
      if (!snap) {
        const reprintStatus = await getOrderReprintStatus(db, branchId, numericId);
        if (reprintStatus === "unpaid") {
          return res.status(400).json({
            error: "Complete payment before reprinting the final bill",
            code: "ORDER_UNPAID",
          });
        }
        return res.status(404).json({
          error: "No final bill on file for this transaction",
          code: "ORDER_NOT_FOUND",
        });
      }
      await logAudit(req, "receipt_reprint", "order", numericId, {
        orderIds: [numericId],
        snapshotIds: snap.source === "snapshot" ? [snap.id] : [],
        reconstructed: snap.source === "order_reconstruction",
        source,
      });
      res.json({
        ok: true,
        orderId: snap.orderId,
        snapshotId: snap.id,
        receipt: snap.receipt,
      });
    } catch (err) {
      if (err.code === "ER_NO_SUCH_TABLE") {
        return res.status(404).json({ error: "Receipt snapshot not available on this database yet" });
      }
      console.error("Reprint final bill error:", err);
      res.status(500).json({ error: "Failed to prepare final bill reprint" });
    }
  }
);

/** Batch reprint for a paid session (multiple orders / tabs). */
app.post(
  "/api/orders/reprint-final-bills",
  requireAnyPermission("print_receipts", "approve_discounts", "manage_settings", "view_reports", "manage_pos"),
  async (req, res) => {
    const branchId = getBranchId(req);
    const orderIds = Array.isArray(req.body?.orderIds) ? req.body.orderIds : [];
    const source = String(req.body?.source || "api").slice(0, 64);
    const ids = orderIds
      .map((id) => String(id).replace(/^ORD-/i, ""))
      .filter((id) => id && /^\d+$/.test(id));
    if (!ids.length) return res.status(400).json({ error: "orderIds required" });
    try {
      const db = await getPool();
      const receipts = [];
      const snapshotIds = [];
      let reconstructedCount = 0;
      for (const id of ids) {
        const snap = await loadOfficialReceiptSnapshot(db, branchId, id);
        if (snap) {
          receipts.push({ orderId: snap.orderId, snapshotId: snap.id, receipt: snap.receipt });
          if (snap.source === "snapshot") snapshotIds.push(snap.id);
          else reconstructedCount += 1;
        }
      }
      if (!receipts.length) {
        const anyUnpaid = await Promise.all(
          ids.map((id) => getOrderReprintStatus(db, branchId, id))
        );
        if (anyUnpaid.some((s) => s === "unpaid")) {
          return res.status(400).json({
            error: "Complete payment before reprinting the final bill",
            code: "ORDER_UNPAID",
          });
        }
        return res.status(404).json({
          error: "No final bill on file for this transaction",
          code: "ORDER_NOT_FOUND",
        });
      }
      await logAudit(req, "receipt_reprint", "order", receipts.map((r) => r.orderId).join(","), {
        orderIds: receipts.map((r) => r.orderId),
        snapshotIds,
        reconstructedCount,
        source,
      });
      res.json({ ok: true, receipts });
    } catch (err) {
      if (err.code === "ER_NO_SUCH_TABLE") {
        return res.status(404).json({ error: "Receipt snapshot not available on this database yet" });
      }
      console.error("Batch reprint final bill error:", err);
      res.status(500).json({ error: "Failed to prepare final bill reprint" });
    }
  }
);

// Table + pending orders in one round trip (POS table order screen).
// Floor waiters may browse without locking — claim happens when they start adding items.
app.get("/api/pos/tables/:tableId/session", requireAnyPermission("view_orders", "create_orders", "manage_pos"), async (req, res) => {
  const { tableId } = req.params;
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    if (isFloorWaiter(req.authUser)) {
      await assertWaiterOwnsTable(db, branchId, tableId, req.authUser.employeeId);
      // Opening alone must not leave the table "In use". Clear a stale idle claim
      // (e.g. leftover from a previous session) so browse-and-back stays Available.
      await releaseTableClaimIfIdle(db, branchId, tableId, req.authUser.employeeId);
    }
    const [tableRows] = await db.execute(
      "SELECT id, name, area, status, current_order_id AS currentOrderId FROM pos_tables WHERE branch_id = ? AND id = ?",
      [branchId, tableId]
    );
    if (!tableRows.length) return res.status(404).json({ error: "Table not found" });
    const t = tableRows[0];
    const orders = await fetchPendingOrdersForTable(db, tableId, branchId);
    const orderIds = orders.map((o) => o.id);
    const itemsByOrder = await fetchOrderItemsByOrderIds(db, orderIds);
    const orderList = orders.map((o) =>
      mapOrderHeaderRow(o, itemsByOrder.get(String(o.id)) || [])
    );
    res.json({
      table: {
        id: t.id,
        name: t.name,
        area: t.area,
        status: t.status,
        currentOrderId: t.currentOrderId ?? undefined,
      },
      orders: orderList,
      tableStatus: orderList.length ? "occupied" : t.status,
    });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error("Table session error:", err);
    res.status(500).json({ error: "Failed to load table session" });
  }
});

/** POST — claim table when waiter starts adding items (not on open/browse). */
app.post("/api/pos/tables/:tableId/claim", requireAnyPermission("create_orders", "manage_pos"), async (req, res) => {
  const { tableId } = req.params;
  const branchId = getBranchId(req);
  if (!isFloorWaiter(req.authUser)) {
    return res.json({ ok: true, claimed: false });
  }
  try {
    const db = await getPool();
    const sessionId = await claimTableForWaiter(db, branchId, tableId, req.authUser.employeeId);
    res.json({ ok: true, claimed: true, sessionId });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 400) return res.status(400).json({ error: err.message });
    console.error("Table claim error:", err);
    res.status(500).json({ error: "Failed to claim table" });
  }
});

/** POST — release table claim when waiter backs out without sending orders */
app.post("/api/pos/tables/:tableId/release", requireAnyPermission("create_orders", "manage_pos"), async (req, res) => {
  const { tableId } = req.params;
  const branchId = getBranchId(req);
  if (!isFloorWaiter(req.authUser)) {
    return res.json({ ok: true, released: false });
  }
  try {
    const db = await getPool();
    const result = await releaseTableClaimIfIdle(db, branchId, tableId, req.authUser.employeeId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Table release error:", err);
    res.status(500).json({ error: "Failed to release table" });
  }
});

// Get ALL pending orders for table (multi-tab: each order = one tab)
app.get("/api/orders/table/:tableId", requireAnyPermission("view_orders", "manage_pos"), async (req, res) => {
  const { tableId } = req.params;
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const orders = await fetchPendingOrdersForTable(db, tableId, branchId);
    if (!orders.length) {
      return res.json({ orders: [], tableStatus: "available" });
    }
    const orderIds = orders.map((o) => o.id);
    const itemsByOrder = await fetchOrderItemsByOrderIds(db, orderIds);
    const orderList = orders.map((o) =>
      mapOrderHeaderRow(o, itemsByOrder.get(String(o.id)) || [])
    );
    res.json({ orders: orderList, tableStatus: "occupied" });
  } catch (err) {
    console.error("Get order error:", err);
    res.status(500).json({ error: "Failed to get order" });
  }
});

// Helper: verify manager (approve_discounts) and return { id, name }
async function verifyManagerForVoid(db, employeeId, password) {
  if (!employeeId || !password) throw new Error("Employee ID and password are required");
  const [rows] = await db.execute(
    `SELECT u.id, u.employee_id, u.name, u.password_hash, u.role_id
     FROM users u JOIN roles r ON r.id = u.role_id
     WHERE u.employee_id = ? AND u.active = 1 AND r.guard = 'web'`,
    [String(employeeId).trim().toUpperCase()]
  );
  if (rows.length === 0) throw new Error("Invalid Employee ID or Password");
  const user = rows[0];
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw new Error("Invalid Employee ID or Password");
  const [permRows] = await db.execute(
    `SELECT p.name FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`,
    [user.role_id]
  );
  const permissions = permRows.map((r) => r.name);
  const canVoid = permissions.includes("approve_voids") || permissions.includes("approve_discounts") || permissions.includes("manage_pos") || user.role_id === 1;
  if (!canVoid) throw new Error("Only a Manager can authorize void");
  return { id: user.id, name: user.name };
}

// Void entire order (manager auth required; reason required for void log)
app.post("/api/orders/:id/void", requireAnyPermission("request_voids", "approve_voids", "manage_pos"), async (req, res) => {
  const orderId = req.params.id;
  const branchId = getBranchId(req);
  const { employeeId, password, reason } = req.body || {};
  try {
    let reasonText;
    try {
      reasonText = normalizeVoidReason(reason);
    } catch (reasonErr) {
      return res.status(400).json({ error: reasonErr.message });
    }
    const db = await getPool();
    const manager = await verifyManagerForVoid(db, employeeId, password);
    const [orders] = await db.execute("SELECT id, branch_id, status, table_id FROM orders WHERE id = ?", [orderId]);
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    if (String(orders[0].branch_id) !== branchId) return res.status(403).json({ error: "Order belongs to another branch" });
    if (orders[0].status === "paid") return res.status(400).json({ error: "Cannot void paid order" });
    try {
      // Snapshot void log before clearing totals (pending voids do not touch stock).
      try {
        await logVoidsForOrder(db, {
          branchId,
          orderId,
          reason: reasonText,
          manager,
          employeeId: employeeId || null,
        });
      } catch (logErr) {
        if (logErr.code !== "ER_NO_SUCH_TABLE") throw logErr;
      }
      await db.execute(
        "UPDATE orders SET status = 'voided', voided_at = NOW(), voided_by = ?, voided_by_name = ?, subtotal = 0, discount = 0, tax = 0, total = 0 WHERE id = ?",
        [manager.id, manager.name, orderId]
      );
      await db.execute(
        "UPDATE order_items SET is_voided = 1, voided_by = ?, voided_at = NOW(), voided_by_name = ? WHERE order_id = ?",
        [manager.id, manager.name, orderId]
      );
      if (orders[0].table_id) {
        await reconcileTableVisitIds(db, branchId, orders[0].table_id);
        await vacateTableIfIdle(db, branchId, orders[0].table_id, {
          closedBy: manager.name || "void",
        });
      }
    } catch (e) {
      if (e.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ error: "Void not supported: run schema migration for void columns" });
      throw e;
    }
    res.json({ ok: true, voidedByName: manager.name });
  } catch (err) {
    if (err.message && (err.message.includes("Employee ID") || err.message.includes("Password") || err.message.includes("Manager") || err.message.includes("required"))) {
      return res.status(401).json({ error: err.message });
    }
    console.error("Order void error:", err);
    res.status(500).json({ error: err.message || "Failed to void order" });
  }
});

// Void single order item (manager auth required; reason required for void log)
app.patch("/api/order-items/:id/void", requireAnyPermission("request_voids", "approve_voids", "manage_pos"), async (req, res) => {
  const itemId = req.params.id;
  const branchId = getBranchId(req);
  const { employeeId, password, reason } = req.body || {};
  try {
    let reasonText;
    try {
      reasonText = normalizeVoidReason(reason);
    } catch (reasonErr) {
      return res.status(400).json({ error: reasonErr.message });
    }
    const db = await getPool();
    const manager = await verifyManagerForVoid(db, employeeId, password);
    const [items] = await db.execute(
      "SELECT oi.id, oi.order_id, o.subtotal, o.table_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ? AND o.branch_id = ?",
      [itemId, branchId]
    );
    if (!items.length) return res.status(404).json({ error: "Item not found" });
    try {
      try {
        await logVoidsForOrderItems(db, {
          branchId,
          orderItemIds: [itemId],
          voidType: "item",
          reason: reasonText,
          manager,
          employeeId: employeeId || null,
        });
      } catch (logErr) {
        if (logErr.code !== "ER_NO_SUCH_TABLE") throw logErr;
      }
      // Pending item voids do not touch stock (stock only moves on payment).
      await db.execute(
        "UPDATE order_items SET is_voided = 1, voided_by = ?, voided_at = NOW(), voided_by_name = ? WHERE id = ?",
        [manager.id, manager.name, itemId]
      );
      const orderId = items[0].order_id;
      const tableId = items[0].table_id;
      const settings = await loadPosFinancialSettings(db);
      await updateOrderTotalsFromItems(db, orderId, settings);

      // If every item on this order is now voided, treat like a full order void so
      // vacateTableIfIdle can free the table (it only skips orders with voided_at set).
      const [liveItems] = await db.execute(
        "SELECT id FROM order_items WHERE order_id = ? AND COALESCE(is_voided, 0) = 0 LIMIT 1",
        [orderId]
      );
      if (!liveItems.length) {
        try {
          await db.execute(
            "UPDATE orders SET status = 'voided', voided_at = NOW(), voided_by = ?, voided_by_name = ?, subtotal = 0, discount = 0, tax = 0, total = 0 WHERE id = ? AND voided_at IS NULL",
            [manager.id, manager.name, orderId]
          );
        } catch (e) {
          if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
        }
        if (tableId) {
          await reconcileTableVisitIds(db, branchId, tableId);
          await vacateTableIfIdle(db, branchId, tableId, {
            closedBy: manager.name || "void",
          });
        }
      }
    } catch (e) {
      if (e.code === "ER_BAD_FIELD_ERROR") return res.status(500).json({ error: "Void not supported: run schema migration for void columns" });
      throw e;
    }
    res.json({ ok: true, voidedByName: manager.name });
  } catch (err) {
    if (err.message && (err.message.includes("Employee ID") || err.message.includes("Password") || err.message.includes("Manager") || err.message.includes("required"))) {
      return res.status(401).json({ error: err.message });
    }
    console.error("Item void error:", err);
    res.status(500).json({ error: err.message || "Failed to void item" });
  }
});

// Set order item as complimentary (for cashier at bill-out)
app.patch("/api/order-items/:id/complimentary", requireAnyPermission("accept_payments", "approve_discounts", "manage_pos"), async (req, res) => {
  const itemId = req.params.id;
  const branchId = getBranchId(req);
  const { isComplimentary } = req.body || {};
  const value = !!isComplimentary;
  try {
    const db = await getPool();
    const [items] = await db.execute(
      "SELECT oi.id, oi.order_id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.id = ? AND o.branch_id = ?",
      [itemId, branchId]
    );
    if (!items.length) return res.status(404).json({ error: "Item not found" });
    await db.execute("UPDATE order_items SET is_complimentary = ? WHERE id = ?", [value ? 1 : 0, itemId]);
    const orderId = items[0].order_id;
    const settings = await loadPosFinancialSettings(db);
    await updateOrderTotalsFromItems(db, orderId, settings);
    res.json({ ok: true, isComplimentary: value });
  } catch (err) {
    console.error("Set complimentary error:", err);
    res.status(500).json({ error: "Failed to update item" });
  }
});

// Pay single order (same bill math as pay-all / bill-preview for one order)
app.patch("/api/orders/:id/pay", requireAnyPermission("accept_payments", "manage_pos"), async (req, res) => {
  const { id } = req.params;
  const branchId = getBranchId(req);
  const { paymentMethod, discountAmount, customerName, splits, amountReceived } = req.body || {};
  let conn;
  try {
    const db = await getPool();
    conn = await db.getConnection();
    await conn.beginTransaction();
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

    const [orders] = await conn.execute(
      "SELECT id, branch_id, table_id, status, subtotal, discount, tax, total, employee_id FROM orders WHERE id = ? FOR UPDATE",
      [id]
    );
    if (!orders.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Order not found" });
    }
    const order = orders[0];
    if (String(order.branch_id) !== String(branchId)) {
      await conn.rollback();
      return res.status(403).json({ error: "Order belongs to another branch" });
    }
    if (String(order.status) === "paid") {
      await conn.rollback();
      return res.status(400).json({ error: "Order already paid" });
    }

    let voidedAt = null;
    try {
      const [v] = await conn.execute("SELECT voided_at FROM orders WHERE id = ?", [id]);
      voidedAt = v[0]?.voided_at ?? null;
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    }
    if (voidedAt != null) {
      await conn.rollback();
      return res.status(400).json({ error: "Cannot pay a voided order" });
    }

    const isSplitPayment = Array.isArray(splits) && splits.length >= 2;
    const paymentMethodVal = isSplitPayment
      ? "split_payment"
      : normalizePaymentMethod(paymentMethod || "cash");
    const manualAmountPayment = !isSplitPayment && /^(cash|gcash|bank|debit|credit)$/i.test(paymentMethodVal);

    if (!isSplitPayment && paymentMethodVal === "charge") {
      const name = String(customerName || "").trim();
      if (!name) {
        await conn.rollback();
        return res.status(400).json({ error: "Customer name is required for Charge/Utang" });
      }
    }

    const billSettings = await loadBillSettings(conn);
    const posSettings = await loadPosFinancialSettings(conn);
    const fresh = await updateOrderTotalsFromItems(conn, id, posSettings);
    order.subtotal = fresh.subtotal;
    order.tax = fresh.tax;
    order.total = fresh.total;

    const complimentaryByOrder = await loadComplimentaryByOrder(conn, [id]);
    const bill = computeTableBillTotals({
      pending: [order],
      complimentaryByOrder,
      ...billSettings,
      discountAmount,
      isSplitPayment,
      paymentMethodVal,
      splits,
    });
    const {
      orderBases,
      totalBaseTotal,
      useAdjustedSplitMath,
      paidSum,
      combinedTotal,
    } = bill;

    if (isSplitPayment && paidSum <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: "Split payment total must be greater than zero" });
    }

    const validationExpected = useAdjustedSplitMath ? combinedTotal : totalBaseTotal;
    if (isSplitPayment && Math.abs(round2(paidSum) - round2(validationExpected)) >= 0.01) {
      await conn.rollback();
      return res.status(400).json({
        error: "Split payment amounts must exactly match computed total",
        expectedTotal: round2(validationExpected),
        paidSum: round2(paidSum),
      });
    }

    let changeAmount = 0;
    let receivedAmount = combinedTotal;
    if (manualAmountPayment && amountReceived != null && amountReceived !== "") {
      receivedAmount = round2(Number(amountReceived));
      if (!Number.isFinite(receivedAmount)) {
        await conn.rollback();
        return res.status(400).json({ error: "Payment amount is required" });
      }
      if (receivedAmount + 0.009 < combinedTotal) {
        await conn.rollback();
        return res.status(400).json({
          error: "Payment amount is less than amount due",
          amountDue: combinedTotal,
          amountReceived: receivedAmount,
        });
      }
      changeAmount = round2(Math.max(0, receivedAmount - combinedTotal));
    }

    const ob = orderBases[0];
    await persistPaidOrderFinancials(conn, {
      orderId: id,
      paymentMethod: paymentMethodVal,
      discount: ob.discount,
      tax: ob.tax,
      serviceCharge: ob.serviceCharge,
      cardSurcharge: ob.cardSurcharge,
      total: ob.total,
    });

    try {
      await consumeStockForPaidOrderIds(conn, [id]);
    } catch (stockErr) {
      if (stockErr.code !== "ER_NO_SUCH_TABLE") throw stockErr;
    }

    if (isSplitPayment) {
      try {
        await conn.execute(`DELETE FROM split_payments WHERE order_id = ?`, [id]);
        for (let i = 0; i < splits.length; i++) {
          await conn.execute(
            `INSERT INTO split_payments (order_id, split_number, amount, payment_method, status) VALUES (?, ?, ?, ?, 'paid')`,
            [id, i + 1, splits[i].amount, normalizePaymentMethod(splits[i].paymentMethod)]
          );
        }
      } catch (_splitErr) {
        // split_payments table may not exist — non-fatal
      }
    }

    if (paymentMethodVal === "charge" || (isSplitPayment && splits.some((s) => s.paymentMethod === "charge"))) {
      // Charge/utang rows are created by pay-all; keep single-order charge minimal — insert if table exists
      try {
        if (paymentMethodVal === "charge") {
          const { userName, employeeId: actingEmp } = getActingUser(req);
          await conn.execute(
            `INSERT INTO charge_transactions (branch_id, order_ids, customer_name, amount, status, charged_by)
             VALUES (?, ?, ?, ?, 'pending', ?)`,
            [branchId, String(id), String(customerName).trim(), ob.total, userName || actingEmp || null]
          );
        }
      } catch (e) {
        if (e.code !== "ER_NO_SUCH_TABLE" && e.code !== "ER_BAD_FIELD_ERROR") throw e;
      }
    }

    if (order.table_id) {
      await reconcileTableVisitIds(conn, branchId, order.table_id);
      const { userName, employeeId: actingEmp } = getActingUser(req);
      await vacateTableIfIdle(conn, branchId, order.table_id, {
        closedBy: userName || actingEmp || "pay",
      });
    }

    await conn.commit();
    await logAudit(req, "order_pay", "order", id, {
      paymentMethod: paymentMethodVal,
      tableId: order.table_id,
      total: ob.total,
      discount: ob.discount,
    });
    res.json({
      ok: true,
      total: ob.total,
      discount: ob.discount,
      tax: ob.tax,
      changeAmount,
      amountReceived: receivedAmount,
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error("Pay order error:", err);
    res.status(500).json({ error: "Failed to process payment" });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * Single source of truth for table bill math. Used by BOTH pay-all and bill-preview
 * so the amount the cashier sees, the amount collected, and the receipt always agree
 * to the centavo. Rounds tax/service per order exactly once (no cross-calculator drift).
 */
function computeTableBillTotals({
  pending,
  complimentaryByOrder = {},
  taxRate = 0,
  serviceChargeMode = "percent",
  serviceChargeValue = 0,
  cardSurchargeRate = 0,
  discountAmount = 0,
  isSplitPayment = false,
  paymentMethodVal = "cash",
  splits = [],
}) {
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const computePercentServiceCharge = (baseAmount) => round2(baseAmount * (serviceChargeValue / 100));

  const chargeableByOrder = pending.map((o) => {
    const chargeable = Math.max(0, Number(o.subtotal) - Number(complimentaryByOrder[String(o.id)] || 0));
    return { id: o.id, chargeable };
  });
  const totalChargeable = chargeableByOrder.reduce((s, o) => s + o.chargeable, 0);
  const requestedDiscount = Math.min(Math.max(0, Number(discountAmount) || 0), totalChargeable);
  const discountedChargeableTotal = Math.max(0, totalChargeable - requestedDiscount);
  const paidSum = isSplitPayment ? (splits || []).reduce((s, sp) => s + (Number(sp.amount) || 0), 0) : 0;

  const orderBases = [];
  let totalBaseTotal = 0;
  let tempDiscountRemaining = round2(requestedDiscount);

  for (let i = 0; i < pending.length; i++) {
    const o = pending[i];
    const chargeable = chargeableByOrder[i].chargeable;
    const proportionalDiscount = requestedDiscount > 0 && totalChargeable > 0
      ? round2((chargeable / totalChargeable) * requestedDiscount)
      : 0;
    const orderDiscount = i === pending.length - 1 ? Math.min(tempDiscountRemaining, chargeable) : Math.min(proportionalDiscount, chargeable);
    tempDiscountRemaining = round2(tempDiscountRemaining - orderDiscount);
    const taxableBase = Math.max(0, chargeable - orderDiscount);
    const orderService = serviceChargeMode === "fixed"
      ? (discountedChargeableTotal > 0 ? round2(serviceChargeValue * (taxableBase / discountedChargeableTotal)) : 0)
      : computePercentServiceCharge(taxableBase);
    const orderTax = round2(taxableBase * taxRate);
    const baseTotal = round2(taxableBase + orderService + orderTax);
    orderBases.push({ id: o.id, discount: orderDiscount, tax: orderTax, serviceCharge: orderService, baseTotal });
    totalBaseTotal = round2(totalBaseTotal + baseTotal);
  }

  let totalCardSurcharge = 0;
  let useAdjustedSplitMath = false;
  if (isSplitPayment) {
    const splitBaseTotalRaw = paidSum;
    const splitBaseTotalAdjusted = (splits || []).reduce((sum, sp) => {
      const amt = Number(sp.amount) || 0;
      const m = normalizePaymentMethod(sp.paymentMethod || "");
      if (isCardPaymentMethod(m)) return sum + (amt / (1 + cardSurchargeRate));
      return sum + amt;
    }, 0);
    useAdjustedSplitMath = Math.abs(totalBaseTotal - splitBaseTotalAdjusted) < Math.abs(totalBaseTotal - splitBaseTotalRaw);
    if (useAdjustedSplitMath) {
      totalCardSurcharge = (splits || []).reduce((sum, sp) => {
        const amt = Number(sp.amount) || 0;
        const m = normalizePaymentMethod(sp.paymentMethod || "");
        if (isCardPaymentMethod(m)) return sum + (amt - amt / (1 + cardSurchargeRate));
        return sum;
      }, 0);
    } else {
      totalCardSurcharge = (splits || []).reduce((sum, sp) => {
        const amt = Number(sp.amount) || 0;
        const m = normalizePaymentMethod(sp.paymentMethod || "");
        if (isCardPaymentMethod(m)) return sum + amt * cardSurchargeRate;
        return sum;
      }, 0);
    }
  } else if (isCardPaymentMethod(paymentMethodVal)) {
    totalCardSurcharge = totalBaseTotal * cardSurchargeRate;
  }
  totalCardSurcharge = round2(totalCardSurcharge);

  let cardSurchargeRemaining = round2(totalCardSurcharge);
  let computedCardSurcharge = 0;
  for (let i = 0; i < orderBases.length; i++) {
    const ob = orderBases[i];
    let orderCardSurcharge = 0;
    if (cardSurchargeRemaining > 0) {
      if (i === orderBases.length - 1) {
        orderCardSurcharge = cardSurchargeRemaining;
      } else {
        const proportional = totalBaseTotal > 0 ? round2((ob.baseTotal / totalBaseTotal) * totalCardSurcharge) : 0;
        orderCardSurcharge = Math.min(cardSurchargeRemaining, proportional);
      }
      cardSurchargeRemaining = round2(cardSurchargeRemaining - orderCardSurcharge);
    }
    ob.cardSurcharge = orderCardSurcharge;
    computedCardSurcharge += orderCardSurcharge;
    ob.total = round2(ob.baseTotal + orderCardSurcharge);
  }

  const orderComputedById = {};
  for (const ob of orderBases) {
    orderComputedById[String(ob.id)] = {
      discount: ob.discount,
      tax: ob.tax,
      serviceCharge: ob.serviceCharge,
      cardSurcharge: ob.cardSurcharge,
      total: ob.total,
    };
  }

  const combinedSubtotal = round2(pending.reduce((s, o) => s + Number(o.subtotal || 0), 0));
  const combinedComplimentary = round2(pending.reduce((s, o) => s + Number(complimentaryByOrder[String(o.id)] || 0), 0));
  const combinedDiscount = round2(orderBases.reduce((s, o) => s + Number(o.discount || 0), 0));
  const combinedTax = round2(orderBases.reduce((s, o) => s + Number(o.tax || 0), 0));
  const combinedServiceCharge = round2(orderBases.reduce((s, o) => s + Number(o.serviceCharge || 0), 0));
  const combinedCardSurcharge = round2(computedCardSurcharge);
  const combinedTotal = round2(orderBases.reduce((s, o) => s + Number(o.total || 0), 0));

  return {
    orderBases,
    orderComputedById,
    totalBaseTotal,
    totalCardSurcharge,
    useAdjustedSplitMath,
    paidSum,
    requestedDiscount,
    combinedSubtotal,
    combinedComplimentary,
    combinedDiscount,
    combinedTax,
    combinedServiceCharge,
    combinedCardSurcharge,
    combinedTotal,
  };
}

/** Load complimentary total per order (for bill math). */
async function loadComplimentaryByOrder(conn, pendingIds) {
  if (!pendingIds.length) return {};
  const placeholders = pendingIds.map(() => "?").join(",");
  const compRows = await queryWithVoidFallback(
    conn,
    `SELECT oi.order_id AS orderId,
            COALESCE(SUM(CASE WHEN oi.is_complimentary = 1 THEN oi.subtotal ELSE 0 END), 0) AS complimentary
     FROM order_items oi
     WHERE oi.order_id IN (${placeholders}) AND COALESCE(oi.is_voided,0) = 0
     GROUP BY oi.order_id`,
    `SELECT oi.order_id AS orderId,
            COALESCE(SUM(CASE WHEN oi.is_complimentary = 1 THEN oi.subtotal ELSE 0 END), 0) AS complimentary
     FROM order_items oi
     WHERE oi.order_id IN (${placeholders})
     GROUP BY oi.order_id`,
    pendingIds
  );
  return (compRows || []).reduce((acc, r) => {
    acc[String(r.orderId)] = Number(r.complimentary || 0);
    return acc;
  }, {});
}

/** Read financial settings used by bill math. */
async function loadBillSettings(conn) {
  const [settingsRows] = await conn.execute(
    "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tax_rate','service_charge_mode','service_charge_value','card_surcharge')"
  );
  const settingsMap = {};
  for (const row of settingsRows || []) settingsMap[row.setting_key] = row.setting_value;
  return {
    taxRate: Math.max(0, Number(settingsMap.tax_rate ?? 0) || 0) / 100,
    serviceChargeMode: String(settingsMap.service_charge_mode || "percent") === "fixed" ? "fixed" : "percent",
    serviceChargeValue: Math.max(0, Number(settingsMap.service_charge_value ?? 0) || 0),
    cardSurchargeRate: Math.max(0, Number(settingsMap.card_surcharge ?? 0) || 0) / 100,
  };
}

/**
 * Read-only preview of the exact amount pay-all would charge. Lets the POS display and
 * "Exact Amount" button use the server total, eliminating "amount less than due" drift.
 */
app.post("/api/tables/:tableId/bill-preview", requireAnyPermission("accept_payments", "manage_pos", "view_orders"), async (req, res) => {
  const { tableId } = req.params;
  const branchId = getBranchId(req);
  const { paymentMethod, discountAmount, splits } = req.body || {};
  try {
    const db = await getPool();
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const pending = await fetchPendingOrdersForTable(db, tableId, branchId);
    if (!pending.length) {
      // Read-only preview: an empty/settled table is not an error, just a zero bill.
      return res.json({
        subtotal: 0, complimentary: 0, discount: 0, tax: 0,
        serviceCharge: 0, cardSurcharge: 0, baseTotal: 0, total: 0,
      });
    }

    const isSplitPayment = Array.isArray(splits) && splits.length >= 2;
    const paymentMethodVal = isSplitPayment
      ? "split_payment"
      : normalizePaymentMethod(paymentMethod || "cash");
    const settings = await loadBillSettings(db);
    const posSettings = await loadPosFinancialSettings(db);
    for (const o of pending) {
      const fresh = await updateOrderTotalsFromItems(db, o.id, posSettings);
      o.subtotal = fresh.subtotal;
      o.tax = fresh.tax;
      o.total = fresh.total;
    }
    const complimentaryByOrder = await loadComplimentaryByOrder(db, pending.map((o) => o.id));
    const bill = computeTableBillTotals({
      pending,
      complimentaryByOrder,
      ...settings,
      discountAmount,
      isSplitPayment,
      paymentMethodVal,
      splits,
    });
    res.json({
      subtotal: bill.combinedSubtotal,
      complimentary: bill.combinedComplimentary,
      discount: bill.combinedDiscount,
      tax: bill.combinedTax,
      serviceCharge: bill.combinedServiceCharge,
      cardSurcharge: bill.combinedCardSurcharge,
      baseTotal: round2(bill.totalBaseTotal),
      total: bill.combinedTotal,
    });
  } catch (err) {
    console.error("Bill preview error:", err);
    res.status(500).json({ error: "Failed to compute bill preview" });
  }
});

// Pay ALL pending orders for a table (multi-tab: one bill for entire table)
app.post("/api/tables/:tableId/pay-all", requireAnyPermission("accept_payments", "manage_pos"), async (req, res) => {
  const { tableId } = req.params;
  const branchId = getBranchId(req);
  const { paymentMethod, discountName, discountAmount, customerName, splits, amountReceived } = req.body || {};
  let conn;
  try {
    const db = await getPool();
    conn = await db.getConnection();
    await conn.beginTransaction();
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    await closeStaleOpenSessionIfNeeded(conn, branchId, tableId);
    const openSessForPay = await getOpenSession(conn, branchId, tableId);
    const livePay = appendLivePendingSessionFilter(openSessForPay);
    let pending;
    try {
      [pending] = await conn.execute(
        `SELECT id, order_number, subtotal, discount, tax, total, employee_id FROM orders
         WHERE table_id = ? AND status = 'pending' AND branch_id = ? AND voided_at IS NULL
         ${livePay.sql}
         ORDER BY id FOR UPDATE`,
        [tableId, branchId, ...livePay.params]
      );
    } catch (e) {
      if (e.code === "ER_BAD_FIELD_ERROR") {
        [pending] = await conn.execute(
          `SELECT id, order_number, subtotal, discount, tax, total, employee_id FROM orders
           WHERE table_id = ? AND status = 'pending' AND branch_id = ?
           ${livePay.sql}
           ORDER BY id FOR UPDATE`,
          [tableId, branchId, ...livePay.params]
        );
        pending = (pending || []).map((o) => ({ ...o, order_number: o.order_number ?? null }));
      } else throw e;
    }
    if (!pending.length) {
      await conn.rollback();
      return res.status(400).json({ error: "No pending orders for this table" });
    }

    // Split payment: at least 2 entries provided
    const isSplitPayment = Array.isArray(splits) && splits.length >= 2;
    const paymentMethodVal = isSplitPayment
      ? "split_payment"
      : normalizePaymentMethod(paymentMethod || "cash");
    const manualAmountPayment = !isSplitPayment && /^(cash|gcash|bank|debit|credit)$/i.test(paymentMethodVal);

    if (!isSplitPayment && paymentMethodVal === "charge") {
      const name = String(customerName || "").trim();
      if (!name) {
        await conn.rollback();
        return res.status(400).json({ error: "Customer name is required for Charge/Utang" });
      }
    }
    const [settingsRows] = await conn.execute(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tax_rate','service_charge_mode','service_charge_value','card_surcharge')"
    );
    const settingsMap = {};
    for (const row of settingsRows || []) settingsMap[row.setting_key] = row.setting_value;
    const taxRate = Math.max(0, Number(settingsMap.tax_rate ?? 0) || 0) / 100;
    const serviceChargeMode = String(settingsMap.service_charge_mode || "percent") === "fixed" ? "fixed" : "percent";
    const serviceChargeValue = Math.max(0, Number(settingsMap.service_charge_value ?? 0) || 0);
    const cardSurchargeRate = Math.max(0, Number(settingsMap.card_surcharge ?? 0) || 0) / 100;
    const pendingIds = pending.map((o) => o.id);
    // Pin this billing batch to the open table session (or create one if missing).
    let payAllSessionId = null;
    try {
      const openSess = await getOpenSession(conn, branchId, tableId);
      if (openSess) {
        payAllSessionId = Number(openSess.id);
      } else {
        const { employeeId: actingEmp } = getActingUser(req);
        payAllSessionId = await ensureSessionForOrder(conn, {
          branchId,
          tableId,
          orderId: pendingIds[0],
          waiterId: actingEmp || null,
          isFreshSeating: true,
        });
      }
      const anchor = Math.min(...pendingIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0));
      if (payAllSessionId && Number.isFinite(anchor)) {
        for (const oid of pendingIds) {
          await attachOrderToSession(conn, oid, payAllSessionId, anchor);
        }
      }
    } catch (e) {
      if (e.code !== "ER_NO_SUCH_TABLE" && e.code !== "ER_BAD_FIELD_ERROR") throw e;
      try {
        const anchor = Math.min(...pendingIds.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0));
        if (Number.isFinite(anchor)) {
          const placeholders = pendingIds.map(() => "?").join(",");
          await conn.execute(
            `UPDATE orders SET table_visit_id = ? WHERE branch_id = ? AND id IN (${placeholders})`,
            [anchor, branchId, ...pendingIds]
          );
        }
      } catch (e2) {
        if (e2.code !== "ER_BAD_FIELD_ERROR") throw e2;
      }
    }
    const posSettings = await loadPosFinancialSettings(conn);
    for (const o of pending) {
      const fresh = await updateOrderTotalsFromItems(conn, o.id, posSettings);
      o.subtotal = fresh.subtotal;
      o.tax = fresh.tax;
      o.total = fresh.total;
    }
    const complimentaryByOrder = await loadComplimentaryByOrder(conn, pendingIds);

    // Single source of truth: identical math to /bill-preview (no cashier-vs-server drift).
    const bill = computeTableBillTotals({
      pending,
      complimentaryByOrder,
      taxRate,
      serviceChargeMode,
      serviceChargeValue,
      cardSurchargeRate,
      discountAmount,
      isSplitPayment,
      paymentMethodVal,
      splits,
    });
    const {
      orderBases,
      orderComputedById,
      totalBaseTotal,
      useAdjustedSplitMath,
      paidSum,
      combinedSubtotal,
      combinedDiscount,
      combinedTax,
      combinedTotal,
      combinedCardSurcharge,
    } = bill;
    const computedCardSurcharge = combinedCardSurcharge;

    if (isSplitPayment && paidSum <= 0) {
      await conn.rollback();
      return res.status(400).json({ error: "Split payment total must be greater than zero" });
    }

    // Validate BEFORE any status/stock/session writes.
    const validationExpected = useAdjustedSplitMath ? combinedTotal : totalBaseTotal;
    if (isSplitPayment && Math.abs(round2(paidSum) - round2(validationExpected)) >= 0.01) {
      await conn.rollback();
      return res.status(400).json({
        error: "Split payment amounts must exactly match computed total",
        expectedTotal: round2(validationExpected),
        paidSum: round2(paidSum),
      });
    }

    let changeAmount = 0;
    let receivedAmount = combinedTotal;
    if (manualAmountPayment) {
      receivedAmount = round2(Number(amountReceived));
      if (!Number.isFinite(receivedAmount)) {
        await conn.rollback();
        return res.status(400).json({ error: "Payment amount is required" });
      }
      if (receivedAmount + 0.009 < combinedTotal) {
        await conn.rollback();
        return res.status(400).json({
          error: "Payment amount is less than amount due",
          amountDue: combinedTotal,
          amountReceived: receivedAmount,
        });
      }
      changeAmount = round2(Math.max(0, receivedAmount - combinedTotal));
    }

    const { userId, employeeId, userName } = getActingUser(req);

    // Persist payment only after validation succeeds
    for (const ob of orderBases) {
      await persistPaidOrderFinancials(conn, {
        orderId: ob.id,
        paymentMethod: paymentMethodVal,
        discount: ob.discount,
        tax: ob.tax,
        serviceCharge: ob.serviceCharge,
        cardSurcharge: ob.cardSurcharge,
        total: ob.total,
      });
    }
    try {
      await consumeStockForPaidOrderIds(conn, pendingIds);
    } catch (stockErr) {
      if (stockErr.code !== "ER_NO_SUCH_TABLE") throw stockErr;
    }
    try {
      await vacateTableIfIdle(conn, branchId, tableId, {
        closedBy: userName || employeeId || "pay-all",
      });
    } catch (sessErr) {
      if (sessErr.code !== "ER_NO_SUCH_TABLE") throw sessErr;
      await conn.execute(
        "UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?",
        [branchId, tableId]
      );
    }

    // Handle split payment records
    if (isSplitPayment) {
      const primaryOrderId = pending[0].id;
      try {
        await conn.execute(`DELETE FROM split_payments WHERE order_id = ?`, [primaryOrderId]);
        for (let i = 0; i < splits.length; i++) {
          await conn.execute(
            `INSERT INTO split_payments (order_id, split_number, amount, payment_method, status) VALUES (?, ?, ?, ?, 'paid')`,
            [primaryOrderId, i + 1, splits[i].amount, normalizePaymentMethod(splits[i].paymentMethod)]
          );
        }
      } catch (_splitErr) {
        // split_payments table may not exist — non-fatal
      }
      // Handle charge entries within split
      const chargeSplits = splits.filter((s) => s.paymentMethod === "charge" && String(s.customerName || "").trim());
      for (const cs of chargeSplits) {
        try {
          const [r] = await conn.execute(
            `INSERT INTO charge_transactions (branch_id, order_ids, customer_name, amount, status, charged_by) VALUES (?, ?, ?, ?, 'pending', ?)`,
            [branchId, pending.map((o) => o.id).join(","), String(cs.customerName).trim(), cs.amount, userName || employeeId || null]
          );
          logAudit(req, "charge_create", "charge", String(r.insertId), { customerName: String(cs.customerName).trim(), amount: cs.amount, orderIds: pending.map((o) => String(o.id)) });
        } catch (_chargeErr) {
          // charge_transactions table may not exist — non-fatal
        }
      }
    } else if (paymentMethodVal === "charge") {
      const [r] = await conn.execute(
        `INSERT INTO charge_transactions (branch_id, order_ids, customer_name, amount, status, charged_by) VALUES (?, ?, ?, ?, 'pending', ?)`,
        [branchId, pending.map((o) => o.id).join(","), String(customerName).trim(), combinedTotal, userName || employeeId || null]
      );
      logAudit(req, "charge_create", "charge", String(r.insertId), { customerName: String(customerName).trim(), amount: combinedTotal, orderIds: pending.map((o) => String(o.id)) });
    }

    // Persist immutable official receipt snapshots for faithful historical reprint.
    const receiptSettingsMap = await loadReceiptSettingsMap(conn);
    const labels = buildReceiptLabels(receiptSettingsMap);
    let paidOrders;
    [paidOrders] = await conn.execute(
      `SELECT id, order_number, table_id, table_visit_id, session_id, payment_method, subtotal, discount, tax, total
       FROM orders WHERE id IN (${pendingIds.map(() => "?").join(",")}) ORDER BY id`,
      pendingIds
    );
    const itemRows = await queryWithVoidFallback(
      conn,
      `SELECT oi.order_id AS orderId, oi.product_name AS name, oi.quantity, oi.subtotal, oi.department,
              oi.is_complimentary AS isComplimentary, COALESCE(oi.is_voided,0) AS isVoided,
              oi.voided_by_name AS voidedByName, oi.special_request AS specialRequest,
              u.name AS servedByName
       FROM order_items oi
       LEFT JOIN users u ON u.id = oi.served_by
       WHERE oi.order_id IN (${pendingIds.map(() => "?").join(",")})
       ORDER BY oi.order_id, oi.id`,
      `SELECT oi.order_id AS orderId, oi.product_name AS name, oi.quantity, oi.subtotal, oi.department,
              oi.is_complimentary AS isComplimentary, 0 AS isVoided,
              NULL AS voidedByName, NULL AS specialRequest,
              u.name AS servedByName
       FROM order_items oi
       LEFT JOIN users u ON u.id = oi.served_by
       WHERE oi.order_id IN (${pendingIds.map(() => "?").join(",")})
       ORDER BY oi.order_id, oi.id`,
      pendingIds
    );
    const itemsByOrder = {};
    for (const rowItem of itemRows || []) {
      const key = String(rowItem.orderId);
      if (!itemsByOrder[key]) itemsByOrder[key] = [];
      const servedBySuffix = rowItem.department === "LD" && rowItem.servedByName ? ` [${rowItem.servedByName}]` : "";
      const noteSuffix = rowItem.specialRequest ? ` - ${rowItem.specialRequest}` : "";
      const baseName = `${rowItem.name}${servedBySuffix}${noteSuffix}`;
      const displayName = rowItem.isVoided
        ? `${rowItem.name} (VOIDED${rowItem.voidedByName ? ` by ${rowItem.voidedByName}` : ""})`
        : baseName;
      itemsByOrder[key].push({
        name: displayName,
        quantity: Number(rowItem.quantity || 0),
        subtotal: rowItem.isVoided ? 0 : round2(Number(rowItem.subtotal || 0)),
        isComplimentary: !!rowItem.isComplimentary,
        note: rowItem.specialRequest || undefined,
      });
    }
    for (let orderIdx = 0; orderIdx < (paidOrders || []).length; orderIdx++) {
      const paidOrder = paidOrders[orderIdx];
      const key = String(paidOrder.id);
      const computed = orderComputedById[key] || {};
      const orderSubtotal = round2(Number(paidOrder.subtotal || 0));
      const orderDiscount = round2(Number(computed.discount ?? paidOrder.discount ?? 0));
      const orderTax = round2(Number(computed.tax ?? paidOrder.tax ?? 0));
      const orderTotal = round2(Number(computed.total ?? paidOrder.total ?? 0));
      const orderCardSurcharge = round2(Number(computed.cardSurcharge ?? 0));
      const orderService = round2(Number(computed.serviceCharge ?? Math.max(0, orderTotal - (orderSubtotal - orderDiscount) - orderTax - orderCardSurcharge)));
      const orderComplimentary = round2(
        (itemsByOrder[key] || []).reduce((sum, item) => sum + (item.isComplimentary ? Number(item.subtotal || 0) : 0), 0)
      );
      const isPrimaryOrder = orderIdx === 0;
      const orderChange = manualAmountPayment && isPrimaryOrder ? changeAmount : 0;
      const orderPaid = manualAmountPayment && isPrimaryOrder ? receivedAmount : orderTotal;
      const receiptPayload = {
        orderNumber: formatOrderDisplayNumber(paidOrder),
        date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
        time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        table: paidOrder.table_id ? String(paidOrder.table_id) : String(tableId),
        cashier: userName || employeeId || "Staff",
        businessName: String(receiptSettingsMap.business_name || "").trim(),
        businessAddress: String(receiptSettingsMap.business_address || "").trim(),
        businessContact: String(receiptSettingsMap.business_contact || "").trim(),
        receiptFooter: String(receiptSettingsMap.receipt_footer || "").trim(),
        vatTin: String(receiptSettingsMap.vat_tin || "").trim(),
        serviceLabel: labels.serviceLabel,
        taxLabel: labels.taxLabel,
        items: itemsByOrder[key] || [],
        subtotal: orderSubtotal,
        complimentary: orderComplimentary > 0 ? orderComplimentary : undefined,
        discount: orderDiscount > 0 ? orderDiscount : undefined,
        serviceCharge: orderService,
        tax: orderTax,
        cardSurcharge: orderCardSurcharge > 0 ? orderCardSurcharge : undefined,
        total: orderTotal,
        amountDue: orderTotal,
        paymentMethod: String(paidOrder.payment_method || paymentMethodVal || "cash"),
        amountPaid: orderPaid,
        change: orderChange,
      };
      await saveReceiptSnapshot(conn, {
        branchId,
        snapshotType: "official_receipt",
        orderId: Number(paidOrder.id),
        tableId: String(paidOrder.table_id || tableId),
        tableVisitId: paidOrder.table_visit_id != null ? Number(paidOrder.table_visit_id) : null,
        sessionId:
          paidOrder.session_id != null
            ? Number(paidOrder.session_id)
            : payAllSessionId != null
              ? Number(payAllSessionId)
              : null,
        paymentMethod: String(paidOrder.payment_method || paymentMethodVal || "cash"),
        receipt: receiptPayload,
        createdBy: userId ? Number(userId) : null,
      });
    }

    const auditDetails = { orderIds: pending.map((o) => String(o.id)), paymentMethod: paymentMethodVal, total: combinedTotal };
    if (discountName || (discountAmount != null && Number(discountAmount) > 0)) {
      auditDetails.discountName = discountName || null;
      auditDetails.discountAmount = Number(discountAmount) || combinedDiscount;
    }
    if (paymentMethodVal === "charge") auditDetails.customerName = String(customerName).trim();
    if (isSplitPayment) auditDetails.splits = splits;
    await conn.commit();
    await logAudit(req, "table_pay_all", "table", tableId, auditDetails);
    res.json({
      ok: true,
      orderIds: pending.map((o) => String(o.id)),
      orderNumbers: pending.map((o) => formatOrderDisplayNumber(o)),
      subtotal: combinedSubtotal,
      discount: combinedDiscount,
      tax: combinedTax,
      total: combinedTotal,
      cardSurcharge: round2(computedCardSurcharge),
      change: changeAmount,
      amountReceived: manualAmountPayment ? receivedAmount : combinedTotal,
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    if (err.code === "ER_NO_SUCH_TABLE" && err.message?.includes("charge_transactions")) {
      return res.status(503).json({ error: "Charge feature not available. Run server/schema.sql in MySQL" });
    }
    if (err.code === "ER_DATA_TOO_LONG" && /order_ids/i.test(String(err.message || ""))) {
      return res.status(500).json({
        error: "Too many orders on this table for Charge/Utang. Restart the server to apply the order_ids migration, or settle without Charge.",
      });
    }
    console.error("Pay table error:", err);
    res.status(500).json({ error: "Failed to process payment" });
  } finally {
    if (conn) conn.release();
  }
});

// ---------- List printers (for POS Settings) ----------
// Windows printers + Ethernet from .env + printers added in DB (Settings / system).
app.get("/api/print/printers", requireAnyPermission("print_receipts", "manage_settings", "manage_pos"), async (req, res) => {
  const printers = [];
  let error = null;
  try {
    const list = getWindowsPrinterList();
    list.forEach((p) => printers.push({ name: p.name, isDefault: !!p.isDefault, isNetwork: false }));
    if (list.length === 0 && process.platform === "win32") {
      error = "No printers found. Install npm package: npm install printer --legacy-peer-deps (in server folder) for best support, or add printers in Windows Settings.";
    }
  } catch (e) {
    error = e.message || "Failed to get printers";
  }
  // Add Ethernet/network printers from .env (single or comma-separated)
  ethernetPrintersFromEnv.forEach(({ interface: iface, displayName }) => {
    printers.push({ name: iface, displayName: `Ethernet (${displayName})`, isDefault: false, isNetwork: true });
  });
  // Add printers from DB (added in system / Settings)
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      "SELECT id, name, interface, type FROM printers WHERE active = 1 ORDER BY name"
    );
    rows.forEach((row) => {
      const iface = row.interface;
      const isNetwork = /^tcp:\/\//i.test(iface) || /^socket:\/\//i.test(iface);
      printers.push({
        name: iface,
        displayName: row.name || iface,
        isDefault: false,
        isNetwork: !!isNetwork,
        fromSystem: true,
      });
    });
  } catch (e) {
    // Table may not exist yet; ignore
  }
  res.json({ printers, error: error || undefined });
});

// ---------- Add printer (system) ----------
app.post("/api/print/printers", requireAnyPermission("manage_settings"), async (req, res) => {
  const { name, interface: iface, type: typeName } = req.body || {};
  if (!name || !iface || typeof name !== "string" || typeof iface !== "string") {
    return res.status(400).json({ error: "name and interface are required" });
  }
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    await db.execute(
      "INSERT INTO printers (name, interface, type, branch_id, active) VALUES (?, ?, ?, ?, 1)",
      [name.trim(), iface.trim(), (typeName && String(typeName).trim()) || "epson", branchId]
    );
    res.json({ ok: true, message: "Printer added" });
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({ error: "Printers table not found. Run the schema migration that creates the printers table." });
    }
    res.status(500).json({ error: e.message || "Failed to add printer" });
  }
});

// ---------- Print Receipt ----------
app.post("/api/print/receipt", requireAnyPermission("print_receipts", "manage_pos"), async (req, res) => {
  const { receipt, printerName } = req.body || {};
  if (!receipt) {
    return res.status(400).json({ error: "Receipt data is required" });
  }

  const driver = getPrinterDriver();
  const defaultFromEnv = ethernetPrintersFromEnv.length > 0 ? ethernetPrintersFromEnv[0].interface : (PRINTER_INTERFACE || "").trim() || undefined;
  const interfaceToUse = resolvePrinterInterface(printerName, defaultFromEnv);

  try {
    const buf = buildCustomerReceipt(receipt);
    const result = await printEscPosBuffer(buf, {
      printerType: PRINTER_TYPE,
      printerInterface: interfaceToUse,
      driver,
      printerOptions,
      width: 48,
    });
    if (result.ok) console.log("Receipt printed successfully!");
    else {
      const isTimeout = /timeout|ETIMEDOUT/i.test(String(result.error));
      if (isTimeout) console.warn("Receipt: printer unavailable (timeout). Use browser print.");
      else console.warn("Print error:", result.error);
    }
    res.json(result.ok ? { ok: true, message: "Receipt printed" } : result);
  } catch (err) {
    console.warn("Print error:", err.message);
    res.json({ ok: false, error: err.message, fallback: true });
  }
});

app.post("/api/print/receipt-html", requireAnyPermission("print_receipts", "view_orders", "manage_pos"), (req, res) => {
  const { receipt } = req.body || {};
  if (!receipt) return res.status(400).json({ error: "receipt required" });
  res.type("html").send(buildCustomerReceiptHtml(receipt));
});

app.post("/api/print/running-bill-html", requireAnyPermission("print_receipts", "view_orders", "manage_pos"), (req, res) => {
  const body = req.body || {};
  if (!body.items || !Array.isArray(body.items)) return res.status(400).json({ error: "items required" });
  res.type("html").send(buildRunningBillHtml(body));
});

app.post("/api/print/order-slip-html", requireAnyPermission("print_receipts", "view_orders", "send_to_departments", "manage_pos"), (req, res) => {
  const body = req.body || {};
  if (!body.items || !Array.isArray(body.items)) return res.status(400).json({ error: "items required" });
  res.type("html").send(buildOrderSlipHtml(body));
});

// ---------- Print Department Chit (Kitchen / Bar / LD) ----------
// Body: { dept, title, subtitle, items: [{name, quantity, servedByName?, specialRequest?}], table, area, encoder, orderNumber, date, time, printerName? }
app.post("/api/print/dept-receipt", requireAnyPermission("print_receipts", "send_to_departments", "manage_pos"), async (req, res) => {
  const { dept, title, subtitle, items, table: tableStr, area, encoder, orderNumber, date, time, printerName } = req.body || {};
  if (!dept || !items || !Array.isArray(items)) {
    return res.status(400).json({ error: "dept and items are required" });
  }

  const driver = getPrinterDriver();
  const defaultFromEnv = ethernetPrintersFromEnv.length > 0 ? ethernetPrintersFromEnv[0].interface : (PRINTER_INTERFACE || "").trim() || undefined;
  const interfaceToUse = resolvePrinterInterface(printerName, defaultFromEnv);

  if (!interfaceToUse) {
    return res.json({ ok: false, error: "No printer configured for this department.", fallback: true });
  }

  try {
    const buf = buildDeptChit({ dept, title, subtitle, items, table: tableStr, area, encoder, orderNumber, date, time });
    const result = await printEscPosBuffer(buf, {
      printerType: PRINTER_TYPE,
      printerInterface: interfaceToUse,
      driver,
      printerOptions,
      width: 42,
    });
    if (result.ok) console.log(`[Print] Dept chit (${dept}) printed to ${interfaceToUse}`);
    res.json(result.ok ? { ok: true, message: `${dept} chit printed` } : result);
  } catch (err) {
    const isTimeout = /timeout|ETIMEDOUT/i.test(String(err.message));
    console.warn(isTimeout ? `Dept chit (${dept}): printer unavailable.` : `Dept chit error:`, err.message);
    res.json({ ok: false, error: err.message, fallback: true });
  }
});

// ---------- Print Order Slip (cashier chit sent to Bar/cashier printer) ----------
app.post("/api/print/order-slip", requireAnyPermission("print_receipts", "send_to_departments", "manage_pos"), async (req, res) => {
  const { orderId, table: tableStr, area, waiter, date, time, subtotal, items, printerName, isReprint } = req.body || {};
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: "items required" });

  const driver = getPrinterDriver();
  const defaultFromEnv = ethernetPrintersFromEnv.length > 0 ? ethernetPrintersFromEnv[0].interface : (PRINTER_INTERFACE || "").trim() || undefined;
  const interfaceToUse = resolvePrinterInterface(printerName, defaultFromEnv);

  if (!interfaceToUse) return res.json({ ok: false, error: "No printer configured." });

  try {
    const buf = buildOrderSlip({ orderId, table: tableStr, area, waiter, date, time, subtotal, items, isReprint });
    const result = await printEscPosBuffer(buf, {
      printerType: PRINTER_TYPE,
      printerInterface: interfaceToUse,
      driver,
      printerOptions,
      width: 42,
    });
    res.json(result.ok ? { ok: true } : result);
  } catch (err) {
    console.warn("Order slip print error:", err.message);
    res.json({ ok: false, error: err.message });
  }
});

// ---------- QZ Tray: ESC/POS payloads (browser prints via local QZ Tray) ----------
app.post("/api/print/qz-payload/receipt", requireAnyPermission("print_receipts", "manage_pos"), (req, res) => {
  try {
    const { receipt } = req.body || {};
    if (!receipt) return res.status(400).json({ error: "receipt required" });
    const buf = buildCustomerReceipt(receipt);
    res.json({ base64: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to build receipt" });
  }
});
app.post("/api/print/qz-payload/dept-receipt", requireAnyPermission("print_receipts", "send_to_departments", "manage_pos"), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.dept || !Array.isArray(body.items)) {
      return res.status(400).json({ error: "dept and items required" });
    }
    const buf = buildDeptChit(body);
    res.json({ base64: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to build chit" });
  }
});
app.post("/api/print/qz-payload/order-slip", requireAnyPermission("print_receipts", "send_to_departments", "manage_pos"), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.items || !Array.isArray(body.items)) {
      return res.status(400).json({ error: "items required" });
    }
    const buf = buildOrderSlip(body);
    res.json({ base64: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to build slip" });
  }
});

// ---------- Running Bill (thermal + QZ) ----------
app.post("/api/print/running-bill", requireAnyPermission("print_receipts", "view_orders", "manage_pos"), async (req, res) => {
  const body = req.body || {};
  const branchId = getBranchId(req);
  if (!body.items || !Array.isArray(body.items)) {
    return res.status(400).json({ error: "items required" });
  }
  const { printerName } = body;
  const driver = getPrinterDriver();
  const defaultFromEnv = ethernetPrintersFromEnv.length > 0 ? ethernetPrintersFromEnv[0].interface : (PRINTER_INTERFACE || "").trim() || undefined;
  const interfaceToUse = resolvePrinterInterface(printerName, defaultFromEnv);
  if (!interfaceToUse) return res.json({ ok: false, error: "No printer configured.", fallback: true });
  try {
    const db = await getPool();
    const buf = buildRunningBill(body);
    const result = await printEscPosBuffer(buf, {
      printerType: PRINTER_TYPE,
      printerInterface: interfaceToUse,
      driver,
      printerOptions,
      width: 48,
    });
    const { userId } = getActingUser(req);
    await saveReceiptSnapshot(db, {
      branchId,
      snapshotType: "running_bill",
      orderId: null,
      tableId: body.tableId ? String(body.tableId) : (body.table ? String(body.table) : null),
      tableVisitId: null,
      paymentMethod: null,
      receipt: body,
      createdBy: userId ? Number(userId) : null,
    });
    if (!result.ok) {
      const isTimeout = /timeout|ETIMEDOUT/i.test(String(result.error));
      if (isTimeout) console.warn("Running bill: printer unavailable.");
      else console.warn("Running bill print error:", result.error);
    }
    res.json(result.ok ? { ok: true, message: "Running bill printed" } : result);
  } catch (err) {
    console.warn("Running bill print error:", err.message);
    res.json({ ok: false, error: err.message, fallback: true });
  }
});

app.get("/api/tables/:tableId/running-bill-snapshot", requireAnyPermission("view_orders", "print_receipts", "manage_pos"), async (req, res) => {
  const branchId = getBranchId(req);
  const tableId = String(req.params.tableId || "").trim();
  if (!tableId) return res.status(400).json({ error: "tableId is required" });
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT id, receipt_json AS receiptJson, created_at AS createdAt
       FROM receipt_snapshots
       WHERE branch_id = ? AND snapshot_type = 'running_bill' AND table_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [branchId, tableId]
    );
    if (!rows.length) return res.status(404).json({ error: "Running bill snapshot not found" });
    const snapshot = rows[0];
    let receipt = snapshot.receiptJson;
    if (typeof receipt === "string") {
      try { receipt = JSON.parse(receipt); } catch { receipt = null; }
    }
    if (!receipt || typeof receipt !== "object") return res.status(500).json({ error: "Stored running bill snapshot is invalid" });
    res.json({
      id: String(snapshot.id),
      tableId,
      createdAt: snapshot.createdAt?.toISOString?.() || snapshot.createdAt,
      receipt,
    });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.status(404).json({ error: "Running bill snapshot not available on this database yet" });
    console.error("Running bill snapshot error:", err);
    res.status(500).json({ error: "Failed to load running bill snapshot" });
  }
});

app.post("/api/print/qz-payload/running-bill", requireAnyPermission("print_receipts", "view_orders", "manage_pos"), (req, res) => {
  try {
    const body = req.body || {};
    if (!body.items || !Array.isArray(body.items)) {
      return res.status(400).json({ error: "items required" });
    }
    const buf = buildRunningBill(body);
    res.json({ base64: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to build running bill" });
  }
});

// ---------- Print Payslip (thermal) ----------
app.post("/api/print/payslip", requireAnyPermission("view_payroll", "manage_payroll"), async (req, res) => {
  const { payslip } = req.body || {};
  if (!payslip || !payslip.name) {
    return res.status(400).json({ error: "Payslip data is required" });
  }

  try {
    const driver = getPrinterDriver();
    const defaultFromEnv = ethernetPrintersFromEnv.length > 0 ? ethernetPrintersFromEnv[0].interface : (PRINTER_INTERFACE || "").trim() || undefined;
    const normalized = {
      ...payslip,
      gross: computePayslipGross(payslip),
      netPayout: computePayslipNet(payslip),
    };
    const buf = buildPayslip(normalized);
    const result = await printEscPosBuffer(buf, {
      printerType: PRINTER_TYPE,
      printerInterface: defaultFromEnv,
      driver,
      printerOptions,
      width: 48,
    });
    if (!result.ok) {
      const isTimeout = /timeout|ETIMEDOUT/i.test(String(result.error));
      if (isTimeout) console.warn("Payslip: printer unavailable (timeout). Use Print or Download PDF.");
      else console.warn("Payslip print error:", result.error);
    }
    res.json(result.ok ? { ok: true, message: "Payslip printed" } : result);
  } catch (err) {
    console.warn("Payslip print error:", err.message);
    res.json({ ok: false, error: err.message, fallback: true });
  }
});

app.post("/api/print/qz-payload/payslip", requireAnyPermission("view_payroll", "manage_payroll"), (req, res) => {
  try {
    const { payslip } = req.body || {};
    if (!payslip || !payslip.name) return res.status(400).json({ error: "payslip required" });
    const normalized = {
      ...payslip,
      gross: computePayslipGross(payslip),
      netPayout: computePayslipNet(payslip),
    };
    const buf = buildPayslip(normalized);
    res.json({ base64: buf.toString("base64") });
  } catch (e) {
    res.status(500).json({ error: e.message || "Failed to build payslip" });
  }
});

// ---------- Products ----------
// SKU = inventory identity (unique). Multiple price variants live in product_prices.
// ?area=Lounge|Club|LD resolves default price for that area; priceVariants lists applicable options.
app.get("/api/products", requireAnyPermission("view_products", "manage_products", "manage_pos", "create_orders"), async (req, res) => {
  try {
    const db = await getPool();
    const { search, category, department, status, limit, area } = req.query;
    let sql = "SELECT id, sku, name, description, category, COALESCE(sub_category, '') AS sub_category, department, price, cost, commission, status FROM products WHERE 1=1";
    const params = [];
    if (search) {
      sql += " AND (name LIKE ? OR sku LIKE ?)";
      const s = `%${String(search)}%`;
      params.push(s, s);
    }
    if (category && category !== "All") { sql += " AND category = ?"; params.push(category); }
    if (department && department !== "All") { sql += " AND department = ?"; params.push(department); }
    if (status && status !== "All") { sql += " AND status = ?"; params.push(status); }
    sql += " ORDER BY category, name";
    if (limit) { sql += " LIMIT ?"; params.push(Number(limit)); }
    const [rows] = await db.execute(sql, params);
    const productIds = rows.map((r) => r.id);
    const pricesMap = await listPricesForProducts(db, productIds);
    const stockMap = await getStockMap(db, productIds);
    // Legacy area fallback
    let areaPricesMap = {};
    if (productIds.length > 0) {
      try {
        const placeholders = productIds.map(() => "?").join(",");
        const [apRows] = await db.execute(
          `SELECT product_id, area, price FROM product_area_prices WHERE product_id IN (${placeholders})`,
          productIds
        );
        apRows.forEach((r) => {
          if (!areaPricesMap[r.product_id]) areaPricesMap[r.product_id] = {};
          areaPricesMap[r.product_id][r.area] = Number(r.price);
        });
      } catch {
        // ignore
      }
    }
    const validArea = area && ["Lounge", "Club", "LD"].includes(String(area)) ? String(area) : null;
    const out = rows.map((r) => {
      const key = String(r.id);
      let prices = pricesMap[key] || [];
      if (!prices.length) {
        const legacy = areaPricesMap[r.id] || {};
        prices = [{ id: null, label: "Regular", area: null, price: Number(r.price), isDefault: true, active: true }];
        for (const a of ["Lounge", "Club", "LD"]) {
          if (legacy[a] != null) prices.push({ id: null, label: a, area: a, price: Number(legacy[a]), isDefault: false, active: true });
        }
      }
      const applicable = filterApplicablePrices(prices, validArea, null);
      const chosen = resolvePriceFromVariants(prices, validArea, null, null);
      const pricesByArea = pricesByAreaFromList(prices);
      if (!pricesByArea.Lounge && areaPricesMap[r.id]?.Lounge != null) pricesByArea.Lounge = areaPricesMap[r.id].Lounge;
      if (!pricesByArea.Club && areaPricesMap[r.id]?.Club != null) pricesByArea.Club = areaPricesMap[r.id].Club;
      if (!pricesByArea.LD && areaPricesMap[r.id]?.LD != null) pricesByArea.LD = areaPricesMap[r.id].LD;
      return {
        ...r,
        id: key,
        description: r.description ?? "",
        sub_category: r.sub_category ?? "",
        price: chosen ? Number(chosen.price) : Number(r.price),
        priceId: chosen?.id ?? null,
        cost: Number(r.cost),
        commission: Number(r.commission),
        pricesByArea,
        prices,
        priceVariants: applicable,
        stockQty: stockMap[key] != null ? Number(stockMap[key]) : 0,
      };
    });
    res.json(out);
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR" || err.code === "ER_NO_SUCH_TABLE") {
      const db = await getPool();
      const { search, category, department, status, limit } = req.query;
      let sql = "SELECT id, sku, name, description, category, department, price, cost, commission, status FROM products WHERE 1=1";
      const params = [];
      if (search) { sql += " AND (name LIKE ? OR sku LIKE ?)"; const s = `%${String(search)}%`; params.push(s, s); }
      if (category && category !== "All") { sql += " AND category = ?"; params.push(category); }
      if (department && department !== "All") { sql += " AND department = ?"; params.push(department); }
      if (status && status !== "All") { sql += " AND status = ?"; params.push(status); }
      sql += " ORDER BY category, name";
      if (limit) { sql += " LIMIT ?"; params.push(Number(limit)); }
      const [rows] = await db.execute(sql, params);
      return res.json(rows.map((r) => ({
        ...r, id: String(r.id), description: r.description ?? "", sub_category: "", price: Number(r.price), cost: Number(r.cost), commission: Number(r.commission),
        pricesByArea: {}, prices: [], priceVariants: [], stockQty: 0,
      })));
    }
    console.error("Products list error:", err);
    res.status(500).json({ error: "Failed to load products" });
  }
});

async function loadProductResponse(db, productId) {
  let rows;
  try {
    [rows] = await db.execute(
      "SELECT id, sku, name, description, category, sub_category, department, price, cost, commission, status FROM products WHERE id = ?",
      [productId]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [rows] = await db.execute(
      "SELECT id, sku, name, description, category, department, price, cost, commission, status FROM products WHERE id = ?",
      [productId]
    );
  }
  if (!rows.length) return null;
  const p = rows[0];
  const pricesMap = await listPricesForProducts(db, [p.id]);
  const prices = pricesMap[String(p.id)] || [];
  const stockMap = await getStockMap(db, [p.id]);
  const pricesByArea = pricesByAreaFromList(prices);
  return {
    id: String(p.id),
    sku: p.sku,
    name: p.name,
    description: p.description ?? "",
    category: p.category,
    sub_category: p.sub_category ?? "",
    department: p.department,
    price: Number(p.price),
    cost: Number(p.cost),
    commission: Number(p.commission),
    status: p.status,
    pricesByArea,
    prices,
    priceVariants: filterApplicablePrices(prices, null, null),
    stockQty: stockMap[String(p.id)] != null ? Number(stockMap[String(p.id)]) : 0,
  };
}

app.post("/api/products", requireAnyPermission("manage_products"), async (req, res) => {
  const body = req.body || {};
  const { sku, name, description, category, sub_category, department, price, cost, commission, status, stockQty } = body;
  if (!sku?.trim() || !name?.trim()) return res.status(400).json({ error: "SKU and name required" });
  try {
    const db = await getPool();
    const skuTrim = String(sku).trim();
    const [existingSku] = await db.execute("SELECT id, sku, name FROM products WHERE sku = ? LIMIT 1", [skuTrim]);
    if (existingSku.length) {
      const existing = await loadProductResponse(db, existingSku[0].id);
      return res.status(409).json({
        error: "SKU already exists",
        code: "SKU_EXISTS",
        message: `SKU already exists for "${existingSku[0].name}". Add a price variant under the existing product instead of creating a duplicate inventory item.`,
        existingProduct: existing,
      });
    }
    let newId;
    try {
      const [r] = await db.execute(
        `INSERT INTO products (sku, name, description, category, sub_category, department, price, cost, commission, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [skuTrim, String(name).trim(), description?.trim() || null, category || "Beer", (sub_category && String(sub_category).trim()) || null, department || "Bar", Number(price) || 0, Number(cost) || 0, Number(commission) || 0, status || "active"]
      );
      newId = r.insertId;
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        const [r] = await db.execute(
          `INSERT INTO products (sku, name, description, category, department, price, cost, commission, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [skuTrim, String(name).trim(), description?.trim() || null, category || "Beer", department || "Bar", Number(price) || 0, Number(cost) || 0, Number(commission) || 0, status || "active"]
        );
        newId = r.insertId;
      } else throw colErr;
    }
    try {
      const priceRows = pricesFromLegacyPayload(body);
      await replaceProductPrices(db, newId, priceRows, Number(price) || 0);
    } catch (priceErr) {
      if (priceErr.code !== "ER_NO_SUCH_TABLE") throw priceErr;
    }
    try {
      await setStockQty(db, newId, stockQty != null ? Number(stockQty) : 0);
    } catch (stockErr) {
      if (stockErr.code !== "ER_NO_SUCH_TABLE") throw stockErr;
    }
    const response = await loadProductResponse(db, newId);
    logAudit(req, "product_create", "product", String(newId), { sku: skuTrim, name });
    res.status(201).json(response);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "SKU already exists", code: "SKU_EXISTS" });
    }
    console.error("Product create error:", err);
    res.status(500).json({ error: "Failed to create product" });
  }
});

app.put("/api/products/:id", requireAnyPermission("manage_products"), async (req, res) => {
  const id = req.params.id;
  const body = req.body || {};
  const { sku, name, description, category, sub_category, department, price, cost, commission, status, stockQty } = body;
  if (!sku?.trim() || !name?.trim()) return res.status(400).json({ error: "SKU and name required" });
  try {
    const db = await getPool();
    const skuTrim = String(sku).trim();
    const [dup] = await db.execute("SELECT id, name FROM products WHERE sku = ? AND id != ? LIMIT 1", [skuTrim, id]);
    if (dup.length) {
      return res.status(409).json({
        error: "SKU already exists",
        code: "SKU_EXISTS",
        message: `SKU already exists for "${dup[0].name}". Use that product and add a price variant instead.`,
        existingProductId: String(dup[0].id),
      });
    }
    try {
      await db.execute(
        `UPDATE products SET sku=?, name=?, description=?, category=?, sub_category=?, department=?, price=?, cost=?, commission=?, status=? WHERE id = ?`,
        [skuTrim, String(name).trim(), description?.trim() || null, category || "Beer", (sub_category && String(sub_category).trim()) || null, department || "Bar", Number(price) || 0, Number(cost) || 0, Number(commission) || 0, status || "active", id]
      );
    } catch (colErr) {
      if (colErr.code === "ER_BAD_FIELD_ERROR") {
        await db.execute(
          `UPDATE products SET sku=?, name=?, description=?, category=?, department=?, price=?, cost=?, commission=?, status=? WHERE id = ?`,
          [skuTrim, String(name).trim(), description?.trim() || null, category || "Beer", department || "Bar", Number(price) || 0, Number(cost) || 0, Number(commission) || 0, status || "active", id]
        );
      } else throw colErr;
    }
    try {
      const priceRows = pricesFromLegacyPayload(body);
      await replaceProductPrices(db, id, priceRows, Number(price) || 0);
    } catch (priceErr) {
      if (priceErr.code !== "ER_NO_SUCH_TABLE") throw priceErr;
    }
    if (stockQty != null) {
      try {
        await setStockQty(db, id, Number(stockQty));
      } catch (stockErr) {
        if (stockErr.code !== "ER_NO_SUCH_TABLE") throw stockErr;
      }
    }
    const response = await loadProductResponse(db, id);
    if (!response) return res.status(404).json({ error: "Product not found" });
    logAudit(req, "product_update", "product", id, { sku: skuTrim, name });
    res.json(response);
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "SKU already exists", code: "SKU_EXISTS" });
    }
    console.error("Product update error:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.patch("/api/products/:id", requireAnyPermission("manage_products"), async (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: "status required" });
  try {
    const db = await getPool();
    await db.execute("UPDATE products SET status = ? WHERE id = ?", [status, id]);
    logAudit(req, "product_set_status", "product", id, { status });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/api/products/:id", requireAnyPermission("manage_products"), async (req, res) => {
  const id = req.params.id;
  try {
    const db = await getPool();
    await db.execute("DELETE FROM product_area_prices WHERE product_id = ?", [id]);
    const [r] = await db.execute("DELETE FROM products WHERE id = ?", [id]);
    if (!r.affectedRows) return res.status(404).json({ error: "Product not found" });
    logAudit(req, "product_delete", "product", id, {});
    res.json({ ok: true });
  } catch (err) {
    console.error("Product delete error:", err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});

// ---------- Staff (users; scoped by branch) ----------
// LD Ladies: staff with incentive_rate > 0 (get paid per ladies drink)
app.get("/api/staff/ld-ladies", requireAnyPermission("manage_pos", "create_orders", "view_staff", "manage_staff"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    // Return ALL active staff as available ladies for LD orders
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id AS code, u.name, u.nickname
       FROM users u WHERE u.branch_id = ? AND u.active = 1 ORDER BY u.name`,
      [branchId]
    );
    res.json(rows.map((r) => ({
      id: String(r.id),
      code: r.code,
      name: r.nickname || r.name,
    })));
  } catch (err) {
    console.error("LD ladies list error:", err);
    res.status(500).json({ error: "Failed to load LD ladies" });
  }
});

app.get("/api/staff/roles", requireAnyPermission("manage_staff", "view_staff"), async (_req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      "SELECT id, name FROM roles WHERE guard = 'web' ORDER BY id"
    );
    res.json(rows.map((r) => ({ id: String(r.id), name: r.name })));
  } catch (err) {
    console.error("Staff roles list error:", err);
    res.status(500).json({ error: "Failed to load staff roles" });
  }
});

app.get("/api/staff", requireAnyPermission("manage_staff", "view_staff"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id AS code, u.name, u.nickname, u.email, u.allowance, u.hourly,
              u.budget, u.commission_rate, u.incentive_rate, u.table_incentive, u.has_quota, u.quota_amount,
              u.active AS status, r.name AS type
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.branch_id = ? ORDER BY u.employee_id`,
      [branchId]
    );
    res.json(rows.map((r) => ({
      id: String(r.id),
      code: r.code,
      name: r.name,
      nickname: r.nickname || "",
      type: r.type,
      allowance: Number(r.allowance || 0),
      hourly: Number(r.hourly || 0),
      budget: Number(r.budget || 0),
      commissionRate: Number(r.commission_rate || 0),
      incentiveRate: Number(r.incentive_rate || 0),
      tableIncentive: Number(r.table_incentive || 0),
      hasQuota: !!r.has_quota,
      quotaAmount: Number(r.quota_amount || 0),
      hasLogin: true,
      status: r.status === 1 ? "active" : "inactive",
    })));
  } catch (err) {
    console.error("Staff list error:", err);
    res.status(500).json({ error: "Failed to load staff" });
  }
});

app.post("/api/staff", requireAnyPermission("manage_staff"), async (req, res) => {
  const branchId = getBranchId(req);
  const { code, name, nickname, type, allowance, hourly, budget, commissionRate, incentiveRate, tableIncentive, hasQuota, quotaAmount, password } = req.body || {};
  if (!code?.trim() || !name?.trim()) return res.status(400).json({ error: "Code and name required" });
  try {
    const db = await getPool();
    const roleId = await getWebRoleIdByName(db, normalizeStaffRoleName(type));
    const hash = password ? await bcrypt.hash(String(password), 10) : await bcrypt.hash("password", 10);
    const email = (code + "@pos.local").toLowerCase().replace(/\s/g, "");
    await db.execute(
      `INSERT INTO users (employee_id, name, email, password_hash, role_id, branch_id, nickname, allowance, hourly, 
        budget, commission_rate, incentive_rate, table_incentive, has_quota, quota_amount, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [
        String(code).trim().toUpperCase(), String(name).trim(), email, hash, roleId, branchId,
        nickname || null, Number(allowance) || 0, Number(hourly) || 0,
        Number(budget) || 0, Number(commissionRate) || 0, Number(incentiveRate) || 0, 
        Number(tableIncentive) || 0, hasQuota ? 1 : 0, Number(quotaAmount) || 0
      ]
    );
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id AS code, u.name, u.nickname, u.allowance, u.hourly,
              u.budget, u.commission_rate, u.incentive_rate, u.table_incentive, u.has_quota, u.quota_amount,
              r.name AS type 
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.employee_id = ?`,
      [String(code).trim().toUpperCase()]
    );
    const r = rows[0];
    if (r?.id) logAudit(req, "staff_create", "user", String(r.id), { code: String(code).trim().toUpperCase(), name: String(name).trim() });
    res.status(201).json({
      id: String(r.id), code: r.code, name: r.name, nickname: r.nickname || "", type: r.type,
      allowance: Number(r.allowance), hourly: Number(r.hourly), 
      budget: Number(r.budget || 0), commissionRate: Number(r.commission_rate || 0),
      incentiveRate: Number(r.incentive_rate || 0), tableIncentive: Number(r.table_incentive || 0),
      hasQuota: !!r.has_quota, quotaAmount: Number(r.quota_amount || 0),
      hasLogin: true, status: "active",
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(400).json({ error: "Staff code already exists" });
    console.error("Staff create error:", err);
    res.status(500).json({ error: "Failed to create staff" });
  }
});

app.put("/api/staff/:id", requireAnyPermission("manage_staff"), async (req, res) => {
  const id = req.params.id;
  const { code, name, nickname, type, allowance, hourly, budget, commissionRate, incentiveRate, tableIncentive, hasQuota, quotaAmount, status } = req.body || {};
  if (!code?.trim() || !name?.trim()) return res.status(400).json({ error: "Code and name required" });
  try {
    const branchId = getBranchId(req);
    const db = await getPool();
    const [existingRows] = await db.execute(
      "SELECT id, role_id, commission_rate FROM users WHERE id = ?",
      [id]
    );
    if (!existingRows.length) return res.status(404).json({ error: "Staff not found" });
    const resolvedRoleId =
      type !== undefined
        ? await getWebRoleIdByName(db, normalizeStaffRoleName(type))
        : Number(existingRows[0].role_id);
    await db.execute(
      `UPDATE users SET employee_id=?, name=?, nickname=?, allowance=?, hourly=?, 
        budget=?, commission_rate=?, incentive_rate=?, table_incentive=?, has_quota=?, quota_amount=?,
        active=?, role_id=? WHERE id = ?`,
      [
        String(code || "").trim().toUpperCase(), String(name || "").trim(), nickname || null, 
        Number(allowance) || 0, Number(hourly) || 0,
        Number(budget) || 0, Number(commissionRate) || 0, Number(incentiveRate) || 0,
        Number(tableIncentive) || 0, hasQuota ? 1 : 0, Number(quotaAmount) || 0,
        status === "active" ? 1 : 0, resolvedRoleId, id
      ]
    );
    const [rows] = await db.execute(
      `SELECT u.id, u.employee_id AS code, u.name, u.nickname, u.allowance, u.hourly,
              u.budget, u.commission_rate, u.incentive_rate, u.table_incentive, u.has_quota, u.quota_amount,
              u.active, r.name AS type 
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: "Staff not found" });
    const r = rows[0];
    const previousCommissionRate = Number(existingRows[0].commission_rate || 0);
    const updatedCommissionRate = Number(r.commission_rate || 0);
    let autoRecompute = null;
    if (previousCommissionRate !== updatedCommissionRate) {
      try {
        const { fromDate, toDate } = await resolveCurrentPayrollPeriod(db, branchId);
        const computedResults = await computePayrollForPeriod(db, branchId, fromDate, toDate);
        autoRecompute = {
          ok: true,
          from: fromDate,
          to: toDate,
          computed: computedResults.length,
        };
      } catch (recomputeErr) {
        console.warn("Auto payroll recompute after staff update failed:", recomputeErr.message);
        autoRecompute = {
          ok: false,
          error: recomputeErr.message || "Auto recompute failed",
        };
      }
    }
    logAudit(req, "staff_update", "user", id, { code: r.code, name: r.name });
    res.json({
      id: String(r.id), code: r.code, name: r.name, nickname: r.nickname || "", type: r.type,
      allowance: Number(r.allowance), hourly: Number(r.hourly), 
      budget: Number(r.budget || 0), commissionRate: Number(r.commission_rate || 0),
      incentiveRate: Number(r.incentive_rate || 0), tableIncentive: Number(r.table_incentive || 0),
      hasQuota: !!r.has_quota, quotaAmount: Number(r.quota_amount || 0),
      hasLogin: true, status: r.active === 1 ? "active" : "inactive",
      autoRecompute,
    });
  } catch (err) {
    console.error("Staff update error:", err);
    res.status(500).json({ error: "Failed to update staff" });
  }
});

app.patch("/api/staff/:id/status", requireAnyPermission("manage_staff"), async (req, res) => {
  const id = req.params.id;
  const { status } = req.body || {};
  const active = status === "active" ? 1 : 0;
  try {
    const db = await getPool();
    const [r] = await db.execute("SELECT id FROM users WHERE id = ?", [id]);
    if (!r.length) return res.status(404).json({ error: "Staff not found" });
    await db.execute("UPDATE users SET active = ? WHERE id = ?", [active, id]);
    res.json({ ok: true, status: status === "active" ? "active" : "inactive" });
  } catch (err) {
    console.error("Staff status update error:", err);
    res.status(500).json({ error: "Failed to update status" });
  }
});

app.patch("/api/staff/:id/password", requireAnyPermission("manage_staff"), async (req, res) => {
  const id = req.params.id;
  const { password } = req.body || {};
  if (!password || String(password).trim().length < 4) {
    return res.status(400).json({ error: "Password must be at least 4 characters" });
  }
  try {
    const db = await getPool();
    const hash = await bcrypt.hash(String(password), 10);
    const [result] = await db.execute(
      "UPDATE users SET password_hash = ? WHERE id = ?",
      [hash, id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: "Staff not found" });
    logAudit(req, "staff_password_reset", "user", id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Staff password reset error:", err);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

app.delete("/api/staff/:id", requireAnyPermission("manage_staff"), async (req, res) => {
  const id = req.params.id;
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const [r] = await db.execute("SELECT id FROM users WHERE id = ? AND branch_id = ?", [id, branchId]);
    if (!r.length) return res.status(404).json({ error: "Staff not found" });
    await db.execute("UPDATE order_items SET served_by = NULL WHERE served_by = ?", [id]);
    await db.execute("DELETE FROM users WHERE id = ?", [id]);
    logAudit(req, "staff_delete", "user", id, {});
    res.json({ ok: true });
  } catch (err) {
    console.error("Staff delete error:", err);
    res.status(500).json({ error: "Failed to delete staff" });
  }
});

// ---------- Discounts ----------
app.get("/api/discounts", requireAnyPermission("view_discounts", "approve_discounts", "request_discounts", "manage_pos", "accept_payments"), async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      "SELECT d.id, d.name, d.type, d.category, d.applicable_to AS applicableTo, d.value, d.valid_from AS validFrom, d.valid_to AS validTo, d.status, u.employee_id AS creator FROM discounts d LEFT JOIN users u ON u.id = d.creator_id ORDER BY d.id DESC"
    );
    res.json(rows.map((r) => ({
      ...r,
      id: String(r.id),
      applicableTo: r.applicableTo,
      category: r.category || null,
      validFrom: r.validFrom ? r.validFrom.toISOString().slice(0, 10) : null,
      validTo: r.validTo ? r.validTo.toISOString().slice(0, 10) : null,
      creator: r.creator || "—",
    })));
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") {
      try {
        const db = await getPool();
        const [rows] = await db.execute(
          "SELECT d.id, d.name, d.type, d.applicable_to AS applicableTo, d.value, d.status, u.employee_id AS creator FROM discounts d LEFT JOIN users u ON u.id = d.creator_id ORDER BY d.id DESC"
        );
        return res.json(rows.map((r) => ({ ...r, id: String(r.id), applicableTo: r.applicableTo, category: null, validFrom: null, validTo: null, creator: r.creator || "—" })));
      } catch (e) {
        console.error("Discounts list error:", e);
        return res.status(500).json({ error: "Failed to load discounts" });
      }
    }
    console.error("Discounts list error:", err);
    res.status(500).json({ error: "Failed to load discounts" });
  }
});

app.post("/api/discounts", requireAnyPermission("request_discounts"), async (req, res) => {
  const { name, type, category, applicableTo, value, validFrom, validTo, creatorId } = req.body || {};
  if (!name?.trim() || !value?.trim()) return res.status(400).json({ error: "Name and value required" });
  try {
    const db = await getPool();
    const [r] = await db.execute(
      "INSERT INTO discounts (name, type, category, applicable_to, value, valid_from, valid_to, status, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      [String(name).trim(), type || "Standalone", category || null, applicableTo || "Order", String(value).trim(), validFrom || null, validTo || null, creatorId || 1]
    );
    const [rows] = await db.execute("SELECT id, name, type, category, applicable_to AS applicableTo, value, valid_from AS validFrom, valid_to AS validTo, status FROM discounts WHERE id = ?", [r.insertId]);
    const d = rows[0];
    logAudit(req, "discount_create", "discount", String(d.id), { name: d.name });
    res.status(201).json({
      id: String(d.id), ...d, applicableTo: d.applicableTo,
      validFrom: d.validFrom ? d.validFrom.toISOString().slice(0, 10) : null,
      validTo: d.validTo ? d.validTo.toISOString().slice(0, 10) : null,
      creator: "—",
    });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") {
      const db = await getPool();
      const [r] = await db.execute(
        "INSERT INTO discounts (name, type, applicable_to, value, status, creator_id) VALUES (?, ?, ?, ?, 'pending', ?)",
        [String(name).trim(), type || "Standalone", applicableTo || "Order", String(value).trim(), creatorId || 1]
      );
      const [rows] = await db.execute("SELECT id, name, type, applicable_to AS applicableTo, value, status FROM discounts WHERE id = ?", [r.insertId]);
      const d = rows[0];
      return res.status(201).json({ id: String(d.id), ...d, applicableTo: d.applicableTo, category: null, validFrom: null, validTo: null, creator: "—" });
    }
    console.error("Discount create error:", err);
    res.status(500).json({ error: "Failed to create discount" });
  }
});

app.patch("/api/discounts/:id/approve", requireAnyPermission("approve_discounts"), async (req, res) => {
  try {
    const db = await getPool();
    await db.execute("UPDATE discounts SET status = 'approved' WHERE id = ?", [req.params.id]);
    logAudit(req, "discount_approve", "discount", req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to approve" });
  }
});

app.patch("/api/discounts/:id/reject", requireAnyPermission("approve_discounts"), async (req, res) => {
  try {
    const db = await getPool();
    await db.execute("UPDATE discounts SET status = 'rejected' WHERE id = ?", [req.params.id]);
    logAudit(req, "discount_reject", "discount", req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject" });
  }
});

app.put("/api/discounts/:id", requireAnyPermission("request_discounts", "approve_discounts"), async (req, res) => {
  const id = req.params.id;
  const { name, type, category, applicableTo, value, validFrom, validTo, status } = req.body || {};
  if (!name?.trim() || !value?.trim()) return res.status(400).json({ error: "Name and value required" });
  try {
    const db = await getPool();
    await db.execute(
      `UPDATE discounts 
       SET name = ?, type = ?, category = ?, applicable_to = ?, value = ?, valid_from = ?, valid_to = ?, status = ?
       WHERE id = ?`,
      [
        String(name).trim(),
        type || "Standalone",
        category || null,
        applicableTo || "Order",
        String(value).trim(),
        validFrom || null,
        validTo || null,
        status || "pending",
        id,
      ]
    );
    const [rows] = await db.execute(
      "SELECT id, name, type, category, applicable_to AS applicableTo, value, valid_from AS validFrom, valid_to AS validTo, status FROM discounts WHERE id = ?",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Discount not found" });
    const d = rows[0];
    logAudit(req, "discount_update", "discount", id, { name: d.name });
    res.json({
      id: String(d.id),
      ...d,
      applicableTo: d.applicableTo,
      category: d.category || null,
      validFrom: d.validFrom ? d.validFrom.toISOString().slice(0, 10) : null,
      validTo: d.validTo ? d.validTo.toISOString().slice(0, 10) : null,
      creator: "—",
    });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") {
      try {
        const db = await getPool();
        await db.execute(
          "UPDATE discounts SET name = ?, type = ?, applicable_to = ?, value = ?, status = ? WHERE id = ?",
          [String(name).trim(), type || "Standalone", applicableTo || "Order", String(value).trim(), status || "pending", id]
        );
        const [rows] = await db.execute(
          "SELECT id, name, type, applicable_to AS applicableTo, value, status FROM discounts WHERE id = ?",
          [id]
        );
        if (!rows.length) return res.status(404).json({ error: "Discount not found" });
        const d = rows[0];
        logAudit(req, "discount_update", "discount", id, { name: d.name });
        return res.json({
          id: String(d.id),
          ...d,
          applicableTo: d.applicableTo,
          category: null,
          validFrom: null,
          validTo: null,
          creator: "—",
        });
      } catch (e) {
        console.error("Discount update error:", e);
        return res.status(500).json({ error: "Failed to update discount" });
      }
    }
    console.error("Discount update error:", err);
    res.status(500).json({ error: "Failed to update discount" });
  }
});

app.delete("/api/discounts/:id", requireAnyPermission("request_discounts", "approve_discounts"), async (req, res) => {
  const id = req.params.id;
  try {
    const db = await getPool();
    const [result] = await db.execute("DELETE FROM discounts WHERE id = ?", [id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Discount not found" });
    logAudit(req, "discount_delete", "discount", id);
    res.json({ ok: true });
  } catch (err) {
    console.error("Discount delete error:", err);
    res.status(500).json({ error: "Failed to delete discount" });
  }
});

// ---------- Reports ----------
// Save X/Z report (and other prints) to project prints folder — no "Save As" dialog
const PRINTS_DIR = path.join(__dirname, "..", "prints"); // __dirname set at top for ESM
app.post("/api/reports/save-print", requireAnyPermission("view_reports", "print_shift_report", "manage_pos"), (req, res) => {
  const { type, html } = req.body || {};
  if (!type || !html || typeof html !== "string") {
    return res.status(400).json({ error: "type and html are required" });
  }
  try {
    fs.mkdirSync(PRINTS_DIR, { recursive: true });
    const slug = type.replace(/\s+/g, "-");
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "-");
    const filename = `${slug}_${dateStr}_${timeStr}.html`;
    const filepath = path.join(PRINTS_DIR, filename);
    fs.writeFileSync(filepath, html, "utf8");
    res.json({ ok: true, filename, path: filepath });
  } catch (err) {
    console.error("Save print error:", err);
    res.status(500).json({ error: "Failed to save report to prints folder" });
  }
});

app.get("/api/reports/sales", requireAnyPermission("view_reports"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, dayStartHour, tableId, waiterId, sessionId } = req.query;
  const fromDate = from || localDateString();
  const toDate = to || fromDate;
  const startHour = dayStartHour != null ? Math.min(23, Math.max(0, parseInt(String(dayStartHour), 10) || 0)) : null;
  const filterTableId = tableId != null && String(tableId).trim() !== "" ? String(tableId).trim() : null;
  const filterWaiterId = waiterId != null && String(waiterId).trim() !== "" ? String(waiterId).trim() : null;
  const filterSessionId =
    sessionId != null && String(sessionId).trim() !== "" && Number.isFinite(Number(sessionId))
      ? Number(sessionId)
      : null;
  try {
    const db = await getPool();
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const [settingsRows] = await db.execute(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('tax_rate','card_surcharge','service_charge_mode','service_charge_value')"
    );
    const settingsMap = {};
    for (const row of settingsRows || []) settingsMap[row.setting_key] = row.setting_value;
    const taxRatePct = Math.max(0, Number(settingsMap.tax_rate ?? 0) || 0);
    const cardSurchargeRate = Math.max(0, Number(settingsMap.card_surcharge ?? 0) || 0) / 100;
    const serviceChargeMode = String(settingsMap.service_charge_mode || "percent") === "fixed" ? "fixed" : "percent";
    const serviceChargeValue = Math.max(0, Number(settingsMap.service_charge_value ?? 0) || 0);
    const computeServiceCharge = (baseAmount) =>
      serviceChargeMode === "fixed" ? serviceChargeValue : round2(baseAmount * (serviceChargeValue / 100));
    const sqlRest = ` t.area, t.name AS tableName, o.status, o.subtotal, o.discount, o.tax, o.total, o.payment_method AS paymentMethod,
              o.service_charge AS serviceCharge, o.card_surcharge AS cardSurchargeStored,
              o.employee_id AS employeeId, u.name AS employeeName, u.nickname AS employeeNickname,
              o.order_date AS orderDate, o.created_at AS time, o.updated_at AS updatedAt,
              ts.opened_at AS sessionOpenedAt, ts.closed_at AS sessionClosedAt, ts.status AS sessionStatus,
              ts.waiter_id AS sessionWaiterId, ts.migrated_legacy AS sessionMigratedLegacy,
              wu.name AS sessionWaiterName, wu.nickname AS sessionWaiterNickname
       FROM orders o 
       LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
       LEFT JOIN users u ON u.employee_id = o.employee_id AND u.branch_id = o.branch_id
       LEFT JOIN table_sessions ts ON ts.id = o.session_id
       LEFT JOIN users wu ON wu.employee_id = ts.waiter_id AND wu.branch_id = o.branch_id
       WHERE o.branch_id = ?`;
    const params = [branchId];
    const { sql: dateSql, params: dateParams } = buildRevenueDayAndCreatedFilter({
      startHour,
      fromDate,
      toDate,
      noSessionTsCol: "o.created_at",
      noSessionDateCol: "o.order_date",
    });
    params.push(...dateParams);
    let filterSql = "";
    if (filterTableId) {
      filterSql += ` AND o.table_id = ?`;
      params.push(filterTableId);
    }
    if (filterWaiterId) {
      filterSql += ` AND (ts.waiter_id = ? OR o.employee_id = ?)`;
      params.push(filterWaiterId, filterWaiterId);
    }
    if (filterSessionId != null) {
      filterSql += ` AND o.session_id = ?`;
      params.push(filterSessionId);
    }
    const orderBy = ` ORDER BY o.created_at DESC`;
    let rows;
    try {
      const sql =
        `SELECT o.id, o.table_id AS tableId, o.table_visit_id AS tableVisitId, o.session_id AS sessionId,` +
        sqlRest +
        dateSql +
        filterSql +
        orderBy;
      const [r] = await db.execute(sql, params);
      rows = r;
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR" && e.code !== "ER_NO_SUCH_TABLE") throw e;
      // Fallback without table_sessions / session_id
      const sqlRestLegacy = ` t.area, t.name AS tableName, o.status, o.subtotal, o.discount, o.tax, o.total, o.payment_method AS paymentMethod,
              NULL AS serviceCharge, NULL AS cardSurchargeStored,
              o.employee_id AS employeeId, u.name AS employeeName, u.nickname AS employeeNickname,
              o.order_date AS orderDate, o.created_at AS time, o.updated_at AS updatedAt,
              NULL AS sessionOpenedAt, NULL AS sessionClosedAt, NULL AS sessionStatus,
              NULL AS sessionWaiterId, NULL AS sessionMigratedLegacy,
              NULL AS sessionWaiterName, NULL AS sessionWaiterNickname
       FROM orders o 
       LEFT JOIN pos_tables t ON t.branch_id = o.branch_id AND t.id = o.table_id
       LEFT JOIN users u ON u.employee_id = o.employee_id AND u.branch_id = o.branch_id
       WHERE o.branch_id = ?`;
      const legacyParams = [branchId];
      let legacyDateSql = "";
      if (startHour != null && !isNaN(startHour)) {
        const hourPad = String(startHour).padStart(2, "0");
        const endDate = operationalExclusiveEndDate(fromDate, toDate);
        legacyDateSql =
          ` AND o.created_at >= CONCAT(?, ' ', ?, ':00:00') AND o.created_at < CONCAT(?, ' ', ?, ':00:00')`;
        legacyParams.push(fromDate, hourPad, endDate, hourPad);
      } else {
        legacyDateSql = ` AND o.order_date BETWEEN ? AND ?`;
        legacyParams.push(fromDate, toDate);
      }
      let legacyFilterSql = "";
      if (filterTableId) {
        legacyFilterSql += ` AND o.table_id = ?`;
        legacyParams.push(filterTableId);
      }
      if (filterWaiterId) {
        legacyFilterSql += ` AND o.employee_id = ?`;
        legacyParams.push(filterWaiterId);
      }
      const sql =
        `SELECT o.id, o.table_id AS tableId, o.table_visit_id AS tableVisitId, NULL AS sessionId,` +
        sqlRestLegacy +
        legacyDateSql +
        legacyFilterSql +
        orderBy;
      const [r] = await db.execute(sql, legacyParams);
      rows = r;
    }
    {
      const seenOrderIds = new Set();
      rows = (rows || []).filter((r) => {
        const id = String(r.id);
        if (seenOrderIds.has(id)) return false;
        seenOrderIds.add(id);
        return true;
      });
    }
    const orderIds = rows.map((r) => r.id);
    const complimentaryMap = {};
    const nonVoidedSubtotalMap = {};
    const nonVoidedLineCountMap = {};
    if (orderIds.length > 0) {
      const placeholders = orderIds.map(() => "?").join(",");
      const itemAggRows = await queryWithVoidFallback(
        db,
        `SELECT oi.order_id AS orderId,
                COALESCE(SUM(CASE WHEN COALESCE(oi.is_voided,0) = 0 THEN oi.subtotal ELSE 0 END), 0) AS nonVoidedSubtotal,
                COALESCE(SUM(CASE WHEN COALESCE(oi.is_voided,0) = 0 THEN 1 ELSE 0 END), 0) AS nonVoidedLineCount,
                COALESCE(SUM(CASE WHEN oi.is_complimentary = 1 THEN oi.subtotal ELSE 0 END), 0) AS complimentary
         FROM order_items oi
         WHERE oi.order_id IN (${placeholders}) AND COALESCE(oi.is_voided,0) = 0
         GROUP BY oi.order_id`,
        `SELECT oi.order_id AS orderId,
                COALESCE(SUM(oi.subtotal), 0) AS nonVoidedSubtotal,
                COALESCE(COUNT(*), 0) AS nonVoidedLineCount,
                COALESCE(SUM(CASE WHEN oi.is_complimentary = 1 THEN oi.subtotal ELSE 0 END), 0) AS complimentary
         FROM order_items oi
         WHERE oi.order_id IN (${placeholders})
         GROUP BY oi.order_id`,
        orderIds
      );
      for (const rowAgg of itemAggRows || []) {
        const key = String(rowAgg.orderId);
        complimentaryMap[key] = Number(rowAgg.complimentary || 0);
        nonVoidedSubtotalMap[key] = Number(rowAgg.nonVoidedSubtotal || 0);
        nonVoidedLineCountMap[key] = Number(rowAgg.nonVoidedLineCount || 0);
      }
      rows = rows.filter((r) => {
        const count = nonVoidedLineCountMap[String(r.id)];
        return count == null || count > 0;
      });
    }
    const splitCardMap = {};
    const splitPaidMap = {};
    if (orderIds.length > 0) {
      try {
        const placeholders = orderIds.map(() => "?").join(",");
        const [splitRows] = await db.execute(
          `SELECT order_id AS orderId,
                  COALESCE(SUM(CASE WHEN payment_method IN ('credit','debit') THEN amount ELSE 0 END),0) AS cardAmount,
                  COALESCE(SUM(amount),0) AS paidAmount
           FROM split_payments
           WHERE order_id IN (${placeholders}) AND status = 'paid'
           GROUP BY order_id`,
          orderIds
        );
        for (const sr of splitRows || []) {
          splitCardMap[String(sr.orderId)] = Number(sr.cardAmount || 0);
          splitPaidMap[String(sr.orderId)] = Number(sr.paidAmount || 0);
        }
      } catch {
        // split_payments table may not exist on older DB
      }
    }
    // Prefer first-class session_id; fall back to soft visit grouping for unmigrated rows.
    const withoutSession = rows.filter((r) => r.sessionId == null || !(Number(r.sessionId) > 0));
    assignSalesVisitGroupMeta(withoutSession);

    const formatTime = (value) =>
      value ? new Date(value).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Manila" }) : "—";

    const list = rows.map((r) => {
      const rawTax = Number(r.tax || 0);
      const displayTax = taxRatePct <= 0 ? 0 : rawTax;
      const splitCardAmount = Number(splitCardMap[String(r.id)] || 0);
      const splitPaidAmount = Number(splitPaidMap[String(r.id)] || 0);
      const method = String(r.paymentMethod || "").toLowerCase();
      const orderTotal = Number(r.total || 0);
      const storedCard = r.cardSurchargeStored != null ? Number(r.cardSurchargeStored) : null;
      let estimatedCardSurcharge = 0;
      if (storedCard != null && Number.isFinite(storedCard) && storedCard >= 0) {
        estimatedCardSurcharge = round2(storedCard);
      } else if (method === "credit" || method === "debit") {
        const divisor = 1 + cardSurchargeRate;
        estimatedCardSurcharge = cardSurchargeRate > 0 ? round2(orderTotal - orderTotal / divisor) : 0;
      } else if (method === "split_payment" && splitPaidAmount > 0 && cardSurchargeRate > 0) {
        const cardRatio = Math.min(1, Math.max(0, splitCardAmount / splitPaidAmount));
        const effectiveRate = cardSurchargeRate * cardRatio;
        estimatedCardSurcharge = effectiveRate > 0 ? round2(orderTotal - orderTotal / (1 + effectiveRate)) : 0;
      }
      const itemSubtotal = Number(nonVoidedSubtotalMap[String(r.id)] ?? r.subtotal ?? 0);
      const complimentary = Number(complimentaryMap[String(r.id)] || 0);
      const chargeableSubtotal = Math.max(0, itemSubtotal - complimentary);
      const taxableBase = Math.max(0, chargeableSubtotal - Number(r.discount || 0));
      const storedService = r.serviceCharge != null ? Number(r.serviceCharge) : null;
      const expectedService = storedService != null && Number.isFinite(storedService)
        ? round2(storedService)
        : computeServiceCharge(taxableBase);
      if (estimatedCardSurcharge <= 0 && (storedCard == null || !Number.isFinite(storedCard)) && cardSurchargeRate > 0 && method !== "cash" && method !== "gcash" && method !== "bank" && method !== "charge" && method !== "split_payment") {
        const inferred = round2(orderTotal - taxableBase - expectedService - rawTax);
        estimatedCardSurcharge = Math.max(0, inferred);
      }
      const liveTotal = round2(taxableBase + displayTax + expectedService + estimatedCardSurcharge);
      const adjustedTotal = r.status === "pending"
        ? liveTotal
        : round2(orderTotal - (taxRatePct <= 0 ? rawTax : 0));
      const displayTotal = r.status === "pending" || liveTotal < adjustedTotal - 0.009 ? liveTotal : adjustedTotal;
      const timeMs = r.time ? new Date(r.time).getTime() : 0;
      const sessionIdNum = r.sessionId != null && Number(r.sessionId) > 0 ? Number(r.sessionId) : null;
      const visitAnchor = sessionIdNum != null
        ? sessionIdNum
        : (r._visitAnchor != null ? Number(r._visitAnchor) : Number(r.id));
      const groupKey = sessionIdNum != null ? `session-${sessionIdNum}` : (r._visitGroupKey || `solo-${r.id}`);
      const waiter =
        r.sessionWaiterNickname ||
        r.sessionWaiterName ||
        r.sessionWaiterId ||
        r.employeeNickname ||
        r.employeeName ||
        r.employeeId ||
        "—";
      return {
        id: "ORD-" + r.id,
        tableId: r.tableId,
        area: r.area || "—",
        table: r.tableName != null ? r.tableName : (r.tableId ? `Table ${r.tableId} (removed)` : "—"),
        employee: waiter,
        subtotal: itemSubtotal,
        discount: Number(r.discount),
        complimentary,
        tax: displayTax,
        serviceCharge: expectedService,
        cardSurcharge: estimatedCardSurcharge,
        total: displayTotal,
        status: r.status,
        paymentMethod: r.paymentMethod || null,
        time: formatTime(r.time),
        visitAnchorOrderId: visitAnchor,
        sessionId: sessionIdNum,
        sessionOpenedAt: r.sessionOpenedAt || null,
        sessionClosedAt: r.sessionClosedAt || null,
        sessionStatus: r.sessionStatus || null,
        sessionMigratedLegacy: !!r.sessionMigratedLegacy,
        timeMs,
        _gk: groupKey,
      };
    });
    const forApi = (o) => {
      const { timeMs, _gk, ...rest } = o;
      return rest;
    };
    const byKey = new Map();
    for (const o of list) {
      if (!byKey.has(o._gk)) byKey.set(o._gk, []);
      byKey.get(o._gk).push(o);
    }
    const groups = [];
    for (const ordList of byKey.values()) {
      ordList.sort((a, b) => b.timeMs - a.timeMs);
      const head = ordList[0];
      const uniqEmp = [...new Set(ordList.map((x) => x.employee).filter((e) => e && e !== "—"))];
      const empDisplay =
        uniqEmp.length === 0
          ? "—"
          : uniqEmp.length <= 2
            ? uniqEmp.join(", ")
            : `${uniqEmp[0]} · +${uniqEmp.length - 1}`;
      const activeOrders = ordList.filter((x) => x.status !== "voided");
      const allPaid = activeOrders.length === 0 || activeOrders.every((x) => x.status === "paid");
      const anyPending = activeOrders.some((x) => x.status === "pending");
      const isSessionClosed = head.sessionStatus === "closed" || (!anyPending && activeOrders.length > 0);
      const sessionStatus = head.sessionStatus || (isSessionClosed ? "closed" : "open");
      // Never force "paid" just because the session closed — unpaid tabs stay pending.
      const status = allPaid ? "paid" : "pending";
      const openedMs = head.sessionOpenedAt ? new Date(head.sessionOpenedAt).getTime() : Math.min(...ordList.map((x) => x.timeMs));
      const closedMs = head.sessionClosedAt
        ? new Date(head.sessionClosedAt).getTime()
        : (allPaid ? Math.max(...ordList.map((x) => x.timeMs)) : 0);
      const timeRange =
        openedMs && closedMs && openedMs !== closedMs
          ? `${formatTime(openedMs)} – ${formatTime(closedMs)}`
          : openedMs
            ? formatTime(openedMs)
            : head.time;
      const paymentMethods = [...new Set(ordList.map((x) => x.paymentMethod).filter(Boolean))];
      const paymentDisplay =
        paymentMethods.length === 0
          ? "—"
          : paymentMethods.length <= 2
            ? paymentMethods.join(", ")
            : `${paymentMethods[0]} · +${paymentMethods.length - 1}`;
      const paidList = ordList.filter((x) => x.status === "paid");
      const subtotalG = round2(paidList.reduce((s, x) => s + x.subtotal, 0));
      const discountG = round2(paidList.reduce((s, x) => s + x.discount, 0));
      const complimentaryG = round2(paidList.reduce((s, x) => s + x.complimentary, 0));
      const taxG = round2(paidList.reduce((s, x) => s + x.tax, 0));
      const cardG = round2(paidList.reduce((s, x) => s + x.cardSurcharge, 0));
      const totalG = round2(paidList.reduce((s, x) => s + x.total, 0));
      const openTabsTotalG = round2(
        ordList.filter((x) => x.status === "pending").reduce((s, x) => s + x.total, 0)
      );
      const sessionId = head.sessionId;
      const sessionLabel =
        sessionId != null
          ? ordList.length > 1
            ? `${head.table} · ${ordList.length} orders (session #${sessionId})`
            : `${head.table} · session #${sessionId}`
          : ordList.length > 1
            ? `${head.table} · ${ordList.length} orders (visit #${head.visitAnchorOrderId})`
            : `${head.table} · visit #${head.visitAnchorOrderId}`;
      groups.push({
        groupId: head._gk,
        visitAnchorOrderId: head.visitAnchorOrderId,
        sessionId: sessionId,
        sessionLabel,
        area: head.area,
        table: head.table,
        tableId: head.tableId,
        orderCount: ordList.length,
        employee: empDisplay,
        waiter: empDisplay,
        openedAt: head.sessionOpenedAt || null,
        closedAt: head.sessionClosedAt || null,
        sessionStatus,
        paymentMethod: paymentDisplay,
        migratedLegacy: !!head.sessionMigratedLegacy,
        subtotal: subtotalG,
        discount: discountG,
        complimentary: complimentaryG,
        tax: taxG,
        cardSurcharge: cardG,
        total: totalG,
        openTabsTotal: openTabsTotalG,
        status,
        time: timeRange,
        orders: ordList.map(forApi),
        _sortMs: closedMs || openedMs || head.timeMs,
      });
    }
    groups.sort((a, b) => b._sortMs - a._sortMs);
    for (const g of groups) delete g._sortMs;

    const listForResponse = list.map(forApi);
    const paidForMoney = listForResponse.filter((o) => o.status === "paid");
    const pendingForMoney = listForResponse.filter((o) => o.status === "pending");
    const totalOrders = listForResponse.length;
    const totalSessions = groups.length;
    const totalSales = paidForMoney.reduce((s, o) => s + o.total, 0);
    const totalDiscounts = paidForMoney.reduce((s, o) => s + o.discount, 0);
    const totalComplimentary = paidForMoney.reduce((s, o) => s + o.complimentary, 0);
    const totalTax = paidForMoney.reduce((s, o) => s + o.tax, 0);
    const totalCardSurcharge = paidForMoney.reduce((s, o) => s + o.cardSurcharge, 0);
    const openTabsCount = pendingForMoney.length;
    const openTabsTotal = pendingForMoney.reduce((s, o) => s + o.total, 0);
    const paidOrders = paidForMoney.length;
    res.json({
      list: listForResponse,
      groups,
      summary: {
        totalOrders,
        totalSessions,
        paidOrders,
        totalSales,
        totalDiscounts,
        totalComplimentary,
        totalTax,
        totalCardSurcharge,
        openTabsCount,
        openTabsTotal,
      },
    });
  } catch (err) {
    console.error("Sales report error:", err);
    res.status(500).json({ error: "Failed to load sales report" });
  }
});

// Product report: consumed/sold only (paid, non-voided, non-comp), consolidated by SKU
app.get("/api/reports/products", requireAnyPermission("view_reports"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, dayStartHour, sku, category, tableId, sessionId, sortBy, sortDir } = req.query;
  const fromDate = from || localDateString();
  const toDate = to || fromDate;
  const startHour = dayStartHour != null ? Math.min(23, Math.max(0, parseInt(String(dayStartHour), 10) || 0)) : null;
  const filterSku = sku != null && String(sku).trim() !== "" ? String(sku).trim() : null;
  const filterCategory = category != null && String(category).trim() !== "" && String(category) !== "All"
    ? String(category).trim()
    : null;
  const filterTableId = tableId != null && String(tableId).trim() !== "" ? String(tableId).trim() : null;
  const filterSessionId =
    sessionId != null && String(sessionId).trim() !== "" && Number.isFinite(Number(sessionId))
      ? Number(sessionId)
      : null;
  const sortByVal = String(sortBy || "revenue").toLowerCase();
  const sortAscending = String(sortDir || "desc").toLowerCase() === "asc";

  try {
    const db = await getPool();
    const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const params = [branchId];
    // Same revenue-day rule as Sales (session close → open → no-session fallback).
    // Paid-only: no-session fallback uses updated_at / order_date (bill-out day).
    const { sql: dateSql, params: dateParams } = buildRevenueDayAndCreatedFilter({
      startHour,
      fromDate,
      toDate,
      noSessionTsCol: "o.updated_at",
      noSessionDateCol: "o.order_date",
    });
    params.push(...dateParams);
    let filterSql = ` AND o.status = 'paid' AND o.voided_at IS NULL AND COALESCE(oi.is_voided, 0) = 0 AND COALESCE(oi.is_complimentary, 0) = 0`;
    if (filterSku) {
      filterSql += ` AND (oi.product_sku LIKE ? OR p.sku LIKE ? OR p.name LIKE ? OR oi.product_name LIKE ?)`;
      const likeFilter = `%${filterSku}%`;
      params.push(likeFilter, likeFilter, likeFilter, likeFilter);
    }
    if (filterCategory) {
      filterSql += ` AND p.category = ?`;
      params.push(filterCategory);
    }
    if (filterTableId) {
      filterSql += ` AND o.table_id = ?`;
      params.push(filterTableId);
    }
    if (filterSessionId != null) {
      filterSql += ` AND o.session_id = ?`;
      params.push(filterSessionId);
    }

    let rows;
    try {
      const [r] = await db.execute(
        `SELECT
            COALESCE(oi.product_sku, p.sku, CAST(oi.product_id AS CHAR), oi.product_name) AS skuKey,
            COALESCE(oi.product_sku, p.sku) AS sku,
            COALESCE(p.name, oi.product_name) AS productName,
            p.category AS category,
            oi.product_id AS productId,
            oi.product_price_id AS productPriceId,
            pp.label AS priceLabel,
            oi.unit_price AS unitPrice,
            SUM(oi.quantity) AS quantity,
            SUM(oi.subtotal) AS revenue
         FROM order_items oi
         INNER JOIN orders o ON o.id = oi.order_id
         ${REVENUE_DAY_SESSION_JOIN}
         LEFT JOIN products p ON p.id = oi.product_id
         LEFT JOIN product_prices pp ON pp.id = oi.product_price_id
         WHERE o.branch_id = ?
           ${dateSql}
           ${filterSql}
         GROUP BY skuKey, sku, productName, category, productId, productPriceId, priceLabel, unitPrice`,
        params
      );
      rows = r;
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR" && e.code !== "ER_NO_SUCH_TABLE") throw e;
      const legacyParams = [branchId];
      let legacyDate = "";
      if (startHour != null && !isNaN(startHour)) {
        const hourPad = String(startHour).padStart(2, "0");
        const endDate = operationalExclusiveEndDate(fromDate, toDate);
        legacyDate = ` AND o.updated_at >= CONCAT(?, ' ', ?, ':00:00') AND o.updated_at < CONCAT(?, ' ', ?, ':00:00')`;
        legacyParams.push(fromDate, hourPad, endDate, hourPad);
      } else {
        legacyDate = ` AND o.order_date BETWEEN ? AND ?`;
        legacyParams.push(fromDate, toDate);
      }
      let legacyFilter = ` AND o.status = 'paid' AND COALESCE(oi.is_voided, 0) = 0 AND COALESCE(oi.is_complimentary, 0) = 0`;
      if (filterSku) {
        legacyFilter += ` AND (p.sku LIKE ? OR p.name LIKE ? OR oi.product_name LIKE ?)`;
        const likeFilter = `%${filterSku}%`;
        legacyParams.push(likeFilter, likeFilter, likeFilter);
      }
      if (filterCategory) {
        legacyFilter += ` AND p.category = ?`;
        legacyParams.push(filterCategory);
      }
      if (filterTableId) {
        legacyFilter += ` AND o.table_id = ?`;
        legacyParams.push(filterTableId);
      }
      const [r] = await db.execute(
        `SELECT
            COALESCE(CAST(oi.product_id AS CHAR), oi.product_name) AS skuKey,
            p.sku AS sku,
            COALESCE(p.name, oi.product_name) AS productName,
            p.category AS category,
            oi.product_id AS productId,
            NULL AS productPriceId,
            NULL AS priceLabel,
            oi.unit_price AS unitPrice,
            SUM(oi.quantity) AS quantity,
            SUM(oi.subtotal) AS revenue
         FROM order_items oi
         INNER JOIN orders o ON o.id = oi.order_id
         LEFT JOIN products p ON p.id = oi.product_id
         WHERE o.branch_id = ?
           ${legacyDate}
           ${legacyFilter}
         GROUP BY skuKey, sku, productName, category, productId, unitPrice`,
        legacyParams
      );
      rows = r;
    }

    const bySku = new Map();
    for (const row of rows || []) {
      const key = String(row.skuKey || row.productName || "unknown");
      if (!bySku.has(key)) {
        bySku.set(key, {
          sku: row.sku || key,
          productName: row.productName || "—",
          category: row.category || "—",
          productId: row.productId != null ? String(row.productId) : null,
          quantity: 0,
          revenue: 0,
          variants: [],
        });
      }
      const g = bySku.get(key);
      const qty = Number(row.quantity || 0);
      const rev = Number(row.revenue || 0);
      g.quantity += qty;
      g.revenue = round2(g.revenue + rev);
      g.variants.push({
        priceId: row.productPriceId != null ? String(row.productPriceId) : null,
        label: row.priceLabel || (row.unitPrice != null ? `₱${Number(row.unitPrice).toFixed(2)}` : "—"),
        unitPrice: Number(row.unitPrice || 0),
        quantity: qty,
        revenue: round2(rev),
      });
    }

    const productIds = [...bySku.values()].map((g) => g.productId).filter(Boolean);
    const stockMap = await getStockMap(db, productIds);

    const list = [...bySku.values()].map((g) => ({
      ...g,
      quantity: Number(g.quantity),
      revenue: round2(g.revenue),
      stockQty: g.productId && stockMap[g.productId] != null ? Number(stockMap[g.productId]) : null,
    }));

    list.sort((a, b) => {
      let av, bv;
      if (sortByVal === "quantity") {
        av = a.quantity;
        bv = b.quantity;
      } else if (sortByVal === "sku") {
        av = a.sku || "";
        bv = b.sku || "";
      } else if (sortByVal === "name") {
        av = a.productName || "";
        bv = b.productName || "";
      } else {
        av = a.revenue;
        bv = b.revenue;
      }

      if (typeof av === "string" && typeof bv === "string") {
        return sortAscending ? av.localeCompare(bv) : bv.localeCompare(av);
      } else {
        if (av !== bv) return sortAscending ? av - bv : bv - av;
        return a.productName.localeCompare(b.productName);
      }
    });

    const summary = {
      totalSkus: list.length,
      totalQuantity: list.reduce((s, r) => s + r.quantity, 0),
      totalRevenue: round2(list.reduce((s, r) => s + r.revenue, 0)),
    };
    res.json({ list, summary, definition: "paid_only" });
  } catch (err) {
    console.error("Product report error:", err);
    res.status(500).json({ error: "Failed to load product report" });
  }
});

// Database endpoints
app.post("/api/database/backup", requireAnyPermission("manage_settings"), async (req, res) => {
  try {
    const result = await createDatabaseBackup({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_DATABASE,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error("Manual backup error:", err);
    res.status(500).json({ error: "Failed to create database backup: " + err.message });
  }
});

app.get("/api/database/backups", requireAnyPermission("manage_settings"), async (req, res) => {
  try {
    const list = listBackups();
    res.json(list);
  } catch (err) {
    console.error("List backups error:", err);
    res.status(500).json({ error: "Failed to list backups" });
  }
});

// Shortcut creation endpoint — uses PowerShell -EncodedCommand to avoid quote/semicolon bugs
app.post("/api/system/create-shortcut", requireAnyPermission("manage_settings"), async (req, res) => {
  try {
    if (process.platform !== "win32") {
      return res.status(400).json({ error: "Desktop shortcuts are only supported on Windows" });
    }

    const projectRoot = path.resolve(path.join(__dirname, ".."));
    const batPath = path.join(projectRoot, "start.bat");
    if (!fs.existsSync(batPath)) {
      return res.status(404).json({ error: `start.bat not found at ${batPath}` });
    }

    const iconCandidates = [
      path.join(projectRoot, "public", "rabbit-icon.ico"),
      path.join(projectRoot, "public", "rabbit-icon.svg"),
    ];
    const iconPath = iconCandidates.find((p) => fs.existsSync(p)) || "cmd.exe,0";

    const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    // Resolve real Desktop (handles OneDrive-redirected Desktop folders)
    const psScript = [
      "$desktop = [Environment]::GetFolderPath('Desktop')",
      "if (-not $desktop) { $desktop = Join-Path $env:USERPROFILE 'Desktop' }",
      `$lnk = Join-Path $desktop 'Rabbit Alley POS.lnk'`,
      "$WshShell = New-Object -ComObject WScript.Shell",
      "$Shortcut = $WshShell.CreateShortcut($lnk)",
      `$Shortcut.TargetPath = ${psQuote(batPath)}`,
      `$Shortcut.WorkingDirectory = ${psQuote(projectRoot)}`,
      `$Shortcut.IconLocation = ${psQuote(iconPath)}`,
      "$Shortcut.Save()",
      "if (-not (Test-Path -LiteralPath $lnk)) { throw 'Shortcut file was not created' }",
      "Write-Output $lnk",
    ].join("; ");

    // UTF-16LE base64 avoids nested-quote breakage from powershell -Command "..."
    const encoded = Buffer.from(psScript, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15000 }
    );

    const shortcutPath = String(stdout || "").trim() || path.join(os.homedir(), "Desktop", "Rabbit Alley POS.lnk");
    if (!fs.existsSync(shortcutPath)) {
      return res.status(500).json({ error: "Shortcut command finished but .lnk was not created on Desktop" });
    }

    res.json({ ok: true, message: "Desktop shortcut created successfully", path: shortcutPath });
  } catch (err) {
    console.error("Shortcut creation failed:", err);
    res.status(500).json({ error: "Failed to create desktop shortcut: " + (err.stderr || err.message) });
  }
});

// Void report — Manager/Admin only (approve_voids or view_audit_logs)
app.get("/api/reports/voids", requireAnyPermission("approve_voids", "view_audit_logs"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, dayStartHour, staffId, staffName, product, tableId, q, limit } = req.query;
  const fromDate = from || localDateString();
  const toDate = to || fromDate;
  const startHour =
    dayStartHour != null
      ? Math.min(23, Math.max(0, parseInt(String(dayStartHour), 10) || 0))
      : null;
  const listLimit = Math.min(50000, Math.max(100, parseInt(String(limit || "10000"), 10) || 10000));
  try {
    const db = await getPool();
    const { sql: daySql, params: dayParams } = buildTimestampDayFilter({
      col: "vl.voided_at",
      startHour,
      fromDate,
      toDate,
    });
    const filterParams = [branchId, ...dayParams];
    let filterSql = ` WHERE vl.branch_id = ? ${daySql}`;
    if (staffId != null && String(staffId).trim() !== "") {
      filterSql += ` AND (vl.voided_by = ? OR vl.voided_by_employee_id = ?)`;
      filterParams.push(String(staffId).trim(), String(staffId).trim());
    }
    if (staffName != null && String(staffName).trim() !== "") {
      filterSql += ` AND vl.voided_by_name LIKE ?`;
      filterParams.push(`%${String(staffName).trim()}%`);
    }
    if (product != null && String(product).trim() !== "") {
      const p = `%${String(product).trim()}%`;
      filterSql += ` AND (vl.product_name LIKE ? OR vl.product_sku LIKE ?)`;
      filterParams.push(p, p);
    }
    if (tableId != null && String(tableId).trim() !== "") {
      filterSql += ` AND vl.table_id = ?`;
      filterParams.push(String(tableId).trim());
    }
    if (q != null && String(q).trim() !== "") {
      const s = `%${String(q).trim()}%`;
      filterSql += ` AND (
        vl.product_name LIKE ? OR vl.product_sku LIKE ? OR vl.voided_by_name LIKE ?
        OR vl.reason LIKE ? OR vl.table_id LIKE ? OR CAST(vl.session_id AS CHAR) LIKE ?
      )`;
      filterParams.push(s, s, s, s, s, s);
    }

    // Accurate totals even when the result list is capped.
    const [aggRows] = await db.execute(
      `SELECT COUNT(*) AS totalVoids,
              COALESCE(SUM(vl.quantity), 0) AS totalQuantity,
              COALESCE(SUM(vl.amount), 0) AS totalAmount
       FROM void_log vl
       ${filterSql}`,
      filterParams
    );
    const agg = aggRows[0] || {};
    const totalVoids = Number(agg.totalVoids || 0);
    const totalQuantity = Number(agg.totalQuantity || 0);
    const totalAmount = Math.round(Number(agg.totalAmount || 0) * 100) / 100;

    const listParams = [...filterParams, listLimit];
    const [rows] = await db.execute(
      `SELECT vl.id, vl.void_type AS voidType, vl.order_id AS orderId, vl.order_item_id AS orderItemId,
              vl.product_id AS productId, vl.product_sku AS productSku, vl.product_name AS productName,
              vl.quantity, vl.unit_price AS unitPrice, vl.amount,
              vl.table_id AS tableId, vl.session_id AS sessionId,
              vl.voided_by AS voidedBy, vl.voided_by_name AS voidedByName,
              vl.voided_by_employee_id AS voidedByEmployeeId,
              vl.voided_at AS voidedAt, vl.reason,
              t.name AS tableName, t.area AS tableArea
       FROM void_log vl
       LEFT JOIN pos_tables t ON t.branch_id = vl.branch_id AND t.id = vl.table_id
       ${filterSql}
       ORDER BY vl.voided_at DESC, vl.id DESC
       LIMIT ?`,
      listParams
    );
    const list = (rows || []).map((r) => {
      const voidedAt = r.voidedAt ? new Date(r.voidedAt) : null;
      return {
        id: String(r.id),
        voidType: r.voidType,
        orderId: r.orderId != null ? String(r.orderId) : null,
        orderItemId: r.orderItemId != null ? String(r.orderItemId) : null,
        productId: r.productId != null ? String(r.productId) : null,
        productSku: r.productSku || null,
        productName: r.productName,
        quantity: Number(r.quantity),
        unitPrice: Number(r.unitPrice),
        amount: Number(r.amount),
        tableId: r.tableId || null,
        tableName: r.tableName || r.tableId || "—",
        tableArea: r.tableArea || null,
        sessionId: r.sessionId != null ? Number(r.sessionId) : null,
        voidedBy: r.voidedBy != null ? String(r.voidedBy) : null,
        voidedByName: r.voidedByName || "—",
        voidedByEmployeeId: r.voidedByEmployeeId || null,
        voidedAt: voidedAt ? voidedAt.toISOString() : null,
        voidedAtDisplay: voidedAt
          ? voidedAt.toLocaleString("en-PH", {
              year: "numeric",
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })
          : "—",
        reason: r.reason || "—",
      };
    });
    res.json({
      list,
      summary: {
        totalVoids,
        totalQuantity,
        totalAmount,
        listed: list.length,
        truncated: totalVoids > list.length,
        limit: listLimit,
      },
    });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") {
      return res.json({
        list: [],
        summary: { totalVoids: 0, totalQuantity: 0, totalAmount: 0, listed: 0, truncated: false, limit: listLimit },
      });
    }
    console.error("Void report error:", err);
    res.status(500).json({ error: "Failed to load void report" });
  }
});

app.get("/api/reports/payroll", requireAnyPermission("view_payroll", "manage_payroll", "view_reports"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, dayStartHour } = req.query;
  const fromDate = from || localDateString();
  const toDate = to || fromDate;
  const startHour =
    dayStartHour != null
      ? Math.min(23, Math.max(0, parseInt(String(dayStartHour), 10) || 0))
      : null;
  const { sql: dateSqlRaw, params: dateParams } = buildRevenueDayAndCreatedFilter({
    startHour,
    fromDate,
    toDate,
    noSessionTsCol: "o.updated_at",
    noSessionDateCol: "o.order_date",
  });
  const dateClause = dateSqlRaw.replace(/^\s*AND\s*/, "");
  const { periodFrom, periodTo } = preferredPayoutPeriod(fromDate, toDate, startHour);
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT p.id, p.user_id AS userId, u.employee_id AS employeeId, u.name, u.allowance AS defaultAllowance, u.hourly AS perHour,
       p.allowance, p.hours, p.commission, p.incentives, p.adjustments, p.deductions,
       p.incentives_breakdown, p.adjustments_breakdown, p.deductions_breakdown,
       p.total, p.status, p.approved_by AS approvedById,
       approver.name AS approvedBy
       FROM payouts p
       JOIN users u ON u.id = p.user_id AND u.branch_id = ? AND u.active = 1
       ${LATEST_PAYOUT_PER_USER_JOIN}
       LEFT JOIN users approver ON approver.id = p.approved_by
       ORDER BY u.name, p.id`,
      [branchId, ...latestPayoutPerUserParams(branchId, periodFrom, periodTo, fromDate, toDate)]
    );
    const payoutRows = dedupePayrollRows(rows);
    const parseBreakdown = (v) => {
      if (!v) return null;
      try { return Array.isArray(typeof v === "string" ? JSON.parse(v) : v) ? (typeof v === "string" ? JSON.parse(v) : v) : null; } catch (_) { return null; }
    };
    // Attribute by served_by (users.id) or, when unset, order opener employee_id (string code).
    const ldCountRows = await queryWithVoidFallback(
      db,
      `SELECT oi.served_by AS servedBy, o.employee_id AS employeeId,
              SUM(oi.quantity) AS ldCount,
              SUM(oi.subtotal) AS ldAmount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND o.status = 'paid'
         AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
         AND COALESCE(oi.is_voided,0) = 0
         AND ${PAYROLL_LD_NON_COMP_SQL}
       GROUP BY oi.served_by, o.employee_id`,
      `SELECT oi.served_by AS servedBy, o.employee_id AS employeeId,
              SUM(oi.quantity) AS ldCount,
              SUM(oi.subtotal) AS ldAmount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND o.status = 'paid'
       GROUP BY oi.served_by, o.employee_id`,
      [branchId, ...dateParams]
    );
    const ldCountRealtimeRows = await queryWithVoidFallback(
      db,
      `SELECT oi.served_by AS servedBy, o.employee_id AS employeeId,
              SUM(oi.quantity) AS ldCountRealtime
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
         AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
         AND COALESCE(oi.is_voided,0) = 0
         AND ${PAYROLL_LD_NON_COMP_SQL}
       GROUP BY oi.served_by, o.employee_id`,
      `SELECT oi.served_by AS servedBy, o.employee_id AS employeeId,
              SUM(oi.quantity) AS ldCountRealtime
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
       GROUP BY oi.served_by, o.employee_id`,
      [branchId, ...dateParams]
    );
    // Branch-wide qty (every LD line, including unassigned served_by/employee)
    const ldQtyAggRows = await queryWithVoidFallback(
      db,
      `SELECT COALESCE(SUM(CASE WHEN o.status = 'paid' THEN oi.quantity ELSE 0 END), 0) AS totalLdQtyPaid,
              COALESCE(SUM(CASE WHEN o.status = 'pending' THEN oi.quantity ELSE 0 END), 0) AS totalLdQtyOpen,
              COALESCE(SUM(oi.quantity), 0) AS totalLdQtyRealtime
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
         AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
         AND COALESCE(oi.is_voided,0) = 0
         AND ${PAYROLL_LD_NON_COMP_SQL}`,
      `SELECT COALESCE(SUM(CASE WHEN o.status = 'paid' THEN oi.quantity ELSE 0 END), 0) AS totalLdQtyPaid,
              COALESCE(SUM(CASE WHEN o.status = 'pending' THEN oi.quantity ELSE 0 END), 0) AS totalLdQtyOpen,
              COALESCE(SUM(oi.quantity), 0) AS totalLdQtyRealtime
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}`,
      [branchId, ...dateParams]
    );
    const ldCountMap = {};
    const ldAmountMap = {};
    const ldCountRealtimeMap = {};
    const ldCountByEmp = {};
    const ldAmountByEmp = {};
    const ldCountRealtimeByEmp = {};
    const pickNum = (row, camel, snake) => Number(row?.[camel] ?? row?.[snake] ?? 0);
    const addLdMaps = (rowsIn, mode) => {
      for (const r of rowsIn || []) {
        const servedBy = r.servedBy ?? r.served_by;
        const empId = r.employeeId ?? r.employee_id;
        const qty = mode === "paid"
          ? pickNum(r, "ldCount", "ldcount")
          : pickNum(r, "ldCountRealtime", "ldcountrealtime");
        const amt = mode === "paid" ? pickNum(r, "ldAmount", "ldamount") : 0;
        if (servedBy != null && servedBy !== "") {
          const key = String(servedBy);
          if (mode === "paid") {
            ldCountMap[key] = (ldCountMap[key] || 0) + qty;
            ldAmountMap[key] = (ldAmountMap[key] || 0) + amt;
          } else {
            ldCountRealtimeMap[key] = (ldCountRealtimeMap[key] || 0) + qty;
          }
        } else if (empId != null && empId !== "") {
          const key = String(empId);
          if (mode === "paid") {
            ldCountByEmp[key] = (ldCountByEmp[key] || 0) + qty;
            ldAmountByEmp[key] = (ldAmountByEmp[key] || 0) + amt;
          } else {
            ldCountRealtimeByEmp[key] = (ldCountRealtimeByEmp[key] || 0) + qty;
          }
        }
      }
    };
    addLdMaps(ldCountRows, "paid");
    addLdMaps(ldCountRealtimeRows, "realtime");
    const agg0 = (ldQtyAggRows && ldQtyAggRows[0]) || {};
    const totalLdQtyPaid = pickNum(agg0, "totalLdQtyPaid", "totalldqtypaid");
    const totalLdQtyOpen = pickNum(agg0, "totalLdQtyOpen", "totalldqtyopen");
    const totalLdQtyRealtime = pickNum(agg0, "totalLdQtyRealtime", "totalldqtyrealtime");
    const openLdTableRows = await queryWithVoidFallback(
      db,
      `SELECT COALESCE(o.table_id, '—') AS tableId, SUM(oi.quantity) AS ldCount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND o.status = 'pending' AND (ts.id IS NULL OR ts.closed_at IS NULL)
         AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
         AND COALESCE(oi.is_voided,0) = 0
         AND ${PAYROLL_LD_NON_COMP_SQL}
       GROUP BY o.table_id
       HAVING SUM(oi.quantity) > 0`,
      `SELECT COALESCE(o.table_id, '—') AS tableId, SUM(oi.quantity) AS ldCount
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND o.status = 'pending' AND (ts.id IS NULL OR ts.closed_at IS NULL)
       GROUP BY o.table_id
       HAVING SUM(oi.quantity) > 0`,
      [branchId, ...dateParams]
    );
    const openLdTables = (openLdTableRows || [])
      .map((r) => ({
        tableId: String(r.tableId ?? r.tableid ?? "—"),
        ldCount: pickNum(r, "ldCount", "ldcount"),
      }))
      .filter((t) => t.ldCount > 0);
    try {
      const [posRows] = await db.execute(`SELECT id, name FROM pos_tables WHERE branch_id = ?`, [branchId]);
      for (const t of openLdTables) {
        const resolved = resolvePosTableForOrderTableId(t.tableId, posRows);
        t.tableCode = resolved?.name || t.tableId;
      }
    } catch {
      for (const t of openLdTables) t.tableCode = t.tableId;
    }
    const userIds = payoutRows.map((r) => r.userId).filter(Boolean);
    let timeInMap = {};
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const { sql: attSqlRaw, params: attParams } = buildTimestampDayFilter({
        col: "a.time_in",
        startHour,
        fromDate,
        toDate,
      });
      const attClause = attSqlRaw.replace(/^\s*AND\s*/, "");
      const [attRows] = await db.execute(
        `SELECT a.user_id AS userId, MIN(a.time_in) AS timeIn FROM attendance a
         WHERE ${attClause} AND a.user_id IN (${placeholders}) GROUP BY a.user_id`,
        [...attParams, ...userIds]
      ).catch(() => []);
      for (const a of (attRows || [])) {
        if (a.userId) timeInMap[String(a.userId)] = a.timeIn;
      }
    }
    const mapRow = (r) => {
      const incB = parseBreakdown(r.incentives_breakdown);
      const adjB = parseBreakdown(r.adjustments_breakdown);
      const dedB = parseBreakdown(r.deductions_breakdown);
      const budget = Number(r.allowance ?? 0);
      const commission = Number(r.commission ?? 0);
      const incentives = Number(r.incentives ?? 0);
      const otherIncentives = Array.isArray(incB) ? incB.reduce((s, x) => s + Number(x.amount || 0), 0) : 0;
      const adjustments = Number(r.adjustments ?? 0);
      const deductions = Number(r.deductions ?? 0);
      const gross = computePayslipGross(r);
      const netPayout = gross - deductions;
      const timeIn = timeInMap[String(r.userId)];
      return {
        id: String(r.id),
        userId: String(r.userId),
        employeeId: r.employeeId,
        name: r.name,
        timeIn: timeIn ? new Date(timeIn).toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Manila" }) : null,
        defaultAllowance: Number(r.defaultAllowance ?? 0),
        perHour: 0,
        allowance: budget,
        hours: 0,
        commission,
        ldCount: ldCountMap[String(r.userId)] ?? ldCountByEmp[String(r.employeeId)] ?? 0,
        ldCountRealtime: ldCountRealtimeMap[String(r.userId)] ?? ldCountRealtimeByEmp[String(r.employeeId)] ?? 0,
        ldAmount: ldAmountMap[String(r.userId)] ?? ldAmountByEmp[String(r.employeeId)] ?? 0,
        incentives,
        adjustments,
        deductions,
        incentivesBreakdown: incB,
        adjustmentsBreakdown: adjB,
        deductionsBreakdown: dedB,
        gross,
        total: Number(r.total ?? 0),
        netPayout,
        status: r.status,
        approvedBy: r.approvedBy || null,
      };
    };
    res.json({
      rows: payoutRows.map(mapRow),
      totalLdQtyPaid,
      totalLdQtyOpen,
      totalLdQtyRealtime,
      openLdTables,
    });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") {
      try {
        const db = await getPool();
        const branchId = getBranchId(req);
        const [rows] = await db.execute(
          `SELECT p.id, p.user_id AS userId, u.employee_id AS employeeId, u.name, u.allowance AS defaultAllowance, u.hourly AS perHour,
           p.allowance, p.hours, p.commission, p.incentives, p.total, p.status
           FROM payouts p
           JOIN users u ON u.id = p.user_id AND u.branch_id = ? AND u.active = 1
           ${LATEST_PAYOUT_PER_USER_JOIN}
           ORDER BY u.name, p.id`,
          [branchId, ...latestPayoutPerUserParams(branchId, periodFrom, periodTo, fromDate, toDate)]
        );
        return res.json({
          rows: rows.map((r) => ({
            id: String(r.id), userId: String(r.userId), employeeId: r.employeeId, name: r.name,
            defaultAllowance: Number(r.defaultAllowance ?? 0), perHour: 0,
            allowance: Number(r.allowance), hours: 0, commission: Number(r.commission),
            incentives: Number(r.incentives ?? 0), adjustments: 0, deductions: 0,
            incentivesBreakdown: null, adjustmentsBreakdown: null, deductionsBreakdown: null,
            total: Number(r.total), netPayout: Number(r.allowance) + Number(r.commission) + Number(r.incentives ?? 0), status: r.status, approvedBy: null,
          })),
          totalLdQtyPaid: 0,
          totalLdQtyOpen: 0,
          totalLdQtyRealtime: 0,
          openLdTables: [],
        });
      } catch (e) {
        console.error("Payroll report error:", e);
        return res.status(500).json({ error: "Failed to load payroll report" });
      }
    }
    console.error("Payroll report error:", err);
    res.status(500).json({ error: "Failed to load payroll report" });
  }
});

app.patch("/api/reports/payroll/:id", requireAnyPermission("manage_payroll", "adjust_payouts"), async (req, res) => {
  const id = req.params.id;
  const { incentives, adjustments, deductions, incentivesBreakdown, adjustmentsBreakdown, deductionsBreakdown } = req.body || {};
  try {
    const db = await getPool();
    const updates = [];
    const params = [];
    let adjVal = adjustments;
    let dedVal = deductions;
    if (Array.isArray(incentivesBreakdown)) {
      const sanitized = incentivesBreakdown.filter((x) => x && typeof x.title === "string" && typeof x.amount === "number").map((x) => ({ title: String(x.title).slice(0, 128), amount: Number(x.amount) }));
      updates.push("incentives_breakdown = ?");
      params.push(JSON.stringify(sanitized));
    }
    if (incentives !== undefined) {
      updates.push("incentives = ?");
      params.push(Number(incentives) ?? 0);
    }
    if (Array.isArray(adjustmentsBreakdown)) {
      const sanitized = adjustmentsBreakdown.filter((x) => x && typeof x.title === "string" && typeof x.amount === "number").map((x) => ({ title: String(x.title).slice(0, 128), amount: Number(x.amount) }));
      updates.push("adjustments_breakdown = ?");
      params.push(JSON.stringify(sanitized));
      adjVal = sanitized.reduce((s, x) => s + x.amount, 0);
    }
    if (Array.isArray(deductionsBreakdown)) {
      const sanitized = deductionsBreakdown.filter((x) => x && typeof x.title === "string" && typeof x.amount === "number").map((x) => ({ title: String(x.title).slice(0, 128), amount: Number(x.amount) }));
      updates.push("deductions_breakdown = ?");
      params.push(JSON.stringify(sanitized));
      dedVal = sanitized.reduce((s, x) => s + x.amount, 0);
    }
    if (adjustments !== undefined) { updates.push("adjustments = ?"); params.push(Number(adjustments) ?? adjVal ?? 0); }
    else if (adjVal !== undefined) { updates.push("adjustments = ?"); params.push(Number(adjVal)); }
    if (deductions !== undefined) { updates.push("deductions = ?"); params.push(Number(deductions) ?? dedVal ?? 0); }
    else if (dedVal !== undefined) { updates.push("deductions = ?"); params.push(Number(dedVal)); }
    if (params.length) {
      params.push(id);
      await db.execute(`UPDATE payouts SET ${updates.join(", ")} WHERE id = ?`, params);
    }
    const [rows] = await db.execute(
      "SELECT allowance, commission, incentives, incentives_breakdown, adjustments, deductions FROM payouts WHERE id = ?",
      [id]
    );
    if (rows.length) {
      const r = rows[0];
      let otherInc = 0;
      try {
        const b = r.incentives_breakdown ? (typeof r.incentives_breakdown === "string" ? JSON.parse(r.incentives_breakdown) : r.incentives_breakdown) : [];
        otherInc = Array.isArray(b) ? b.reduce((s, x) => s + Number(x.amount || 0), 0) : 0;
      } catch (_) {}
      const total = Number(r.allowance) + Number(r.commission) + Number(r.incentives ?? 0) + otherInc + Number(r.adjustments ?? 0) - Number(r.deductions ?? 0);
      await db.execute("UPDATE payouts SET total = ? WHERE id = ?", [total, id]);
    }
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") {
      const db = await getPool();
      const up = [];
      const p = [];
      if (incentives !== undefined) { up.push("incentives = ?"); p.push(Number(incentives) || 0); }
      if (adjustments !== undefined) { up.push("adjustments = ?"); p.push(Number(adjustments) || 0); }
      if (deductions !== undefined) { up.push("deductions = ?"); p.push(Number(deductions) || 0); }
      if (p.length) { p.push(id); await db.execute(`UPDATE payouts SET ${up.join(", ")} WHERE id = ?`, p); }
      const [rows] = await db.execute("SELECT allowance, commission, incentives FROM payouts WHERE id = ?", [id]);
      if (rows.length) {
        const rr = rows[0];
        const total = Number(rr.allowance) + Number(rr.commission) + Number(rr.incentives || 0);
        await db.execute("UPDATE payouts SET total = ? WHERE id = ?", [total, id]);
      }
      return res.json({ ok: true });
    }
    console.error("Payroll update error:", err);
    res.status(500).json({ error: "Failed to update payout" });
  }
});

app.patch("/api/reports/payroll/:id/approve", requireAnyPermission("manage_payroll", "adjust_payouts"), async (req, res) => {
  const { approvedBy } = req.body || {};
  try {
    const db = await getPool();
    await db.execute("UPDATE payouts SET status = 'approved', approved_by = ? WHERE id = ?", [approvedBy || null, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "ER_BAD_FIELD_ERROR") {
      await (await getPool()).execute("UPDATE payouts SET status = 'approved' WHERE id = ?", [req.params.id]);
      return res.json({ ok: true });
    }
    res.status(500).json({ error: "Failed to approve payout" });
  }
});

// Get single payout for payslip view/print
app.get("/api/reports/payroll/:id", requireAnyPermission("view_payroll", "manage_payroll", "view_reports"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const id = req.params.id;
    const [rows] = await db.execute(
      `SELECT p.id, p.user_id AS userId, u.employee_id AS employeeId, u.name, u.allowance AS defaultAllowance, u.hourly AS perHour,
       p.period_from AS periodFrom, p.period_to AS periodTo,
       p.allowance, p.hours, p.commission, p.incentives, p.adjustments, p.deductions,
       p.incentives_breakdown, p.adjustments_breakdown, p.deductions_breakdown,
       p.total, p.status, p.approved_by AS approvedById,
       approver.name AS approvedBy
       FROM payouts p
       JOIN users u ON u.id = p.user_id AND u.branch_id = ?
       LEFT JOIN users approver ON approver.id = p.approved_by
       WHERE p.id = ?`,
      [branchId, id]
    );
    if (!rows.length) return res.status(404).json({ error: "Payout not found" });
    const r = rows[0];
    const parseB = (v) => { try { const x = v ? (typeof v === "string" ? JSON.parse(v) : v) : null; return Array.isArray(x) ? x : null; } catch (_) { return null; } };
    const gross = computePayslipGross(r);
    const net = computePayslipNet(r);
    res.json({
      id: String(r.id),
      userId: String(r.userId),
      employeeId: r.employeeId,
      name: r.name,
      defaultAllowance: Number(r.defaultAllowance ?? 0),
      perHour: 0,
      periodFrom: r.periodFrom,
      periodTo: r.periodTo,
      allowance: Number(r.allowance),
      hours: 0,
      commission: Number(r.commission),
      incentives: Number(r.incentives ?? 0),
      adjustments: Number(r.adjustments ?? 0),
      deductions: Number(r.deductions ?? 0),
      incentivesBreakdown: parseB(r.incentives_breakdown),
      adjustmentsBreakdown: parseB(r.adjustments_breakdown),
      deductionsBreakdown: parseB(r.deductions_breakdown),
      gross,
      total: Number(r.total),
      netPayout: net,
      status: r.status,
      approvedBy: r.approvedBy || null,
    });
  } catch (err) {
    console.error("Get payout error:", err);
    res.status(500).json({ error: "Failed to load payout" });
  }
});

// LD count per table for one staff member (payroll name click — shows table breakdown)
app.get("/api/reports/payroll/:id/ld-by-table", requireAnyPermission("view_payroll", "manage_payroll", "view_reports"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, dayStartHour } = req.query;
  try {
    const db = await getPool();
    const id = req.params.id;
    const [payoutRows] = await db.execute(
      `SELECT p.user_id AS userId, u.employee_id AS employeeId, u.name, u.incentive_rate AS incentiveRate,
              DATE_FORMAT(p.period_from, '%Y-%m-%d') AS periodFrom,
              DATE_FORMAT(p.period_to, '%Y-%m-%d') AS periodTo
       FROM payouts p
       JOIN users u ON u.id = p.user_id AND u.branch_id = ?
       WHERE p.id = ?`,
      [branchId, id]
    );
    if (!payoutRows.length) return res.status(404).json({ error: "Payout not found" });
    const p = payoutRows[0];
    const fromDate = (typeof from === "string" && from.slice(0, 10)) || String(p.periodFrom).slice(0, 10);
    const toDate = (typeof to === "string" && to.slice(0, 10)) || String(p.periodTo).slice(0, 10);
    const startHour =
      dayStartHour != null
        ? Math.min(23, Math.max(0, parseInt(String(dayStartHour), 10) || 0))
        : null;
    const { sql: dateSqlRaw, params: dateParams } = buildRevenueDayAndCreatedFilter({
      startHour,
      fromDate,
      toDate,
      noSessionTsCol: "o.updated_at",
      noSessionDateCol: "o.order_date",
    });
    const dateClause = dateSqlRaw.replace(/^\s*AND\s*/, "");

    const totalLdRows = await queryWithVoidFallback(
      db,
      `SELECT COALESCE(SUM(oi.quantity),0) AS totalLd
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
     WHERE o.branch_id = ? AND oi.department = 'LD'
       AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}
       AND ${PAYROLL_LD_ORDER_NOT_VOID_SQL}
       AND COALESCE(oi.is_voided,0) = 0
       AND ${PAYROLL_LD_NON_COMP_SQL}`,
      `SELECT COALESCE(SUM(oi.quantity),0) AS totalLd
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       ${REVENUE_DAY_SESSION_JOIN}
       WHERE o.branch_id = ? AND oi.department = 'LD'
         AND ${dateClause} AND ${PAYROLL_LD_STATUS_SQL}`,
      [branchId, ...dateParams]
    );
    const totalLdAll = Number(totalLdRows[0]?.totalLd ?? 0);

    const staffParams = [p.userId, p.employeeId];
    const tables = await buildPayrollLdTableBreakdown(db, branchId, dateClause, dateParams, staffParams);
    const ownLdCount = tables.reduce((s, t) => s + t.ldCount, 0);
    const incentiveRate = Number(p.incentiveRate ?? 0);

    res.json({
      name: p.name,
      totalLdAll,
      ownLdCount,
      incentiveRate,
      incentives: totalLdAll * incentiveRate,
      tables,
    });
  } catch (err) {
    console.error("Payroll LD-by-table error:", err);
    res.status(500).json({ error: "Failed to load LD breakdown" });
  }
});

// Compute payouts for all staff (creates/updates payout records; scoped by branch)
// Commission = staff commission_rate × this staff's LD count (paid + open/pending)
// Incentive = incentive_rate × branch-wide total LD count (kabuuan) + table_incentive × distinct tables
// Quota (optional): if has_quota and LD sales amount < quota_amount, commission/incentives/table pay = 0
app.post("/api/reports/payroll/compute", requireAnyPermission("manage_payroll", "compute_daily_payouts"), async (req, res) => {
  const branchId = getBranchId(req);
  const { from, to, dayStartHour } = req.body || {};
  const fromDate = from || localDateString();
  const toDate = to || fromDate;
  
  try {
    const db = await getPool();
    const results = await computePayrollForPeriod(db, branchId, fromDate, toDate, dayStartHour);
    res.json({ ok: true, computed: results.length, results });
  } catch (err) {
    console.error("Compute payouts error:", err);
    res.status(500).json({ error: "Failed to compute payouts" });
  }
});

// ============================================================================
// ATTENDANCE (TIME TRACKING)
// ============================================================================

// Clock in – create or update today's row with time_in (always for authenticated user)
app.post("/api/attendance/clock-in", requireAnyPermission("access_attendance"), async (req, res) => {
  const userId = req.authUser?.id;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const db = await getPool();
    const today = localDateString();
    const now = new Date();
    await db.execute(
      `INSERT INTO attendance (user_id, work_date, time_in, break_minutes) VALUES (?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE time_in = VALUES(time_in), time_out = NULL, break_minutes = 0, updated_at = NOW()`,
      [userId, today, now]
    );
    const [rows] = await db.execute(
      `SELECT id, user_id AS userId, work_date AS workDate, time_in AS timeIn, time_out AS timeOut, break_minutes AS breakMinutes
       FROM attendance WHERE user_id = ? AND work_date = ?`,
      [userId, today]
    );
    const r = rows[0];
    res.json({
      id: r.id,
      userId: String(r.userId),
      workDate: r.workDate,
      timeIn: r.timeIn,
      timeOut: r.timeOut || null,
      breakMinutes: r.breakMinutes || 0,
    });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ error: "Attendance table not found. Run server/schema.sql in MySQL" });
    console.error("Clock-in error:", err);
    res.status(500).json({ error: "Failed to clock in" });
  }
});

// Clock out – set time_out for today's row (always for authenticated user)
app.post("/api/attendance/clock-out", requireAnyPermission("access_attendance"), async (req, res) => {
  const userId = req.authUser?.id;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const db = await getPool();
    const today = localDateString();
    const now = new Date();
    const [result] = await db.execute(
      `UPDATE attendance SET time_out = ?, updated_at = NOW() WHERE user_id = ? AND work_date = ?`,
      [now, userId, today]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "No clock-in found for today. Clock in first." });
    }
    const [rows] = await db.execute(
      `SELECT id, user_id AS userId, work_date AS workDate, time_in AS timeIn, time_out AS timeOut, break_minutes AS breakMinutes
       FROM attendance WHERE user_id = ? AND work_date = ?`,
      [userId, today]
    );
    const r = rows[0];
    res.json({
      id: r.id,
      userId: String(r.userId),
      workDate: r.workDate,
      timeIn: r.timeIn,
      timeOut: r.timeOut,
      breakMinutes: r.breakMinutes || 0,
    });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ error: "Attendance table not found. Run server/schema.sql in MySQL" });
    console.error("Clock-out error:", err);
    res.status(500).json({ error: "Failed to clock out" });
  }
});

// Get today's attendance for authenticated user (for UI state)
app.get("/api/attendance/today", requireAnyPermission("access_attendance"), async (req, res) => {
  const userId = req.authUser?.id;
  if (!userId) return res.status(401).json({ error: "Not authenticated" });
  try {
    const db = await getPool();
    const today = localDateString();
    const [rows] = await db.execute(
      `SELECT id, user_id AS userId, work_date AS workDate, time_in AS timeIn, time_out AS timeOut, break_minutes AS breakMinutes
       FROM attendance WHERE user_id = ? AND work_date = ?`,
      [userId, today]
    );
    if (!rows.length) return res.json(null);
    const r = rows[0];
    res.json({
      id: r.id,
      userId: String(r.userId),
      workDate: r.workDate,
      timeIn: r.timeIn,
      timeOut: r.timeOut || null,
      breakMinutes: r.breakMinutes || 0,
    });
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.json(null);
    console.error("Get today attendance error:", err);
    res.status(500).json({ error: "Failed to load attendance" });
  }
});

// List attendance for period (own records unless manage_staff)
app.get("/api/attendance", requireAnyPermission("access_attendance", "manage_staff", "view_payroll"), async (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || localDateString();
  const toDate = to || fromDate;
  const canViewAll = req.authUser?.permissions?.includes("manage_staff") || req.authUser?.permissions?.includes("view_payroll");
  const userId = canViewAll && req.query.userId ? req.query.userId : req.authUser?.id;
  try {
    const db = await getPool();
    let sql = `SELECT a.id, a.user_id AS userId, u.employee_id AS employeeId, u.name,
       a.work_date AS workDate, a.time_in AS timeIn, a.time_out AS timeOut, a.break_minutes AS breakMinutes
       FROM attendance a JOIN users u ON u.id = a.user_id
       WHERE a.work_date BETWEEN ? AND ?`;
    const params = [fromDate, toDate];
    if (userId) {
      sql += " AND a.user_id = ?";
      params.push(userId);
    } else if (!canViewAll) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    sql += " ORDER BY a.work_date DESC, a.time_in DESC";
    const [rows] = await db.execute(sql, params);
    res.json(rows.map((r) => ({
      id: r.id,
      userId: String(r.userId),
      employeeId: r.employeeId,
      name: r.name,
      workDate: r.workDate,
      timeIn: r.timeIn,
      timeOut: r.timeOut || null,
      breakMinutes: r.breakMinutes || 0,
    })));
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.json([]);
    console.error("List attendance error:", err);
    res.status(500).json({ error: "Failed to load attendance" });
  }
});

// ============================================================================
// SHIFT MANAGEMENT ENDPOINTS
// ============================================================================

// Get current open shift for authenticated user
app.get("/api/shifts/current", requireAnyPermission("close_shift", "view_shift_summary"), async (req, res) => {
  try {
    const db = await getPool();
    const userId = req.authUser?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    
    const [rows] = await db.execute(
      `SELECT * FROM shifts WHERE user_id = ? AND status = 'open' ORDER BY start_time DESC LIMIT 1`,
      [userId]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error("Get current shift error:", err);
    res.status(500).json({ error: "Failed to get current shift" });
  }
});

// Open a new shift for authenticated user
app.post("/api/shifts/open", requireAnyPermission("close_shift"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const userId = req.authUser?.id;
    const { openingCash } = req.body || {};
    if (!userId) return res.status(401).json({ error: "Not authenticated" });
    
    const [existing] = await db.execute(
      `SELECT id FROM shifts WHERE user_id = ? AND status = 'open'`,
      [userId]
    );
    if (existing.length > 0) {
      return res.status(400).json({ error: "User already has an open shift" });
    }
    
    const now = new Date();
    const [result] = await db.execute(
      `INSERT INTO shifts (user_id, branch_id, shift_date, start_time, opening_cash, status) VALUES (?, ?, ?, ?, ?, 'open')`,
      [userId, branchId, localDateString(now), now, openingCash || 0]
    );
    
    const [newShift] = await db.execute(`SELECT * FROM shifts WHERE id = ?`, [result.insertId]);
    res.json(newShift[0]);
  } catch (err) {
    console.error("Open shift error:", err);
    res.status(500).json({ error: "Failed to open shift" });
  }
});

// Get shift summary (X reading - running totals)
app.get("/api/shifts/:id/summary", requireAnyPermission("close_shift", "view_shift_summary"), async (req, res) => {
  try {
    const db = await getPool();
    const shiftId = req.params.id;
    const branchId = getBranchId(req);
    
    const [shift] = await db.execute(`SELECT * FROM shifts WHERE id = ? AND branch_id = ?`, [shiftId, branchId]);
    if (!shift[0]) return res.status(404).json({ error: "Shift not found" });
    
    // Get sales totals since shift started (same branch as shift)
    const tenders = await getShiftTenderSales(db, shift[0].branch_id, shift[0].start_time);
    const collections = await getShiftChargeCollections(db, shift[0].branch_id, shift[0].start_time);
    
    // Get refunds total
    const [refundData] = await db.execute(`
      SELECT COALESCE(SUM(refund_amount), 0) as total_refunds
      FROM refunds 
      WHERE shift_id = ? AND status = 'completed'
    `, [shiftId]);
    
    // Get voids total
    const [voidData] = await db.execute(`
      SELECT COALESCE(SUM(voided_amount), 0) as total_voids
      FROM payment_voids 
      WHERE shift_id = ? AND status = 'completed'
    `, [shiftId]);
    
    // Charge sales stay in AR; cash collected when utang is marked paid goes into the drawer.
    // Digital→cash conversions (pasahod) also increase physical cash in drawer.
    const conversionCash = await sumShiftCashConversions(db, shiftId);
    const expectedCash =
      Number(shift[0].opening_cash) +
      Number(tenders.cash) +
      Number(collections.cash) +
      Number(conversionCash) -
      Number(refundData[0].total_refunds);
    let conversions = [];
    try {
      const [convRows] = await db.execute("SELECT from_method, to_method, amount, notes, converted_by, converted_at FROM payment_conversions WHERE shift_id = ? ORDER BY converted_at DESC", [shiftId]);
      conversions = (convRows || []).map((c) => ({ fromMethod: c.from_method, toMethod: c.to_method, amount: Number(c.amount), notes: c.notes, convertedBy: c.converted_by, convertedAt: c.converted_at }));
    } catch (_) {}
    res.json({
      shift: shift[0],
      sales: {
        cash: tenders.cash,
        card: tenders.card,
        gcash: tenders.gcash,
        bank: tenders.bank,
        charge: tenders.charge,
        total: tenders.total,
        tenderTotal: tenders.tenderTotal,
        transactionCount: tenders.transactionCount,
      },
      chargeCollections: collections,
      conversionCash,
      refunds: Number(refundData[0].total_refunds),
      voids: Number(voidData[0].total_voids),
      conversions,
      expectedCash,
    });
  } catch (err) {
    console.error("Shift summary error:", err);
    res.status(500).json({ error: "Failed to get shift summary" });
  }
});

// Close shift with cash count
app.post("/api/shifts/:id/close", requireAnyPermission("close_shift"), async (req, res) => {
  try {
    const db = await getPool();
    const shiftId = req.params.id;
    const branchId = getBranchId(req);
    const actingUserId = req.authUser?.id;
    const { actualCash, cashCount, varianceReason, notes } = req.body || {};
    
    // Get shift and calculate expected
    const [shift] = await db.execute(`SELECT * FROM shifts WHERE id = ? AND branch_id = ?`, [shiftId, branchId]);
    if (!shift[0]) return res.status(404).json({ error: "Shift not found" });
    if (shift[0].status !== 'open') return res.status(400).json({ error: "Shift already closed" });
    if (actingUserId && String(shift[0].user_id) !== String(actingUserId)) {
      return res.status(403).json({ error: "You can only close your own shift" });
    }
    
    // Calculate totals (branch-scoped; splits allocated by tender; charge tracked separately)
    const tenders = await getShiftTenderSales(db, shift[0].branch_id, shift[0].start_time);
    const collections = await getShiftChargeCollections(db, shift[0].branch_id, shift[0].start_time);
    const conversionCash = await sumShiftCashConversions(db, shiftId);
    
    const [refundData] = await db.execute(`
      SELECT COALESCE(SUM(refund_amount), 0) as total FROM refunds WHERE shift_id = ? AND status = 'completed'
    `, [shiftId]);
    
    const [voidData] = await db.execute(`
      SELECT COALESCE(SUM(voided_amount), 0) as total FROM payment_voids WHERE shift_id = ? AND status = 'completed'
    `, [shiftId]);
    
    const expectedCash =
      Number(shift[0].opening_cash) +
      Number(tenders.cash) +
      Number(collections.cash) +
      Number(conversionCash) -
      Number(refundData[0].total);
    const variance = actualCash - expectedCash;
    
    // Update shift
    await db.execute(`
      UPDATE shifts SET 
        end_time = NOW(),
        status = 'closed',
        total_cash_sales = ?,
        total_card_sales = ?,
        total_gcash_sales = ?,
        total_bank_sales = ?,
        total_refunds = ?,
        total_voids = ?,
        expected_cash = ?,
        actual_cash = ?,
        cash_variance = ?,
        variance_reason = ?,
        notes = ?
      WHERE id = ?
    `, [
      tenders.cash, tenders.card, tenders.gcash, tenders.bank,
      refundData[0].total, voidData[0].total,
      expectedCash, actualCash, variance, varianceReason || null, notes || null, shiftId
    ]);
    
    // Save cash count denominations if provided
    if (cashCount && Array.isArray(cashCount)) {
      for (const item of cashCount) {
        await db.execute(
          `INSERT INTO cash_counts (shift_id, denomination, quantity, subtotal) VALUES (?, ?, ?, ?)`,
          [shiftId, item.denomination, item.quantity, item.subtotal]
        );
      }
    }
    
    const [updated] = await db.execute(`SELECT * FROM shifts WHERE id = ?`, [shiftId]);
    res.json(updated[0]);
  } catch (err) {
    console.error("Close shift error:", err);
    res.status(500).json({ error: "Failed to close shift" });
  }
});

// Approve shift with variance (supervisor approval)
app.post("/api/shifts/:id/approve", requireAnyPermission("approve_cash_discrepancy"), async (req, res) => {
  try {
    const db = await getPool();
    const shiftId = req.params.id;
    const branchId = getBranchId(req);
    const approvedBy = req.authUser?.id;
    if (!approvedBy) return res.status(401).json({ error: "Not authenticated" });

    const [existing] = await db.execute(`SELECT id FROM shifts WHERE id = ? AND branch_id = ?`, [shiftId, branchId]);
    if (!existing.length) return res.status(404).json({ error: "Shift not found" });
    
    await db.execute(`
      UPDATE shifts SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ? AND branch_id = ?
    `, [approvedBy, shiftId, branchId]);
    
    const [updated] = await db.execute(`SELECT * FROM shifts WHERE id = ?`, [shiftId]);
    res.json(updated[0]);
  } catch (err) {
    console.error("Approve shift error:", err);
    res.status(500).json({ error: "Failed to approve shift" });
  }
});

// List shifts (with filters; scoped by branch)
app.get("/api/shifts", requireAnyPermission("close_shift", "view_shift_summary"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const { userId, status, dateFrom, dateTo, limit } = req.query;
    
    let sql = `SELECT s.*, u.name as user_name FROM shifts s LEFT JOIN users u ON s.user_id = u.id WHERE s.branch_id = ?`;
    const params = [branchId];
    
    if (userId) { sql += ` AND s.user_id = ?`; params.push(userId); }
    if (status) { sql += ` AND s.status = ?`; params.push(status); }
    if (dateFrom) { sql += ` AND s.shift_date >= ?`; params.push(dateFrom); }
    if (dateTo) { sql += ` AND s.shift_date <= ?`; params.push(dateTo); }
    
    sql += ` ORDER BY s.start_time DESC`;
    if (limit) { sql += ` LIMIT ?`; params.push(Number(limit)); }
    
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("List shifts error:", err);
    res.status(500).json({ error: "Failed to list shifts" });
  }
});

// ============================================================================
// CHARGE / UTANG (credit payment - track who owes and paid status)
// ============================================================================

app.get("/api/charges", requireAnyPermission("manage_settings", "accept_payments", "view_payments"), async (req, res) => {
  const branchId = getBranchId(req);
  const { customerName, status, from, to, limit } = req.query;
  try {
    const db = await getPool();
    let sql = "SELECT * FROM charge_transactions WHERE branch_id = ?";
    const params = [branchId];
    if (customerName && String(customerName).trim()) {
      sql += " AND customer_name LIKE ?";
      params.push("%" + String(customerName).trim() + "%");
    }
    if (status && ["pending", "paid", "cancelled"].includes(String(status))) {
      sql += " AND status = ?";
      params.push(status);
    } else if (!status) {
      // Default list hides cancelled AR created by payment voids
      sql += " AND status <> 'cancelled'";
    }
    if (from) { sql += " AND charged_at >= ?"; params.push(from); }
    if (to) { sql += " AND charged_at <= ?"; params.push(to + " 23:59:59"); }
    sql += " ORDER BY charged_at DESC LIMIT ?";
    params.push(Math.min(parseInt(String(limit), 10) || 200, 500));
    const [rows] = await db.execute(sql, params);
    res.json(rows.map((r) => ({
      id: r.id,
      orderIds: r.order_ids,
      customerName: r.customer_name,
      amount: Number(r.amount),
      status: r.status,
      collectionMethod: r.collection_method || null,
      shiftId: r.shift_id != null ? Number(r.shift_id) : null,
      chargedAt: r.charged_at?.toISOString?.() || r.charged_at,
      paidAt: r.paid_at?.toISOString?.() || r.paid_at,
      chargedBy: r.charged_by,
      paidBy: r.paid_by,
      notes: r.notes,
    })));
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.json([]);
    console.error("List charges error:", err);
    res.status(500).json({ error: "Failed to list charges" });
  }
});

app.patch("/api/charges/:id/mark-paid", requireAnyPermission("manage_settings", "accept_payments"), async (req, res) => {
  const id = req.params.id;
  const branchId = getBranchId(req);
  const { paidBy, paymentMethod, shiftId } = req.body || {};
  const { userName, employeeId } = getActingUser(req);
  try {
    const db = await getPool();
    const [rows] = await db.execute("SELECT id, status FROM charge_transactions WHERE id = ? AND branch_id = ?", [id, branchId]);
    if (!rows.length) return res.status(404).json({ error: "Charge not found" });
    if (rows[0].status === "paid") return res.status(400).json({ error: "Charge is already paid" });

    // Collection method for drawer (not the original charge sale). Default cash.
    let collectionMethod = "cash";
    if (paymentMethod != null && String(paymentMethod).trim() !== "") {
      const m = normalizePaymentMethod(paymentMethod);
      if (m === "charge") return res.status(400).json({ error: "Collection method cannot be charge" });
      collectionMethod = m;
    }

    let resolvedShiftId = shiftId != null && Number.isFinite(Number(shiftId)) ? Number(shiftId) : null;
    if (!resolvedShiftId) {
      try {
        const [openShift] = await db.execute(
          `SELECT id FROM shifts WHERE branch_id = ? AND status = 'open' ORDER BY start_time DESC LIMIT 1`,
          [branchId]
        );
        if (openShift[0]) resolvedShiftId = Number(openShift[0].id);
      } catch (_) {}
    }

    try {
      await db.execute(
        `UPDATE charge_transactions
         SET status = 'paid', paid_at = NOW(), paid_by = ?, collection_method = ?, shift_id = ?
         WHERE id = ? AND branch_id = ?`,
        [paidBy || userName || employeeId || null, collectionMethod, resolvedShiftId, id, branchId]
      );
    } catch (e) {
      if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
      await db.execute(
        "UPDATE charge_transactions SET status = 'paid', paid_at = NOW(), paid_by = ? WHERE id = ? AND branch_id = ?",
        [paidBy || userName || employeeId || null, id, branchId]
      );
    }
    logAudit(req, "charge_mark_paid", "charge", id, {
      paidBy: paidBy || userName || employeeId,
      collectionMethod,
      shiftId: resolvedShiftId,
    });
    res.json({ ok: true, collectionMethod, shiftId: resolvedShiftId });
  } catch (err) {
    console.error("Mark charge paid error:", err);
    res.status(500).json({ error: "Failed to mark as paid" });
  }
});

// ============================================================================
// PAYMENT CONVERSIONS (digital -> cash, e.g. pasahod)
// ============================================================================

app.post("/api/conversions", requireAnyPermission("close_shift", "view_shift_summary", "manage_pos"), async (req, res) => {
  const branchId = getBranchId(req);
  const { fromMethod, toMethod, amount, notes, shiftId } = req.body || {};
  const { userId, employeeId, userName, userRole } = getActingUser(req);
  if (!fromMethod || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "fromMethod and amount are required" });
  }
  const validFrom = ["gcash", "bank", "debit", "credit"];
  if (!validFrom.includes(String(fromMethod).toLowerCase())) {
    return res.status(400).json({ error: "Invalid fromMethod. Use: gcash, maya, bank, bpi, debit, credit, online" });
  }
  try {
    const db = await getPool();
    const [r] = await db.execute(
      `INSERT INTO payment_conversions (branch_id, shift_id, from_method, to_method, amount, notes, converted_by) VALUES (?, ?, ?, 'cash', ?, ?, ?)`,
      [branchId, shiftId || null, String(fromMethod).toLowerCase(), Number(amount), notes || null, userName || employeeId || null]
    );
    const [rows] = await db.execute("SELECT * FROM payment_conversions WHERE id = ?", [r.insertId]);
    logAudit(req, "conversion_create", "conversion", String(r.insertId), { fromMethod, amount, toMethod: "cash", notes });
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.status(503).json({ error: "Conversions table not found. Run server/schema.sql in MySQL" });
    console.error("Create conversion error:", err);
    res.status(500).json({ error: "Failed to record conversion" });
  }
});

app.get("/api/conversions", requireAnyPermission("close_shift", "view_shift_summary", "manage_pos"), async (req, res) => {
  const branchId = getBranchId(req);
  const { shiftId, from, to, limit } = req.query;
  try {
    const db = await getPool();
    let sql = "SELECT * FROM payment_conversions WHERE branch_id = ?";
    const params = [branchId];
    if (shiftId) { sql += " AND shift_id = ?"; params.push(shiftId); }
    if (from) { sql += " AND converted_at >= ?"; params.push(from); }
    if (to) { sql += " AND converted_at <= ?"; params.push(to + " 23:59:59"); }
    sql += " ORDER BY converted_at DESC LIMIT ?";
    params.push(Math.min(parseInt(String(limit), 10) || 100, 500));
    const [rows] = await db.execute(sql, params);
    res.json(rows.map((r) => ({
      id: r.id,
      shiftId: r.shift_id,
      fromMethod: r.from_method,
      toMethod: r.to_method,
      amount: Number(r.amount),
      notes: r.notes,
      convertedBy: r.converted_by,
      convertedAt: r.converted_at?.toISOString?.() || r.converted_at,
    })));
  } catch (err) {
    if (err.code === "ER_NO_SUCH_TABLE") return res.json([]);
    console.error("List conversions error:", err);
    res.status(500).json({ error: "Failed to list conversions" });
  }
});

// ============================================================================
// REFUND ENDPOINTS
// ============================================================================

// Request refund
app.post("/api/refunds", requireAnyPermission("refund_payments"), async (req, res) => {
  try {
    const db = await getPool();
    const branchId = getBranchId(req);
    const { orderId, originalPaymentMethod, refundAmount, refundMethod, reason, requestedBy, shiftId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: "orderId is required" });

    const [orders] = await db.execute(`SELECT id, branch_id, status FROM orders WHERE id = ?`, [orderId]);
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    if (String(orders[0].branch_id) !== String(branchId)) {
      return res.status(403).json({ error: "Order belongs to another branch" });
    }

    const acting = getActingUser(req);
    const requesterId = requestedBy != null && Number.isFinite(Number(requestedBy))
      ? Number(requestedBy)
      : acting.userId != null
        ? Number(acting.userId)
        : null;
    if (!requesterId) return res.status(400).json({ error: "requestedBy is required" });

    const [result] = await db.execute(`
      INSERT INTO refunds (order_id, original_payment_method, refund_amount, refund_method, reason, requested_by, shift_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    `, [
      orderId,
      originalPaymentMethod || null,
      Number(refundAmount) || 0,
      refundMethod || "cash",
      String(reason || "").trim() || "Refund",
      requesterId,
      shiftId || null,
    ]);

    const [newRefund] = await db.execute(`SELECT * FROM refunds WHERE id = ?`, [result.insertId]);
    res.json(newRefund[0]);
  } catch (err) {
    console.error("Create refund error:", err);
    res.status(500).json({ error: "Failed to create refund" });
  }
});

// Approve/Complete refund
app.put("/api/refunds/:id", requireAnyPermission("refund_payments"), async (req, res) => {
  try {
    const db = await getPool();
    const branchId = getBranchId(req);
    const refundId = req.params.id;
    const { status, approvedBy } = req.body || {};
    const nextStatus = String(status || "").toLowerCase();
    if (!["pending", "approved", "completed", "rejected"].includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const [rows] = await db.execute(
      `SELECT r.*, o.branch_id AS orderBranchId
       FROM refunds r
       JOIN orders o ON o.id = r.order_id
       WHERE r.id = ?`,
      [refundId]
    );
    if (!rows.length) return res.status(404).json({ error: "Refund not found" });
    if (String(rows[0].orderBranchId) !== String(branchId)) {
      return res.status(403).json({ error: "Refund belongs to another branch" });
    }
    if (String(rows[0].status) === "completed") {
      return res.status(400).json({ error: "Refund already completed" });
    }

    const acting = getActingUser(req);
    const approverId = approvedBy != null && Number.isFinite(Number(approvedBy))
      ? Number(approvedBy)
      : acting.userId != null
        ? Number(acting.userId)
        : null;

    let sql = `UPDATE refunds SET status = ?`;
    const params = [nextStatus];
    if (nextStatus === "approved" || nextStatus === "completed" || nextStatus === "rejected") {
      sql += `, approved_by = ?`;
      params.push(approverId);
    }
    if (nextStatus === "completed") {
      sql += `, completed_at = NOW()`;
    }
    sql += ` WHERE id = ?`;
    params.push(refundId);

    await db.execute(sql, params);
    const [updated] = await db.execute(`SELECT * FROM refunds WHERE id = ?`, [refundId]);
    res.json(updated[0]);
  } catch (err) {
    console.error("Update refund error:", err);
    res.status(500).json({ error: "Failed to update refund" });
  }
});

// List refunds
app.get("/api/refunds", requireAnyPermission("refund_payments", "view_payments", "view_reports"), async (req, res) => {
  try {
    const db = await getPool();
    const branchId = getBranchId(req);
    const { orderId, status, dateFrom, dateTo } = req.query;

    let sql = `SELECT r.*, o.table_id, u.name as requested_by_name
               FROM refunds r
               INNER JOIN orders o ON r.order_id = o.id AND o.branch_id = ?
               LEFT JOIN users u ON r.requested_by = u.id
               WHERE 1=1`;
    const params = [branchId];

    if (orderId) { sql += ` AND r.order_id = ?`; params.push(orderId); }
    if (status) { sql += ` AND r.status = ?`; params.push(status); }
    if (dateFrom) { sql += ` AND DATE(r.created_at) >= ?`; params.push(dateFrom); }
    if (dateTo) { sql += ` AND DATE(r.created_at) <= ?`; params.push(dateTo); }

    sql += ` ORDER BY r.created_at DESC LIMIT 2000`;
    const [rows] = await db.execute(sql, params);
    res.json(rows);
  } catch (err) {
    console.error("List refunds error:", err);
    res.status(500).json({ error: "Failed to list refunds" });
  }
});

// ============================================================================
// PAYMENT VOID ENDPOINTS
// ============================================================================

// Request payment void
app.post("/api/payment-voids", requireAnyPermission("void_payments"), async (req, res) => {
  try {
    const db = await getPool();
    const branchId = getBranchId(req);
    const { orderId, paymentMethod, voidedAmount, reason, requestedBy, shiftId } = req.body || {};

    if (!orderId) return res.status(400).json({ error: "orderId is required" });
    let reasonText;
    try {
      reasonText = normalizeVoidReason(reason);
    } catch (reasonErr) {
      return res.status(400).json({ error: reasonErr.message });
    }

    const [orders] = await db.execute(
      `SELECT id, branch_id, status, payment_method, total FROM orders WHERE id = ?`,
      [orderId]
    );
    if (!orders.length) return res.status(404).json({ error: "Order not found" });
    if (String(orders[0].branch_id) !== String(branchId)) {
      return res.status(403).json({ error: "Order belongs to another branch" });
    }
    if (String(orders[0].status) !== "paid") {
      return res.status(400).json({ error: "Only paid orders can have a payment void" });
    }

    const acting = getActingUser(req);
    const requesterId = requestedBy != null && Number.isFinite(Number(requestedBy))
      ? Number(requestedBy)
      : acting.userId != null
        ? Number(acting.userId)
        : null;
    if (!requesterId) return res.status(400).json({ error: "requestedBy is required" });

    const method = paymentMethod || orders[0].payment_method || "cash";
    const amount = voidedAmount != null ? Number(voidedAmount) : Number(orders[0].total || 0);

    const [result] = await db.execute(`
      INSERT INTO payment_voids (order_id, payment_method, voided_amount, reason, requested_by, shift_id, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `, [orderId, method, amount, reasonText, requesterId, shiftId || null]);

    const [newVoid] = await db.execute(`SELECT * FROM payment_voids WHERE id = ?`, [result.insertId]);
    res.json(newVoid[0]);
  } catch (err) {
    console.error("Create void error:", err);
    res.status(500).json({ error: "Failed to create payment void" });
  }
});

// Approve/Complete payment void — restores stock, clears payment, audits void_log
app.put("/api/payment-voids/:id", requireAnyPermission("void_payments"), async (req, res) => {
  let conn;
  try {
    const db = await getPool();
    const branchId = getBranchId(req);
    const voidId = req.params.id;
    const { status, approvedBy } = req.body || {};
    const nextStatus = String(status || "").toLowerCase();
    if (!["pending", "approved", "completed", "rejected"].includes(nextStatus)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    conn = await db.getConnection();
    await conn.beginTransaction();

    const [voidRows] = await conn.execute(
      `SELECT * FROM payment_voids WHERE id = ? FOR UPDATE`,
      [voidId]
    );
    if (!voidRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Payment void not found" });
    }
    const pv = voidRows[0];
    const [orderRows] = await conn.execute(
      `SELECT id, branch_id AS orderBranchId, status AS orderStatus, table_id AS tableId,
              payment_method AS orderPaymentMethod, total AS orderTotal
       FROM orders WHERE id = ? FOR UPDATE`,
      [pv.order_id]
    );
    if (!orderRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: "Order not found" });
    }
    Object.assign(pv, orderRows[0]);
    if (String(pv.orderBranchId) !== String(branchId)) {
      await conn.rollback();
      return res.status(403).json({ error: "Payment void belongs to another branch" });
    }
    if (String(pv.status) === "completed") {
      await conn.rollback();
      return res.status(400).json({ error: "Payment void already completed" });
    }

    const acting = getActingUser(req);
    const approverId = approvedBy != null && Number.isFinite(Number(approvedBy))
      ? Number(approvedBy)
      : acting.userId != null
        ? Number(acting.userId)
        : null;

    let manager = { id: approverId, name: acting.userName || acting.employeeId || "Manager" };
    if (approverId) {
      const [uRows] = await conn.execute(
        `SELECT id, name, employee_id FROM users WHERE id = ? AND branch_id = ?`,
        [approverId, branchId]
      );
      if (uRows.length) {
        manager = { id: uRows[0].id, name: uRows[0].name || manager.name };
      }
    }

    if (nextStatus === "completed") {
      if (String(pv.orderStatus) !== "paid") {
        await conn.rollback();
        return res.status(400).json({ error: "Order is no longer paid; cannot complete payment void" });
      }

      const orderId = pv.order_id;
      const reasonText = pv.reason || "Payment void";

      try {
        await logPaymentVoidForOrder(conn, {
          branchId,
          orderId,
          reason: reasonText,
          manager,
          employeeId: acting.employeeId || null,
        });
      } catch (logErr) {
        if (logErr.code !== "ER_NO_SUCH_TABLE") throw logErr;
      }

      try {
        await restoreStockForPaidOrderIds(conn, [orderId]);
      } catch (stockErr) {
        if (stockErr.code !== "ER_NO_SUCH_TABLE") throw stockErr;
      }

      await conn.execute(
        `UPDATE orders SET status = 'pending', payment_method = NULL WHERE id = ? AND status = 'paid'`,
        [orderId]
      );

      try {
        await conn.execute(`DELETE FROM split_payments WHERE order_id = ?`, [orderId]);
      } catch (e) {
        if (e.code !== "ER_NO_SUCH_TABLE") throw e;
      }

      try {
        await reconcileChargesAfterPaymentVoid(conn, branchId, orderId, pv.orderTotal || pv.voided_amount);
      } catch (chargeErr) {
        if (chargeErr.code !== "ER_NO_SUCH_TABLE") throw chargeErr;
      }

      // Recalculate pending totals (drop card surcharge baked into paid total)
      try {
        const settings = await loadPosFinancialSettings(conn);
        await updateOrderTotalsFromItems(conn, orderId, settings);
      } catch (_) {
        // non-fatal — order is already pending
      }

      if (pv.tableId) {
        try {
          await conn.execute(
            `UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?`,
            [orderId, branchId, pv.tableId]
          );
          await ensureSessionForOrder(conn, {
            branchId,
            tableId: pv.tableId,
            orderId,
            waiterId: acting.employeeId || null,
          });
          await reconcileTableVisitIds(conn, branchId, pv.tableId);
        } catch (e) {
          if (e.code !== "ER_NO_SUCH_TABLE" && e.code !== "ER_BAD_FIELD_ERROR") throw e;
        }
      }

      await conn.execute(
        `UPDATE payment_voids SET status = 'completed', approved_by = COALESCE(?, approved_by), completed_at = NOW() WHERE id = ?`,
        [approverId, voidId]
      );
      await logAudit(req, "payment_void_complete", "payment_void", voidId, {
        orderId: String(orderId),
        reason: reasonText,
        voidedAmount: Number(pv.voided_amount),
      });
    } else {
      let sql = `UPDATE payment_voids SET status = ?`;
      const params = [nextStatus];
      if (nextStatus === "approved" || nextStatus === "rejected") {
        sql += `, approved_by = ?`;
        params.push(approverId);
      }
      sql += ` WHERE id = ?`;
      params.push(voidId);
      await conn.execute(sql, params);
    }

    await conn.commit();
    const [updated] = await db.execute(`SELECT * FROM payment_voids WHERE id = ?`, [voidId]);
    res.json(updated[0]);
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    console.error("Update void error:", err);
    res.status(500).json({ error: err.message || "Failed to update payment void" });
  } finally {
    if (conn) conn.release();
  }
});

// ============================================================================
// SPLIT BILL ENDPOINTS
// ============================================================================

// Create split payment plan
app.post("/api/split-payments", requireAnyPermission("split_bill", "accept_payments"), async (req, res) => {
  try {
    const db = await getPool();
    const { orderId, splits } = req.body;  // splits = [{amount, paymentMethod}, ...]
    
    if (!orderId || !splits || splits.length < 2) {
      return res.status(400).json({ error: "Need at least 2 splits" });
    }
    
    // Delete any existing splits for this order
    await db.execute(`DELETE FROM split_payments WHERE order_id = ?`, [orderId]);
    
    // Create new splits
    for (let i = 0; i < splits.length; i++) {
      await db.execute(`
        INSERT INTO split_payments (order_id, split_number, amount, payment_method, status)
        VALUES (?, ?, ?, ?, 'pending')
      `, [orderId, i + 1, splits[i].amount, splits[i].paymentMethod]);
    }
    
    const [newSplits] = await db.execute(`SELECT * FROM split_payments WHERE order_id = ? ORDER BY split_number`, [orderId]);
    res.json(newSplits);
  } catch (err) {
    console.error("Create split payments error:", err);
    res.status(500).json({ error: "Failed to create split payments" });
  }
});

// Pay a split
app.put("/api/split-payments/:id/pay", requireAnyPermission("split_bill", "accept_payments"), async (req, res) => {
  try {
    const db = await getPool();
    const splitId = req.params.id;
    const { processedBy } = req.body;
    
    await db.execute(`
      UPDATE split_payments SET status = 'paid', paid_at = NOW(), processed_by = ? WHERE id = ?
    `, [processedBy, splitId]);
    
    // Check if all splits are paid
    const [split] = await db.execute(`SELECT order_id FROM split_payments WHERE id = ?`, [splitId]);
    if (split[0]) {
      const [pending] = await db.execute(
        `SELECT COUNT(*) as cnt FROM split_payments WHERE order_id = ? AND status = 'pending'`,
        [split[0].order_id]
      );
      if (pending[0].cnt === 0) {
        // All splits paid, update order status
        await db.execute(`UPDATE orders SET status = 'paid' WHERE id = ?`, [split[0].order_id]);
        const [orderInfo] = await db.execute(
          "SELECT table_id, branch_id FROM orders WHERE id = ?",
          [split[0].order_id]
        );
        if (orderInfo[0]?.table_id) {
          const tableId = orderInfo[0].table_id;
          const branchId = String(orderInfo[0].branch_id || "1");
          const tablePending = await fetchLivePendingOrderIds(db, branchId, tableId);
          if (tablePending.length === 0) {
            await db.execute(
              "UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?",
              [branchId, tableId]
            );
          }
        }
      }
    }
    
    const [updated] = await db.execute(`SELECT * FROM split_payments WHERE id = ?`, [splitId]);
    res.json(updated[0]);
  } catch (err) {
    console.error("Pay split error:", err);
    res.status(500).json({ error: "Failed to pay split" });
  }
});

// Get splits for order
app.get("/api/split-payments/:orderId", requireAnyPermission("split_bill", "accept_payments", "view_orders"), async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(
      `SELECT * FROM split_payments WHERE order_id = ? ORDER BY split_number`,
      [req.params.orderId]
    );
    res.json(rows);
  } catch (err) {
    console.error("Get splits error:", err);
    res.status(500).json({ error: "Failed to get splits" });
  }
});

// ============================================================================
// TABLE TRANSFER / MERGE ENDPOINTS
// ============================================================================

// Transfer order(s) to another table.
// - Target empty: move (transferAll moves ALL pending from fromTable).
// - Target occupied: swap all pending orders + sessions (bills stay separate). Use merge to combine bills.
app.post("/api/tables/transfer", requireAnyPermission("transfer_table_orders"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const { orderId, fromTable, toTable, reason, transferAll } = req.body;
    const transferredBy = req.authUser.id;

    if (!fromTable || !toTable) {
      return res.status(400).json({ error: "fromTable and toTable are required" });
    }
    if (fromTable === toTable) {
      return res.status(400).json({ error: "Source and target tables must be different" });
    }

    const targetPending = await fetchLivePendingOrderIds(db, branchId, toTable);

    // Occupied target → one-step swap (no temp table / punch-merge-void workaround)
    if (targetPending.length > 0) {
      const sourcePending = await fetchLivePendingOrderIds(db, branchId, fromTable);
      if (sourcePending.length === 0) {
        return res.status(400).json({ error: "Source table has no active order to swap" });
      }

      const sourceIds = sourcePending;
      const targetIds = targetPending;
      const swapReason = reason?.trim() ? `swap: ${reason.trim()}` : "swap";
      const idPlaceholders = [...sourceIds, ...targetIds].map(() => "?").join(",");

      // Atomic swap — CASE uses pre-update values, so no temp table_id (VARCHAR(16) safe)
      await db.execute(
        `UPDATE orders
         SET table_id = CASE table_id
           WHEN ? THEN ?
           WHEN ? THEN ?
           ELSE table_id
         END
         WHERE branch_id = ? AND status = 'pending' AND id IN (${idPlaceholders})`,
        [fromTable, toTable, toTable, fromTable, branchId, ...sourceIds, ...targetIds]
      );

      for (const oid of sourceIds) {
        await db.execute(`
          INSERT INTO table_transfers (order_id, from_table, to_table, transfer_type, transferred_by, reason)
          VALUES (?, ?, ?, 'move', ?, ?)
        `, [oid, fromTable, toTable, transferredBy || null, swapReason]);
      }
      for (const oid of targetIds) {
        await db.execute(`
          INSERT INTO table_transfers (order_id, from_table, to_table, transfer_type, transferred_by, reason)
          VALUES (?, ?, ?, 'move', ?, ?)
        `, [oid, toTable, fromTable, transferredBy || null, swapReason]);
      }

      try {
        await swapOpenSessions(db, branchId, fromTable, toTable);
      } catch (sessErr) {
        if (sessErr.code !== "ER_NO_SUCH_TABLE") throw sessErr;
      }

      await db.execute(
        `UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?`,
        [String(targetIds[0]), branchId, fromTable]
      );
      await db.execute(
        `UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?`,
        [String(sourceIds[0]), branchId, toTable]
      );

      try {
        await reconcileTableVisitIds(db, branchId, fromTable);
        await reconcileTableVisitIds(db, branchId, toTable);
      } catch (recErr) {
        if (recErr.code !== "ER_NO_SUCH_TABLE" && recErr.code !== "ER_BAD_FIELD_ERROR") throw recErr;
      }

      return res.json({
        ok: true,
        action: "swap",
        message: `Swapped tables ${fromTable} and ${toTable}`,
      });
    }

    let orderIdsToMove = [];
    if (transferAll && fromTable && toTable) {
      orderIdsToMove = await fetchLivePendingOrderIds(db, branchId, fromTable);
    } else if (orderId && fromTable && toTable) {
      orderIdsToMove = [orderId];
    }

    if (orderIdsToMove.length === 0) {
      return res.status(400).json({ error: "No orders to transfer" });
    }

    for (const oid of orderIdsToMove) {
      await db.execute(`UPDATE orders SET table_id = ? WHERE id = ?`, [toTable, oid]);
      await db.execute(`
        INSERT INTO table_transfers (order_id, from_table, to_table, transfer_type, transferred_by, reason)
        VALUES (?, ?, ?, 'move', ?, ?)
      `, [oid, fromTable, toTable, transferredBy || null, reason || null]);
    }

    // Vacate source only when no pending orders remain there
    const remainingSource = await fetchLivePendingOrderIds(db, branchId, fromTable);
    const fullTransfer = remainingSource.length === 0;
    const firstOrderId = orderIdsToMove[0];

    try {
      if (fullTransfer) {
        // Move open session to target with the orders, then vacate source table
        await transferOpenSession(db, branchId, fromTable, toTable);
        await db.execute(
          `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
          [branchId, fromTable]
        );
      } else {
        await db.execute(
          `UPDATE pos_tables SET current_order_id = ? WHERE branch_id = ? AND id = ?`,
          [remainingSource[0], branchId, fromTable]
        );
        await reconcileTableVisitIds(db, branchId, fromTable);
        // Partial transfer: attach moved orders to target session (or open one)
        const targetSession = await getOpenSession(db, branchId, toTable);
        let targetSessionId = targetSession ? Number(targetSession.id) : null;
        if (!targetSessionId) {
          targetSessionId = await ensureSessionForOrder(db, {
            branchId,
            tableId: toTable,
            orderId: firstOrderId,
            waiterId: null,
            isFreshSeating: true,
          });
        }
        const visitAnchor = firstOrderId;
        for (const oid of orderIdsToMove) {
          await attachOrderToSession(db, oid, targetSessionId, visitAnchor);
        }
      }
      await reconcileTableVisitIds(db, branchId, toTable);
    } catch (sessErr) {
      if (sessErr.code !== "ER_NO_SUCH_TABLE") throw sessErr;
      if (fullTransfer) {
        await db.execute(
          `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
          [branchId, fromTable]
        );
      }
      await reconcileTableVisitIds(db, branchId, toTable);
    }

    await db.execute(
      `UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?`,
      [firstOrderId, branchId, toTable]
    );

    const msg = orderIdsToMove.length > 1
      ? `${orderIdsToMove.length} orders transferred from ${fromTable} to ${toTable}`
      : `Order transferred from ${fromTable} to ${toTable}`;
    res.json({ ok: true, action: "move", message: msg });
  } catch (err) {
    console.error("Transfer table error:", err);
    res.status(500).json({ error: "Failed to transfer order" });
  }
});

// Merge orders from two tables (same branch). Moves items from source order into target, then moves ALL remaining orders from source table to target table.
app.post("/api/tables/merge", requireAnyPermission("transfer_table_orders"), async (req, res) => {
  const branchId = getBranchId(req);
  try {
    const db = await getPool();
    const { sourceOrderId, targetOrderId, reason } = req.body;
    const transferredBy = req.authUser.id;
    
    const [sourceOrder] = await db.execute(`SELECT branch_id, table_id FROM orders WHERE id = ?`, [sourceOrderId]);
    const [targetOrder] = await db.execute(`SELECT table_id FROM orders WHERE id = ?`, [targetOrderId]);
    if (!sourceOrder[0] || !targetOrder[0]) {
      return res.status(404).json({ error: "Source or target order not found" });
    }
    if (sourceOrder[0].branch_id != null && String(sourceOrder[0].branch_id) !== branchId) {
      return res.status(403).json({ error: "Orders must belong to the same branch" });
    }
    const sourceTableId = sourceOrder[0].table_id;
    const targetTableId = targetOrder[0].table_id;
    
    // Move items from source order into target order
    const [sourceItems] = await db.execute(`SELECT * FROM order_items WHERE order_id = ?`, [sourceOrderId]);
    for (const item of sourceItems) {
      await db.execute(`UPDATE order_items SET order_id = ? WHERE id = ?`, [targetOrderId, item.id]);
    }
    
    const [totals] = await db.execute(
      `SELECT COALESCE(SUM(subtotal), 0) as subtotal FROM order_items WHERE order_id = ?`,
      [targetOrderId]
    );
    await db.execute(`UPDATE orders SET subtotal = ?, total = ? WHERE id = ?`, 
      [totals[0].subtotal, totals[0].subtotal, targetOrderId]);
    
    await db.execute(`DELETE FROM orders WHERE id = ?`, [sourceOrderId]);
    
    // Move ALL remaining pending orders from source table to target table (so source table is fully cleared)
    const remaining = await fetchLivePendingOrderIds(db, branchId, sourceTableId);
    for (const oid of remaining) {
      await db.execute(`UPDATE orders SET table_id = ? WHERE id = ?`, [targetTableId, oid]);
      await db.execute(`
        INSERT INTO table_transfers (order_id, from_table, to_table, transfer_type, transferred_by, reason)
        VALUES (?, ?, ?, 'move', ?, ?)
      `, [oid, sourceTableId, targetTableId, transferredBy || null, reason || null]);
    }
    
    // Only now set source table to available (no more orders there)
    await db.execute(
      `UPDATE pos_tables SET status = 'available', current_order_id = NULL WHERE branch_id = ? AND id = ?`,
      [branchId, sourceTableId]
    );
    // Ensure target table is occupied (use first order id we have)
    const targetOrders = await fetchLivePendingOrderIds(db, branchId, targetTableId);
    if (targetOrders.length > 0) {
      await db.execute(
        `UPDATE pos_tables SET status = 'occupied', current_order_id = ? WHERE branch_id = ? AND id = ?`,
        [targetOrders[0], branchId, targetTableId]
      );
    }
    
    await db.execute(`
      INSERT INTO table_transfers (order_id, from_table, to_table, transfer_type, transferred_by, reason)
      VALUES (?, ?, ?, 'merge', ?, ?)
    `, [targetOrderId, sourceTableId, targetTableId, transferredBy || null, reason || null]);

    try {
      const sessionId = await mergeSessions(db, branchId, sourceTableId, targetTableId);
      if (sessionId) {
        const targetSess = await getOpenSession(db, branchId, targetTableId);
        const liveMerge = appendLivePendingSessionFilter(targetSess || { id: sessionId, opened_at: new Date() });
        await db.execute(
          `UPDATE orders SET session_id = ?
           WHERE branch_id = ? AND table_id = ? AND status = 'pending'
           ${liveMerge.sql}`,
          [sessionId, branchId, targetTableId, ...liveMerge.params]
        );
      }
      await reconcileTableVisitIds(db, branchId, targetTableId);
    } catch (sessErr) {
      if (sessErr.code !== "ER_NO_SUCH_TABLE") throw sessErr;
      await reconcileTableVisitIds(db, branchId, targetTableId);
    }

    res.json({ ok: true, message: "Orders merged successfully" });
  } catch (err) {
    console.error("Merge tables error:", err);
    res.status(500).json({ error: "Failed to merge orders" });
  }
});

// Get transfer history for order
app.get("/api/tables/transfers/:orderId", requireAnyPermission("transfer_table_orders", "view_orders", "manage_pos"), async (req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute(`
      SELECT t.*, u.name as transferred_by_name 
      FROM table_transfers t 
      LEFT JOIN users u ON t.transferred_by = u.id 
      WHERE t.order_id = ? 
      ORDER BY t.created_at DESC
    `, [req.params.orderId]);
    res.json(rows);
  } catch (err) {
    console.error("Get transfers error:", err);
    res.status(500).json({ error: "Failed to get transfer history" });
  }
});

// ---------- Settings ----------

app.get("/api/settings", requireAnyPermission("manage_settings", "manage_pos", "view_dashboard"), async (_req, res) => {
  try {
    const db = await getPool();
    const [rows] = await db.execute("SELECT setting_key, setting_value FROM settings");
    const result = {};
    for (const row of rows) result[row.setting_key] = row.setting_value;
    res.json(result);
  } catch (err) {
    console.error("Get settings error:", err);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

app.put("/api/settings", requireAnyPermission("manage_settings"), async (req, res) => {
  const data = req.body;
  if (!data || typeof data !== "object") return res.status(400).json({ error: "Invalid settings payload" });
  try {
    const db = await getPool();
    const entries = Object.entries(data);
    for (const [key, value] of entries) {
      await db.execute(
        "INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [key, String(value ?? "")]
      );
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("Save settings error:", err);
    res.status(500).json({ error: "Failed to save settings" });
  }
});

// Auto-migrate: add is_voided and related columns to order_items if they don't exist.
// This fixes LD count queries silently returning wrong data on older DBs.
(async () => {
  try {
    const db = await getPool();
    const migrations = [
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_voided TINYINT(1) NOT NULL DEFAULT 0",
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS voided_by INT UNSIGNED DEFAULT NULL",
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP NULL DEFAULT NULL",
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS voided_by_name VARCHAR(128) DEFAULT NULL",
      "ALTER TABLE order_items ADD COLUMN IF NOT EXISTS special_request VARCHAR(512) DEFAULT NULL",
      `CREATE TABLE IF NOT EXISTS order_number_sequences (
        branch_id INT UNSIGNED NOT NULL,
        seq_date DATE NOT NULL,
        last_seq INT UNSIGNED NOT NULL DEFAULT 0,
        PRIMARY KEY (branch_id, seq_date)
      )`,
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number VARCHAR(32) DEFAULT NULL",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP NULL DEFAULT NULL",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_by INT UNSIGNED DEFAULT NULL",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS voided_by_name VARCHAR(128) DEFAULT NULL",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge DECIMAL(12,2) NOT NULL DEFAULT 0",
      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS card_surcharge DECIMAL(12,2) NOT NULL DEFAULT 0",
      // Older DBs only had ENUM('pending','paid') — voiding last item / full order writes 'voided'
      // and MySQL returns "Data truncated for column 'status' at row 1" without this widen.
      "ALTER TABLE orders MODIFY COLUMN status ENUM('pending','paid','voided','cancelled') NOT NULL DEFAULT 'pending'",
      // Long KTV sessions can accumulate many pending order IDs; VARCHAR(255) overflow broke Charge/Utang bill-out.
      "ALTER TABLE charge_transactions MODIFY COLUMN order_ids TEXT",
      "ALTER TABLE charge_transactions ADD COLUMN IF NOT EXISTS collection_method VARCHAR(32) DEFAULT NULL",
      "ALTER TABLE charge_transactions ADD COLUMN IF NOT EXISTS shift_id INT UNSIGNED DEFAULT NULL",
      "ALTER TABLE charge_transactions MODIFY COLUMN status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending'",
      `CREATE TABLE IF NOT EXISTS receipt_snapshots (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        branch_id INT UNSIGNED NOT NULL DEFAULT 1,
        snapshot_type ENUM('official_receipt','running_bill') NOT NULL,
        order_id INT UNSIGNED DEFAULT NULL,
        table_id VARCHAR(16) DEFAULT NULL,
        table_visit_id INT UNSIGNED DEFAULT NULL,
        session_id BIGINT UNSIGNED DEFAULT NULL,
        payment_method VARCHAR(32) DEFAULT NULL,
        receipt_json JSON NOT NULL,
        created_by INT UNSIGNED DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_receipt_snapshots_order (branch_id, order_id, snapshot_type, created_at),
        KEY idx_receipt_snapshots_table (branch_id, table_id, snapshot_type, created_at),
        KEY idx_receipt_snapshots_visit (branch_id, table_visit_id, snapshot_type, created_at),
        KEY idx_receipt_snapshots_session (branch_id, session_id),
        KEY idx_receipt_snapshots_created (created_at)
      )`,
    ];
    for (const sql of migrations) {
      await db.execute(sql).catch(() => {}); // ignore if already exists
    }
    await ensureTableSessionsSchema(db);
    const migrated = await migrateLegacySessions(db);
    console.log("[Migration] order_items columns verified.");
    if (migrated.sessionsCreated > 0 || migrated.ordersLinked > 0) {
      console.log(
        `[Migration] table_sessions backfill: ${migrated.sessionsCreated} sessions, ${migrated.ordersLinked} orders linked.`
      );
    }
    await ensureProductPricingSchema(db);
    await ensureProductStockSchema(db);
    const priceMig = await migrateProductPrices(db);
    const stockMig = await migrateProductStock(db);
    if (priceMig.priceRowsCreated > 0 || priceMig.skuLinesBackfilled > 0 || stockMig.stockRowsCreated > 0) {
      console.log(
        `[Migration] product prices/stock: ${priceMig.priceRowsCreated} price rows, ${priceMig.skuLinesBackfilled} SKU lines, ${stockMig.stockRowsCreated} stock rows.`
      );
    }
    await ensurePayoutsSchema(db);
    await ensureVoidLogSchema(db);
    const voidMig = await backfillLegacyVoids(db);
    if (voidMig.inserted > 0) {
      console.log(`[Migration] void_log backfill: ${voidMig.inserted} legacy void(s).`);
    }

    // Trigger auto-backup on startup
    createDatabaseBackup({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_DATABASE,
    }).then((res) => {
      console.log(`[Backup] Startup auto-backup successful: ${res.filename} (Method: ${res.method})`);
    }).catch((err) => {
      console.error(`[Backup] Startup auto-backup failed:`, err.message);
    });
  } catch (e) {
    console.warn("[Migration] Could not run auto-migration:", e.message);
  }
})();

// Periodically backup database (every 30 minutes)
setInterval(() => {
  console.log("[Backup] Periodic auto-backup triggered...");
  createDatabaseBackup({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_DATABASE,
  }).then((res) => {
    console.log(`[Backup] Periodic auto-backup successful: ${res.filename}`);
  }).catch((err) => {
    console.error(`[Backup] Periodic auto-backup failed:`, err.message);
  });
}, 30 * 60 * 1000);

// Graceful shutdown with backup
let isShuttingDownServer = false;
async function handleShutdown(signal) {
  if (isShuttingDownServer) return;
  isShuttingDownServer = true;
  console.log(`\n[Backup] Server received ${signal}, taking exit auto-backup...`);
  try {
    const res = await createDatabaseBackup({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_DATABASE,
    });
    console.log(`[Backup] Exit auto-backup successful: ${res.filename}`);
  } catch (err) {
    console.error(`[Backup] Exit auto-backup failed:`, err.message);
  }
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGBREAK", () => handleShutdown("SIGBREAK")); // Console close on Windows

const server = app.listen(PORT, () => {
  console.log(`API running at http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use. Either:`);
    console.error(`  1. Stop the other process: taskkill /F /IM node.exe  (or close the other terminal running the server)`);
    console.error(`  2. Or use another port: set PORT=3002 in server/.env and restart\n`);
    process.exit(1);
  }
  throw err;
});