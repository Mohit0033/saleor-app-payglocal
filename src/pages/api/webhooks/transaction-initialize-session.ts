import { SaleorSyncWebhook } from "@saleor/app-sdk/handlers/next";
import { saleorApp } from "../../../saleor-app";
import { gql } from "urql";
import {
  gpiPayCollectInitiate,
  payglocalConfigFromEnv,
  type BillingData,
  PayGlocalError,
} from "@/lib/payglocal";
import { loadTxnByTransactionId, newMerchantTxnId, saveTxn } from "@/lib/txn-store";

type TransactionInitializeSessionPayloadFragment = any;

const TransactionInitializeSessionPayload = gql`
  fragment TransactionInitializeSessionPayload on TransactionInitializeSession {
    action {
      amount
      currency
      actionType
    }
    data
    transaction {
      id
      pspReference
      checkout {
        id
        email
        user {
          email
        }
        billingAddress {
          firstName
          lastName
          phone
          streetAddress1
          streetAddress2
          city
          postalCode
          countryArea
          country {
            code
          }
        }
        shippingAddress {
          firstName
          lastName
          phone
          country {
            code
          }
        }
      }
    }
  }
`;

const TransactionInitializeSessionSubscription = gql`
  ${TransactionInitializeSessionPayload}
  subscription TransactionInitializeSession {
    event {
      ...TransactionInitializeSessionPayload
    }
  }
`;

export const transactionInitializeSessionWebhook = new SaleorSyncWebhook<TransactionInitializeSessionPayloadFragment>(
  {
    name: "PayGlocal Transaction Initialize",
    webhookPath: "/api/webhooks/transaction-initialize-session",
    event: "TRANSACTION_INITIALIZE_SESSION",
    apl: saleorApp.apl,
    query: TransactionInitializeSessionSubscription,
  }
);

// Country alpha-2 (Saleor) → alpha-3 (PayGlocal). Major markets; unknown
// codes are omitted (PayGlocal's billing country field is optional).
const ISO2_TO_ISO3: Record<string, string> = {
  AR: "ARG", AE: "ARE", AT: "AUT", AU: "AUS", BD: "BGD", BE: "BEL", BR: "BRA",
  CA: "CAN", CH: "CHE", CL: "CHL", CN: "CHN", CZ: "CZE", DE: "DEU", DK: "DNK",
  ES: "ESP", FI: "FIN", FR: "FRA", GB: "GBR", GR: "GRC", HK: "HKG", HR: "HRV",
  IE: "IRL", IL: "ISR", IN: "IND", IT: "ITA", JP: "JPN", KR: "KOR", KW: "KWT",
  LU: "LUX", MX: "MEX", MY: "MYS", NL: "NLD", NO: "NOR", NZ: "NZL", OM: "OMN",
  PH: "PHL", PK: "PAK", PL: "POL", PT: "PRT", QA: "QAT", RO: "ROU", RS: "SRB",
  RU: "RUS", SA: "SAU", SE: "SWE", SG: "SGP", SI: "SVN", SK: "SVK", TH: "THA",
  TR: "TUR", TW: "TWN", UA: "UKR", US: "USA", VN: "VNM", ZA: "ZAF",
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Phone in Saleor often includes the calling code; PayGlocal wants the body. */
function phoneBody(phone: string): string | undefined {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-10) || undefined;
}

function billingFromCheckout(
  checkout: Record<string, any> | null | undefined
): BillingData | undefined {
  const addr = checkout?.billingAddress;
  if (!addr) return undefined;
  const email = str(checkout?.email) || str(checkout?.user?.email) || undefined;
  const bill: BillingData = {
    emailId: email,
    firstName: str(addr.firstName) || undefined,
    lastName: str(addr.lastName) || undefined,
    phoneNumber: str(addr.phone) ? phoneBody(str(addr.phone)) : undefined,
    addressStreet1: str(addr.streetAddress1) || undefined,
    addressStreet2: str(addr.streetAddress2) || undefined,
    addressCity: str(addr.city) || undefined,
    addressState: str(addr.countryArea) || undefined,
    addressPostalCode: str(addr.postalCode) || undefined,
  };
  const country2 = str(addr.country?.code);
  if (country2 && ISO2_TO_ISO3[country2]) {
    bill.addressCountry = ISO2_TO_ISO3[country2];
  }
  return bill;
}

