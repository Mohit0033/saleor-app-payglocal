// Transient transaction registry.
//
// Maps the pieces that must survive between webhooks and the PayGlocal
// merchantCallbackURL:
//   by saleor transaction id  → PayGlocal context (gid, redirectUrl, …)
//   by merchantTxnId          → PayGlocal context (callback payload only
//                               carries merchantTxnId)
//
// File-backed so the application and the registry survive restarts on the
// same host (the app must run on persistent storage — same requirement as
// FileAPL). Writes are atomic via tmp+rename.

import { promises as fs } from "fs";
import path from "path";
import { PayGlocalError } from "./payglocal";

export interface TxnRecord {
  /** Saleor transaction item id ((TransactionItem:<base64>)) */
  transactionId: string;
  /** Checkout id the buyer was paying on (for the storefront return redirect) */
  checkoutId: string;
  /** PayGlocal merchantTxnId we generated (4–50 alphanumeric) */
  merchantTxnId: string;
  /** PayGlocal gid */
  gid: string;
  redirectUrl: string;
  statusUrl: string;
  amount: string;
  currency: string;
  /** Saleor instance that owns the transaction (multi-instance APL setups) */
  saleorApiUrl: string;
  /** CHARGE_SUCCESS already reported to Saleor (idempotency) */
  reported?: boolean;
}

function storePath(): string {
  return path.resolve(process.env.PAYGLOCAL_TXN_STORE || ".payglocal-txn.json");
}

async function load(): Promise<Record<string, TxnRecord>> {
  try {
    return JSON.parse(await fs.readFile(storePath(), "utf8")) as Record<
      string,
      TxnRecord
    >;
  } catch {
    return {};
  }
}

async function save(map: Record<string, TxnRecord>): Promise<void> {
  const file = storePath();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(map), "utf8");
  await fs.rename(tmp, file);
}

function keyFor(r: TxnRecord): { byTxn: string; byMtxn: string } {
  return { byTxn: `txn:${r.transactionId}`, byMtxn: `mtxn:${r.merchantTxnId}` };
}

export async function saveTxn(record: TxnRecord): Promise<void> {
  const map = await load();
  const keys = keyFor(record);
  // index-by-txn is authoritative; mtxn index stores the same record twice
  map[keys.byTxn] = record;
  map[keys.byMtxn] = record;
  await save(map);
}

export async function loadTxnByTransactionId(
  transactionId: string
): Promise<TxnRecord | null> {
  const map = await load();
  return map[`txn:${transactionId}`] || null;
}

export async function loadTxnByMerchantTxnId(
  merchantTxnId: string
): Promise<TxnRecord | null> {
  const map = await load();
  return map[`mtxn:${merchantTxnId}`] || null;
}

export async function updateTxn(
  transactionId: string,
  patch: Partial<TxnRecord>
): Promise<TxnRecord | null> {
  const map = await load();
  const key = `txn:${transactionId}`;
  const current = map[key];
  if (!current) return null;
  const updated = { ...current, ...patch };
  map[key] = updated;
  map[`mtxn:${current.merchantTxnId}`] = updated;
  await save(map);
  return updated;
}

/** merchantTxnId must satisfy PayGlocal's 4–50 alphanumeric constraint. */
export function newMerchantTxnId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export function ensureStoreUsable(): void {
  // Fail fast at boot-ish time (first webhook call) if the store is unwritable.
  try {
    fs.access(path.dirname(storePath()));
  } catch (err) {
    throw new PayGlocalError(
      `Transaction registry not writable (${storePath()}): ${String(err)}`
    );
  }
}
