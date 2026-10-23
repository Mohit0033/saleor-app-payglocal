# saleor-app-payglocal

Saleor **payment app** for [PayGlocal](https://payglocal.in) — PayCollect hosted
checkout. Built on `@saleor/app-sdk`, structured after
[`Mohit0033/saleor-paypal-integration`](https://github.com/Mohit0033/saleor-paypal-integration)
(the `saleor.app.paypal` app), so it behaves identically from Saleor's point of
view. App identifier: `saleor.app.payglocal`.

PayGlocal collects all card data on **their** hosted page (redirect flow) —
no PCI burden on us. Payments are signed out of the app with merchant RSA keys
(JWS in `x-gl-token-external`); nothing sensitive is ever sent from the browser
to PayGlocal.

## Structure

```
src/
  saleor-app.ts                  # FileAPL (mirrors the PayPal app)
  lib/
    payglocal.ts                 # JWS signing (RS256), GPI initiate, status, callback decode
    txn-store.ts                 # transient txn registry (file-backed, atomic writes)
  pages/
    api/
      manifest.ts                # createManifestHandler → /api/manifest
      register.ts                # createAppRegisterHandler → /api/register (tokenTargetUrl)
      payglocal/callback.ts      # PayGlocal merchantCallbackURL (NOT a Saleor webhook)
      webhooks/
        transaction-initialize-session.ts   # sync: starts PayGlocal hosted sale
        transaction-process-session.ts      # sync: status → ACTION_REQUIRED / CHARGE_SUCCESS / FAILURE
    index.tsx                    # install info page (manifest URL)
```

## Flow

```
storefront ─transactionInitialize▶ Saleor ─TRANSACTION_INITIALIZE_SESSION sync─▶ app
   ◀── { pspReference: gid, result: CHARGE_ACTION_REQUIRED, data: { redirectUrl } } ┘
        (app signs + POSTs /gl/v1/payments/initiate/paycollect; browser never sees keys)

storefront ─transactionProcess▶ Saleor ─TRANSACTION_PROCESS_SESSION sync─▶ app
   pending   → { result: ACTION_REQUIRED-variant, data: { redirectUrl } }   → browser redirect
   paid      → { result: CHARGE_SUCCESS + amount verify + REFUND action }

buyer pays on PayGlocal hosted page
PayGlocal POSTs { x-gl-token } → /api/payglocal/callback
   decode → re-confirm via status API (never trust callback alone) →
   transactionEventReport CHARGE_SUCCESS (idempotent) → 302 buyer back
   to STOREFRONT_URL/order/payglocal-return
```

Idempotency: re-initialization re-returns the stored `redirectUrl`; duplicate
callbacks are guarded by the registry flag + `transactionEventReport`
dedupe; every `CHARGE_SUCCESS` is amount/currency-verified against PayGlocal
(nonlinearity > 0.01 → failure), PayPal-app style.

Only `SENT_FOR_CAPTURE` (sale) / `AUTHORIZED` means paid. `ISSUER_DECLINE`,
`GENERAL_DECLINE`, `CUSTOMER_CANCELLED`, `ABANDONED`, `REQUEST_ERROR` → failure.

## Requirements

- Node 22+
- **Persistent-disk hosting** (App must write `FileAPL` state and the txn
  registry) — LXC/Docker fine; not serverless.
- Env (see `.env.example`):
  - `PAYGLOCAL_MID`, `PAYGLOCAL_KID`, `PAYGLOCAL_PRIVATE_KEY` — GCC UAT keys
    (UAT keys never work in production)
  - `PAYGLOCAL_API_BASE` — `https://api.uat.payglocal.in` (prod: `https://api.payglocal.in`)
  - `APP_URL` — public base URL of this app (hosted-page callback origin)
  - `STOREFRONT_URL` — buyer return target (`/order/payglocal-return`)
  - `ALLOWED_SALEOR_URL` — optional instance pin

## Run

```bash
npm install
npm run dev        # development
npm run build && npm start
# or:
docker compose up --build   # reads PAYGLOCAL_* from the host env
```

Mount `/data` in Docker for `saleor-app.json` (APL) and
`PAYGLOCAL_TXN_STORE=/data/.payglocal-txn.json`.

## Register in Saleor

1. Dashboard → **Apps → Add app** → paste `{APP_URL}/api/manifest`
   → grant **HANDLE_PAYMENTS** → install (land on `/api/register`).
2. Confirm the `global` channel exposes gateway id `saleor.app.payglocal`
   (the storefront picks it via `POST /api/checkout/transaction { gateway: "payglocal" }`).
3. Ask PayGlocal (account manager / merchant.support@payglocal.in) to whitelist
   the UAT callback URL: `{APP_URL}/api/payglocal/callback`.
4. Sandbox-test with UAT test cards on a dummy checkout; watch logs while
   tailing (`npm start` console / `docker compose logs -f`).

Endpoint note: `SALEOR_API_URL`/`SALEOR_APP_TOKEN` of the affiliate system are
unrelated — this app gets its Saleor auth via the standard app install flow.

## UAT probe checklist (first run)

- JWS header member types: if initiate 401s, flip `JWS_HEADER_AS_STRINGS` in
  `src/lib/payglocal.ts` (docs show both strings and booleans).
- Status verb: signed POST of `{}` is implemented; if UAT insists on literal
  GET semantics, swap the method in `getTransactionStatus` (same signed headers).
- Callback content-type: JSON, form-urlencoded and `x_gl_token` variants handled.

## Production go-live

- New MID/keys, secret env swap, `PAYGLOCAL_API_BASE=https://api.payglocal.in`, re-register callback.
- Refunds (deferred by decision): `TRANSACTION_REFUND_REQUESTED` sync webhook →
  PayGlocal Refund API → `REFUND_SUCCESS` report (same app, later session).
