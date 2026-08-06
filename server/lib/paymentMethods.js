export function normalizePaymentMethod(method) {
  const m = String(method || "cash").toLowerCase().trim();
  if (m === "cash" || m === "gcash" || m === "debit" || m === "credit" || m === "bank" || m === "charge") {
    return m;
  }
  return "cash";
}

export function isCardPaymentMethod(method) {
  const m = String(method || "").toLowerCase();
  return m === "debit" || m === "credit";
}

export const SALES_CASH_COND = "payment_method = 'cash'";
export const SALES_CARD_COND = "payment_method IN ('credit','debit')";
export const SALES_GCASH_COND = "payment_method = 'gcash'";
export const SALES_BANK_COND = "payment_method = 'bank'";
export const SALES_CHARGE_COND = "payment_method = 'charge'";

/**
 * Shift / Z-report tender buckets for paid orders since startTime (same branch).
 * Allocates split_payment rows by method; charge is tracked separately (not cash drawer).
 */
export async function getShiftTenderSales(db, branchId, startTime) {
  let salesData;
  try {
    [salesData] = await db.execute(
      `SELECT
          COALESCE(SUM(CASE WHEN ${SALES_CASH_COND} THEN total ELSE 0 END), 0) AS cash_sales,
          COALESCE(SUM(CASE WHEN ${SALES_CARD_COND} THEN total ELSE 0 END), 0) AS card_sales,
          COALESCE(SUM(CASE WHEN ${SALES_GCASH_COND} THEN total ELSE 0 END), 0) AS gcash_sales,
          COALESCE(SUM(CASE WHEN ${SALES_BANK_COND} THEN total ELSE 0 END), 0) AS bank_sales,
          COALESCE(SUM(CASE WHEN ${SALES_CHARGE_COND} THEN total ELSE 0 END), 0) AS charge_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'split_payment' THEN total ELSE 0 END), 0) AS split_sales,
          COUNT(*) AS transaction_count
       FROM orders
       WHERE branch_id = ? AND status = 'paid' AND voided_at IS NULL AND created_at >= ?`,
      [branchId, startTime]
    );
  } catch (e) {
    if (e.code !== "ER_BAD_FIELD_ERROR") throw e;
    [salesData] = await db.execute(
      `SELECT
          COALESCE(SUM(CASE WHEN ${SALES_CASH_COND} THEN total ELSE 0 END), 0) AS cash_sales,
          COALESCE(SUM(CASE WHEN ${SALES_CARD_COND} THEN total ELSE 0 END), 0) AS card_sales,
          COALESCE(SUM(CASE WHEN ${SALES_GCASH_COND} THEN total ELSE 0 END), 0) AS gcash_sales,
          COALESCE(SUM(CASE WHEN ${SALES_BANK_COND} THEN total ELSE 0 END), 0) AS bank_sales,
          COALESCE(SUM(CASE WHEN ${SALES_CHARGE_COND} THEN total ELSE 0 END), 0) AS charge_sales,
          COALESCE(SUM(CASE WHEN payment_method = 'split_payment' THEN total ELSE 0 END), 0) AS split_sales,
          COUNT(*) AS transaction_count
       FROM orders
       WHERE branch_id = ? AND status = 'paid' AND created_at >= ?`,
      [branchId, startTime]
    );
  }

  let splitCash = 0;
  let splitCard = 0;
  let splitGcash = 0;
  let splitBank = 0;
  let splitCharge = 0;
  try {
    const [splitRows] = await db.execute(
      `SELECT
          COALESCE(SUM(CASE WHEN sp.payment_method = 'cash' THEN sp.amount ELSE 0 END), 0) AS cash_amt,
          COALESCE(SUM(CASE WHEN sp.payment_method IN ('credit','debit') THEN sp.amount ELSE 0 END), 0) AS card_amt,
          COALESCE(SUM(CASE WHEN sp.payment_method = 'gcash' THEN sp.amount ELSE 0 END), 0) AS gcash_amt,
          COALESCE(SUM(CASE WHEN sp.payment_method = 'bank' THEN sp.amount ELSE 0 END), 0) AS bank_amt,
          COALESCE(SUM(CASE WHEN sp.payment_method = 'charge' THEN sp.amount ELSE 0 END), 0) AS charge_amt
       FROM split_payments sp
       INNER JOIN orders o ON o.id = sp.order_id
       WHERE o.branch_id = ?
         AND o.status = 'paid'
         AND o.payment_method = 'split_payment'
         AND o.created_at >= ?
         AND sp.status = 'paid'`,
      [branchId, startTime]
    );
    const s = splitRows[0] || {};
    splitCash = Number(s.cash_amt || 0);
    splitCard = Number(s.card_amt || 0);
    splitGcash = Number(s.gcash_amt || 0);
    splitBank = Number(s.bank_amt || 0);
    splitCharge = Number(s.charge_amt || 0);
  } catch (e) {
    if (e.code !== "ER_NO_SUCH_TABLE" && e.code !== "ER_BAD_FIELD_ERROR") throw e;
  }

  const row = salesData[0] || {};
  const cash = Number(row.cash_sales || 0) + splitCash;
  const card = Number(row.card_sales || 0) + splitCard;
  const gcash = Number(row.gcash_sales || 0) + splitGcash;
  const bank = Number(row.bank_sales || 0) + splitBank;
  const charge = Number(row.charge_sales || 0) + splitCharge;

  return {
    cash,
    card,
    gcash,
    bank,
    charge,
    total: cash + card + gcash + bank + charge,
    tenderTotal: cash + card + gcash + bank,
    transactionCount: Number(row.transaction_count || 0),
  };
}

/**
 * Utang collections recorded during a shift (mark-paid), separate from charge sales AR.
 * Does not reclassify original charge orders — only tracks cash/digital collected later.
 */
export async function getShiftChargeCollections(db, branchId, startTime, endTime = null) {
  const empty = { cash: 0, card: 0, gcash: 0, bank: 0, total: 0 };
  try {
    const params = [branchId, startTime];
    let endClause = "";
    if (endTime) {
      endClause = " AND paid_at < ?";
      params.push(endTime);
    }
    const [rows] = await db.execute(
      `SELECT
          COALESCE(SUM(CASE WHEN COALESCE(collection_method, 'cash') = 'cash' THEN amount ELSE 0 END), 0) AS cash_amt,
          COALESCE(SUM(CASE WHEN collection_method IN ('credit','debit') THEN amount ELSE 0 END), 0) AS card_amt,
          COALESCE(SUM(CASE WHEN collection_method = 'gcash' THEN amount ELSE 0 END), 0) AS gcash_amt,
          COALESCE(SUM(CASE WHEN collection_method = 'bank' THEN amount ELSE 0 END), 0) AS bank_amt,
          COALESCE(SUM(amount), 0) AS total_amt
       FROM charge_transactions
       WHERE branch_id = ?
         AND status = 'paid'
         AND paid_at IS NOT NULL
         AND paid_at >= ?
         ${endClause}`,
      params
    );
    const r = rows[0] || {};
    return {
      cash: Number(r.cash_amt || 0),
      card: Number(r.card_amt || 0),
      gcash: Number(r.gcash_amt || 0),
      bank: Number(r.bank_amt || 0),
      total: Number(r.total_amt || 0),
    };
  } catch (e) {
    if (e.code === "ER_NO_SUCH_TABLE" || e.code === "ER_BAD_FIELD_ERROR") return empty;
    throw e;
  }
}