function callbackUrl(): string {
  const base = (process.env.APP_URL || "").replace(/\/+$/, "");
  return `${base}/api/payglocal/callback`;
}

/** Global alternative payments require shipping country + buyer email. */
function riskShipping(
  checkout: Record<string, any> | null | undefined,
  bill: BillingData | undefined
) {
  const addr = checkout?.shippingAddress;
  if (!addr) return undefined;
  const email = str(checkout?.email) || str(checkout?.user?.email) || bill?.emailId || undefined;
  const country2 = str(addr.country?.code);
  return {
    firstName: str(addr.firstName) || undefined,
    lastName: str(addr.lastName) || undefined,
    emailId: email,
    addressCountry: country2 && ISO2_TO_ISO3[country2] ? ISO2_TO_ISO3[country2] : country2 || undefined,
  };
}

function moneyString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return value.toFixed(2);
  return "0.00";
}

export default transactionInitializeSessionWebhook.createHandler(
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
        pspReference: transaction?.pspReference || "unknown",
        message: "Only CHARGE strategy supported",
      });
    }

    const amount = moneyString(action.amount);
    if (!action.currency || parseFloat(amount) <= 0) {
      return res.status(200).json({
        result: "CHARGE_FAILURE",
        amount,
        pspReference: transaction?.pspReference || "unknown",
        message: `Invalid amount or currency: ${amount} ${action.currency}`,
      });
    }

    const transactionId = String(transaction?.id || "");
    const checkout = transaction?.checkout;

    // Idempotent re-initialization: PayGlocal transaction already exists.
    const existing = transactionId
      ? await loadTxnByTransactionId(transactionId)
      : null;
    if (existing) {
      return res.status(200).json({
        result: "CHARGE_ACTION_REQUIRED",
        amount: existing.amount,
        pspReference: existing.gid,
        data: {
          redirectUrl: existing.redirectUrl,
        },
      });
    }

    try {
      const merchantTxnId = newMerchantTxnId();
      const bill = billingFromCheckout(checkout);

      const response = await gpiPayCollectInitiate(payglocalConfigFromEnv(), {
        merchantTxnId,
        merchantUniqueId: merchantTxnId,
        paymentData: {
          totalAmount: amount,
          txnCurrency: action.currency,
          billingData: bill,
        },
        riskData: {
          shippingData: riskShipping(checkout, bill),
        },
        merchantCallbackURL: callbackUrl(),
      });

      const gid = String(response.gid);
      const redirectUrl = String(response.data?.redirectUrl || "");
      const statusUrl = String(response.data?.statusUrl || "");

      await saveTxn({
        transactionId,
        checkoutId: str(checkout?.id),
        merchantTxnId,
        gid,
        redirectUrl,
        statusUrl,
        amount,
        currency: action.currency,
        saleorApiUrl: authData.saleorApiUrl,
      });

      console.log(
        `[INIT] PayGlocal ${gid} — ${action.currency} ${amount} (merchantTxnId ${merchantTxnId})`
      );

      return res.status(200).json({
        result: "CHARGE_ACTION_REQUIRED",
        amount,
        pspReference: gid,
        data: {
          redirectUrl,
        },
      });
    } catch (error) {
      console.error("PayGlocal initiate failed:", error);

      const message =
        error instanceof PayGlocalError
          ? `PayGlocal: ${error.message}`
          : "Failed to create PayGlocal transaction";

      return res.status(200).json({
        result: "CHARGE_FAILURE",
        amount,
        pspReference: transaction?.pspReference || `fail_${Date.now()}`,
        message,
      });
    }
  }
);

export const config = {
  api: { bodyParser: false },
};
