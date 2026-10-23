import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next";
import { saleorApp } from "../../../saleor-app";
import { gql } from "urql";
import {
  getTransactionStatus,
  PayGlocalError,
  payglocalConfigFromEnv,
} from "@/lib/payglocal";
import { loadTxnByTransactionId } from "@/lib/txn-store";

type TransactionProcessSessionPayloadFragment = any;

const TransactionProcessSessionPayload = gql`
  fragment TransactionProcessSessionPayload on TransactionProcessSession {
    action {
      amount
      currency
      actionType
    }
    data
    transaction {
      id
      pspReference
    }
  }
`;

const TransactionProcessSessionSubscription = gql`
  ${TransactionProcessSessionPayload}
  subscription TransactionProcessSession {
    event {
      ...TransactionProcessSessionPayload
    }
  }
`;

export const transactionProcessSessionWebhook = new SaleorSyncWebhook<TransactionProcessSessionPayloadFragment>(
  {
    name: "PayGlocal Transaction Process",
    webhookPath: "/api/webhooks/transaction-process-session",
    event: "TRANSACTION_PROCESS_SESSION",
    apl: saleorApp.apl,
    query: TransactionProcessSessionSubscription,
  }
);

function moneyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toFixed(2);
  return "0.00";
}

function methodLabel(data: Record<string, unknown> | null): string {
  if (!data) return "PayGlocal";
  const pm = String(data["payment-method"] || "").toUpperCase();
  if (pm.startsWith("CARD")) {
    return `PayGlocal card ${String(data.CardBrand || "").toUpperCase()}`.trim();
  }
  if (pm.startsWith("UPI")) return "PayGlocal UPI";
  if (pm === "INB") return "PayGlocal net banking";
  return `PayGlocal (${pm || "online"})`;
}

const FAILURE_STATUSES: Record<string, string> = {
  ISSUER_DECLINE: "Your bank declined the payment (issuer decline)",
  GENERAL_DECLINE: "Payment declined (risk check)",
  CUSTOMER_CANCELLED: "Payment was cancelled on the payment page",
  ABANDONED: "Payment was not completed",
  REQUEST_ERROR: "Payment request error",
};

export default transactionProcessSessionWebhook.createHandler(
  async (req, res, ctx) => {
    const { payload, authData } = ctx;
    const { action, transaction } = payload;

    // Optional allowlist guard (mirrors the PayPal app)
    const ALLOWED_SALEOR_URL = process.env.ALLOWED_SALEOR_URL;
    if (ALLOWED_SALEOR_URL && authData.saleorApiUrl !== ALLOWED_SALEOR_URL) {
      console.error("Rejected unauthorized Saleor:", authData.saleorApiUrl);
      return res.status(403).json({ error: "Unauthorized Saleor instance" });
    }

    if (action.actionType !== "CHARGE") {
      return res.status(200).json({
        result: "CHARGE_FAILURE",
        amount: moneyString(action.amount),
        currency: action.currency,
        pspReference: transaction?.pspReference || "unknown",
        message: "Only CHARGE strategy supported",
      });
    }

    const transactionId = String(transaction?.id || "");
    const txn = transactionId ? await loadTxnByTransactionId(transactionId) : null;

    if (!txn) {
      return res.status(200).json({
        result: "CHARGE_FAILURE",
        amount: moneyString(action.amount),
        currency: action.currency,
        pspReference: transaction?.pspReference || `fail_${Date.now()}`,
        message: "PayGlocal transaction not found for this Saleor transaction",
      });
    }

    try {
      const status = await getTransactionStatus(payglocalConfigFromEnv(), txn.gid);
      // Top-level status is authoritative; data.status mirrors it on success.
      const psStatus = String(status.status || (status.data as any)?.status || "").toUpperCase();

      if (psStatus === "SENT_FOR_CAPTURE" || psStatus === "AUTHORIZED") {
        // Amount/currency verification, PayPal-app style.
        const dataObj = (status.data as Record<string, unknown>) || {};
        const paidAmount = String(dataObj.Amount || dataObj.upiTxnAmount || txn.amount);
        const paidCurrency = String(
          (dataObj.Currency || dataObj.upiTxnCurrency || txn.currency) as string
        ).toUpperCase();

        if (Math.abs(parseFloat(paidAmount) - parseFloat(txn.amount)) > 0.01) {
          return res.status(200).json({
            result: "CHARGE_FAILURE",
            amount: txn.amount,
            currency: txn.currency,
            pspReference: txn.gid,
            message: "Payment amount mismatch",
          });
        }

        if (paidCurrency && paidCurrency !== txn.currency.toUpperCase()) {
          return res.status(200).json({
            result: "CHARGE_FAILURE",
            amount: txn.amount,
            currency: txn.currency,
            pspReference: txn.gid,
            message: "Payment currency mismatch",
          });
        }

        console.log(`✅ CHARGE_SUCCESS — ${paidAmount} ${paidCurrency} (${txn.gid})`);
        return res.status(200).json({
          result: "CHARGE_SUCCESS",
          amount: paidAmount,
          currency: paidCurrency,
          pspReference: txn.gid,
          data: {
            gid: txn.gid,
            merchantTxnId: txn.merchantTxnId,
            payglocalStatus: psStatus,
            confirmedAt: new Date().toISOString(),
          },
          actions: ["REFUND"],
          externalUrl: txn.redirectUrl,
          paymentMethodDetails: { type: "OTHER", name: methodLabel(dataObj) },
        });
      }

      if (FAILURE_STATUSES[psStatus]) {
        return res.status(200).json({
          result: "CHARGE_FAILURE",
          amount: txn.amount,
          currency: txn.currency,
          pspReference: txn.gid,
          message: FAILURE_STATUSES[psStatus],
        });
      }

      // INPROGRESS / unknown → keep the action open; the storefront keeps
      // polling transactionProcess and the hosted page carries on paying.
      return res.status(200).json({
        result: "CHARGE_ACTION_REQUIRED",
        amount: txn.amount,
        currency: txn.currency,
        pspReference: txn.gid,
        data: { redirectUrl: txn.redirectUrl },
        externalUrl: txn.redirectUrl,
      });
    } catch (error) {
      console.error("PayGlocal status check failed:", error);

      // Fail open as pending — a PayGlocal hiccup must not fail the payment.
      const message =
        error instanceof PayGlocalError
          ? `PayGlocal: ${error.message}`
          : "Status check error; payment still pending";

      return res.status(200).json({
        result: "CHARGE_ACTION_REQUIRED",
        amount: txn.amount,
        currency: txn.currency,
        pspReference: txn.gid,
        data: { redirectUrl: txn.redirectUrl },
        externalUrl: txn.redirectUrl,
        message: message.slice(0, 512),
      });
    }
  }
);

export const config = {
  api: { bodyParser: false },
};
