// PayGlocal HTTP client.
//
// Auth: every /gl/v1/payments/* request carries an RS256 JWS in
// `x-gl-token-external`. We use the NON-digested form (payload = exact JSON
// body), so the signed bytes and the request bytes are identical — no
// digest-encoding ambiguity.
//   JWS header: { alg: "RS256", kid: <pvt-key kid>, iss: <MID>,
//                 "x-gl-enc": "false", "is-digested": "false" }
// The docs show header members both as bare booleans (callback token sample)
// and strings (OpenAPI security-scheme description). If the UAT probe rejects
// the token, flip JWS_HEADER_AS_STRINGS.

export interface PayGlocalConfig {
  apiBase: string;
  merchantId: string;
  kid: string;
  privateKeyPem: string;
}

export function payglocalConfigFromEnv(): PayGlocalConfig {
  return {
    apiBase: (process.env.PAYGLOCAL_API_BASE || "https://api.uat.payglocal.in").replace(/\/+$/, ""),
    merchantId: process.env.PAYGLOCAL_MID || "",
    kid: process.env.PAYGLOCAL_KID || "",
    privateKeyPem: (process.env.PAYGLOCAL_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  };
}

export class PayGlocalError extends Error {}

const JWS_HEADER_AS_STRINGS = true;

// ── base64url helpers (Node 22: WebCrypto + Buffer available) ─────────────

function bytesToB64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// ── RSA private key (PEM) → WebCrypto key (cached per process) ────────────

let cachedKey: { kid: string; key: CryptoKey } | null = null;

async function signKey(config: PayGlocalConfig): Promise<CryptoKey> {
  if (cachedKey && cachedKey.kid === config.kid) return cachedKey.key;

  if (!config.privateKeyPem) {
    throw new PayGlocalError("PAYGLOCAL_PRIVATE_KEY is not configured");
  }
  const body = config.privateKeyPem
    .trim()
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const raw = Buffer.from(body, "base64");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    raw,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  cachedKey = { kid: config.kid, key };
  return key;
}

/** Compact RS256 JWS whose payload is the exact request body. */
async function buildJws(config: PayGlocalConfig, body: string): Promise<string> {
  const key = await signKey(config);
  const header = JWS_HEADER_AS_STRINGS
    ? {
        alg: "RS256",
        kid: config.kid,
        iss: config.merchantId,
        "x-gl-enc": "false",
        "is-digested": "false",
      }
    : { alg: "RS256", kid: config.kid, iss: config.merchantId, "x-gl-enc": false, "is-digested": false };

  const signedInput =
    bytesToB64Url(Buffer.from(JSON.stringify(header), "utf8")) +
    "." +
    bytesToB64Url(Buffer.from(body, "utf8"));

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(signedInput, "utf8")
  );
  return signedInput + "." + bytesToB64Url(new Uint8Array(sig));
}

// ── API calls ─────────────────────────────────────────────────────────────

async function callSigned<T>(
  config: PayGlocalConfig,
  body: string,
  path: string
): Promise<{ ok: boolean; status: number; json: T | null; text: string }> {
  const token = await buildJws(config, body);
  const res = await fetch(config.apiBase + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-gl-token-external": token,
      "x-gl-merchantid": config.merchantId,
      "x-gl-kid": config.kid,
    },
    body,
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    /* keep null */
  }
  return { ok: res.ok, status: res.status, json, text };
}

export interface BillingData {
  firstName?: string;
  lastName?: string;
  emailId?: string;
  callingCode?: string;
  phoneNumber?: string;
  addressStreet1?: string;
  addressStreet2?: string;
  addressCity?: string;
  addressState?: string;
  addressStateCode?: string;
  addressPostalCode?: string;
  /** ISO 3166-1 alpha-3 (e.g. USA, GBR, IND) */
  addressCountry?: string;
}

export interface GpiInitiateBody {
  /** 4–50 chars, ALPHANUMERIC ONLY */
  merchantTxnId: string;
  /** 15–40 chars alnum — stable idempotency reference */
  merchantUniqueId?: string;
  paymentData: {
    totalAmount: string;
    txnCurrency: string;
    billingData?: BillingData;
  };
  riskData?: {
    customerData?: Record<string, unknown>;
    shippingData?: Record<string, unknown>;
  };
  /** https only — PayGlocal POSTs the result here and redirects the buyer */
  merchantCallbackURL: string;
}

export interface GpiInitiateResponse {
  gid: string | null;
  status: string | null;
  message: string | null;
  reasonCode: string | null;
  timestamp: string | null;
  data: {
    redirectUrl: string;
    statusUrl: string;
    merchantTxnId: string;
  } | null;
  errors: unknown;
}

/** PayCollect GPI — one-step hosted sale (no card data in our request). */
export async function gpiPayCollectInitiate(
  config: PayGlocalConfig,
  body: GpiInitiateBody
): Promise<GpiInitiateResponse> {
  const res = await callSigned<GpiInitiateResponse>(
    config,
    JSON.stringify(body),
    "/gl/v1/payments/initiate/paycollect"
  );
  if (!res.json) {
    throw new PayGlocalError(
      `Initiate returned non-JSON (HTTP ${res.status}): ${res.text.slice(0, 300)}`
    );
  }
  if (!res.json.gid || !res.json.data?.redirectUrl) {
    // Validation errors carry errorDetails[]; surface the first message.
    const raw = res.json as unknown as { errorDetails?: { field?: string; message?: string }[] };
    const detail = raw.errorDetails?.[0];
    throw new PayGlocalError(
      detail
        ? `${detail.message} (${detail.field})`
        : `${res.json.message || "Initiate failed"} (reason ${res.json.reasonCode || "?"})`
    );
  }
  return res.json;
}

export interface TransactionStatusResponse {
  gid: string | null;
  status: string | null; // SENT_FOR_CAPTURE | INPROGRESS | AUTHORIZED | failures…
  message: string | null;
  reasonCode: string | null;
  timestamp: string | null;
  data: Record<string, unknown> | null; // varies by payment-method
  errors: unknown;
}

/** Status by gid — the recommended source of truth for outcome + reconcile. */
export async function getTransactionStatus(
  config: PayGlocalConfig,
  gid: string
): Promise<TransactionStatusResponse> {
  // Signed POST of an empty JSON body on the /status path (validated against
  // UAT during the spike; flip to a GET carrying the same signed headers if
  // UAT insists on literal GET semantics).
  const res = await callSigned<TransactionStatusResponse>(
    config,
    "{}",
    `/gl/v1/payments/${encodeURIComponent(gid)}/status`
  );
  if (!res.json) {
    throw new PayGlocalError(
      `Status returned non-JSON (HTTP ${res.status}): ${res.text.slice(0, 300)}`
    );
  }
  return res.json;
}

/**
 * Decode the x-gl-token callback JWT — the docs-mandated procedure: split on
 * ".", base64url-decode segment index 1, JSON.parse. We deliberately do not
 * trust it alone: the caller re-confirms via getTransactionStatus.
 */
export function decodeCallbackToken(
  token: string
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
