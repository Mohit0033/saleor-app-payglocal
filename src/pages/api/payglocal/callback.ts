// PayGlocal merchantCallbackURL — NOT a Saleor webhook.
//
// PayGlocal POSTs here after every payment (success or failure) with a single
// field `x-gl-token` — an RS256 JWT whose base64url section [1] holds the
// payment result. Docs-mandated handling: decode segment 1, read `status`.
// We never act on the callback alone: the authoritative status is re-read
// via the status API, then the charge is reported to Saleor exactly once
// (transactionEventReport is idempotent via pspReference + our own flag).
//
// The 302 response sends the buyer's browser back to the storefront.

import type { NextApiRequest, NextApiResponse } from "next";
import {
  decodeCallbackToken,
  getTransactionStatus,
  PayGlocalError,
  payglocalConfigFromEnv,
} from "@/lib/payglocal";
import {
  loadTxnByMerchantTxnId,
  loadTxnByTransactionId,
  updateTxn,
  type TxnRecord,
} from "@/lib/txn-store";
import { apl } from "@/saleor-app";
import type { AuthData } from "@saleor/app-sdk/APL";

interface CallbackPayload {
  gid?: string;
  merchantTxnId?: string;
  [key: string]: unknown;
}

const SUCCESS_STATUSES = new Set(["SENT_FOR_CAPTURE", "AUTHORIZED"]);

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const token = extractToken(req);
  if (!token) {
    res.status(400).send("Token missing");
    return;
  }

  const payload = decodeCallbackToken(token);
  if (!payload) {
    res.status(400).send("Undecodable token");
    return;
  }

  const merchantTxnId = String(payload.merchantTxnId || payload["merchant_txn_id"] || "");
  const txn = merchantTxnId
    ? await loadTxnByMerchantTxnId(merchantTxnId)
    : null;

  if (!txn) {
    // Unknown transaction — still be polite to the buyer's browser.
    redirectBuyer(res, "", null, "INVALID");
    return;
  }

  // NEVER trust the callback alone — confirm via the status API.
  const callbackStatus = String(payload.status || "").toUpperCase();
  let psStatus = callbackStatus;
  try {
    const status = await getTransactionStatus(payglocalConfigFromEnv(), txn.gid);
    psStatus = String(
      status.status || (status.data as Record<string, unknown> | null)?.status || callbackStatus
    ).toUpperCase();
  } catch (error) {
    console.error("[callback] status confirm failed:", error);
    // Unreachable status API: process the callback status but flag it.
  }

  const success = SUCCESS_STATUSES.has(psStatus);

  if (success && !txn.reported) {
    await reportChargeSuccess(res, txn, psStatus);
  }

  redirectBuyer(res, txn.checkoutId, txn.transactionId, psStatus);
}

function extractToken(req: NextApiRequest): string | null {
  if (typeof req.body !== "object" || req.body === null) return null;
  const body = req.body as Record<string, unknown>;
  const direct = body.x_gl_token ?? body["x-gl-token"] ?? body.token;
  if (typeof direct === "string" && direct.split(".").length === 3) return direct;
  return null;
}

async function reportChargeSuccess(
  res: NextApiResponse,
  txn: TxnRecord,
  psStatus: string
): Promise<void> {
  const authData: AuthData | undefined = await apl.get(txn.saleorApiUrl);
  if (!authData?.token) {
    console.error(`[callback] no APL entry for ${txn.saleorApiUrl}`);
    return;
  }

  const mutation = `
    mutation TransactionEventReport($id: ID!, $pspReference: String!, $type: TransactionEventTypeEnum!, $amount: PositiveDecimal, $message: String, $externalUrl: String, $availableActions: [TransactionActionEnum!]) {
      transactionEventReport(
        id: $id
        pspReference: $pspReference
        type: $type
        amount: $amount
        message: $message
        externalUrl: $externalUrl
        availableActions: $availableActions
      ) {
        transactionEvent {
          id
          alreadyProcessed
        }
        errors {
          field
          message
        }
      }
    }
  `;

  try {
    const response = await fetch(new URL(txn.saleorApiUrl).toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authData.token}`,
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          id: txn.transactionId,
          pspReference: txn.gid,
          type: "CHARGE_SUCCESS",
          amount: txn.amount,
          message: "Payment captured via PayGlocal",
          externalUrl: txn.redirectUrl,
          availableActions: ["REFUND"],
        },
      }),
    });

    const json = (await response.json()) as {
      data?: {
        transactionEventReport?: {
          transactionEvent?: { alreadyProcessed: boolean } | null;
          errors?: { message: string }[] | null;
        } | null;
      };
      errors?: { message: string }[];
    };

    const report = json.data?.transactionEventReport;
    if (report?.errors?.length) {
      console.error("[callback] event report errors:", report.errors[0].message);
    } else if (json.errors?.length) {
      console.error("[callback] event report GraphQL errors:", json.errors[0].message);
    } else {
      console.log(
        `[callback] CHARGE_SUCCESS reported (${txn.gid}, alreadyProcessed=${report?.transactionEvent?.alreadyProcessed})`
      );
    }
  } catch (err) {
    // Network hiccup — the process-webhook path self-heals on the next poll.
    console.error("[callback] event report failed:", err);
    if (err instanceof PayGlocalError) console.error(err.message);
  } finally {
    // Mark locally regardless — avoids a report storm; transactionProcess
    // reconfirms via its own sync CHARGE_SUCCESS path on the next poll.
    await updateTxn(txn.transactionId, { reported: true });
  }
}

function redirectBuyer(
  res: NextApiResponse,
  checkoutId: string,
  transactionId: string | null,
  status: string
): void {
  const storefront = (process.env.STOREFRONT_URL || "").replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (checkoutId) params.set("checkoutId", checkoutId);
  if (transactionId) params.set("transactionId", transactionId);
  params.set("ps", status);
  res.redirect(302, `${storefront}/order/payglocal-return?${params.toString()}`);
}

// The callback must bypass Next's JSON body parser and default caching.
export const config = {
  api: { bodyParser: true, externalResolver: true },
};
