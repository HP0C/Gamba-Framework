# Gamba Server Skeleton

A TypeScript monorepo for a local, demo-credit betting application. It contains a NestJS API, PostgreSQL/Prisma 6 persistence, a deliberately thin React/Vite client, Docker Compose, and optional Prisma Studio.

## Structure

```text
apps/
  backend/
    prisma/                 schema and initial migration
    src/
      auth/                 password, Google OAuth structure, JWT sessions
      users/ wallet/ bets/  controllers, services, managers, modules
      banking/              TrueLayer Data/Payments sandbox integration
      audit/ prisma/        server-owned support modules
    test/
  frontend/                 React/Vite client
docker-compose.yml
package.json                npm workspaces root
```

Controllers handle HTTP, services coordinate use cases, and managers own lower-level business/database orchestration. Monetary values are PostgreSQL `BIGINT`/Prisma `BigInt` minor units and API money fields are decimal strings, avoiding floating-point accounting.

## Run With Docker

Requirements: Docker with Compose v2.

```bash
docker compose up --build
```

Open the UI at <http://localhost:5173>; the API is at <http://localhost:3000/api>. The backend waits for PostgreSQL and runs `prisma migrate deploy` before starting. Local Compose defaults issue new password accounts GBP 100.00 of explicitly labeled demo credit through a ledger transaction. Banking uses `TRUELAYER_MODE=sandbox`; paste sandbox keys into the root `.env` before using the banking buttons.

Stop services with `docker compose down`. Add `-v` only when you intentionally want to delete local database data.

## Prisma

The initial migration is deployed automatically by the backend container. To apply committed migrations manually:

```bash
docker compose run --rm backend npx prisma migrate deploy
```

Start Prisma Studio at <http://localhost:5555>:

```bash
docker compose --profile tools up studio
```

For native development, copy `apps/backend/.env.example` to `apps/backend/.env`, point `DATABASE_URL` at localhost, then use:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio
```

`prisma migrate dev` is a development command that creates migration files. Commit and deploy reviewed migrations with `prisma migrate deploy` in shared environments.

## Authentication

- `POST /api/auth/register` creates a local user and Argon2id password hash.
- `POST /api/auth/login` verifies password credentials.
- `POST /api/auth/refresh` rotates the refresh session.
- `POST /api/auth/logout` revokes the current session.
- `GET /api/auth/me` returns the current user.
- `GET /api/auth/google` and `/callback` provide the Passport Google OAuth structure and return 503 until credentials are configured.

Access and refresh JWTs use secure, HTTP-only, SameSite=Lax cookies. Refresh tokens are Argon2id-hashed in revocable database sessions. Cookies are non-`Secure` only in localhost development; production needs HTTPS, deliberate proxy/cookie-domain configuration, CSRF review, rate limiting, credential-stuffing protection, breached-password policy, and secret rotation.

## Banking And TrueLayer Sandbox

The banking module is deliberately separate from betting:

- `POST /api/banking/connect` starts a banking connection using the configured provider mode.
- `GET /api/banking/truelayer/callback` receives the browser redirect after a TrueLayer sandbox hosted connection flow.
- `GET /api/banking/truelayer/payment-callback` receives the browser redirect after a TrueLayer sandbox payment hosted page flow.
- `POST /api/banking/sync` refreshes cached account and transaction data.
- `GET /api/banking` returns connections, bank accounts, recent external bank transactions, deposits, and payouts.
- `POST /api/banking/deposits` creates a signed TrueLayer Payments v3 sandbox pay-in and returns an `authorizationUri`; the wallet is credited only after the payment status is confirmed as executed or settled.
- `POST /api/banking/deposits/refresh` checks pending TrueLayer sandbox deposits and credits executed/settled payments.
- `POST /api/banking/payouts` reserves wallet funds, then in sandbox mode attempts a closed-loop TrueLayer payout to the payment source from the latest successful deposit.

The app never treats external bank transactions as spendable betting balance. They are read-only provider data used for display and amount suggestions. The wallet is still the only balance that bets can spend.

Provider modes:

- `TRUELAYER_MODE=sandbox`: account and transaction data comes from TrueLayer Data API sandbox when your Console app has Data API access. If TrueLayer returns `invalid_scope` for Data API, the app falls back to local sandbox sample transactions while Payments still use TrueLayer. Deposits use signed TrueLayer Payments v3 sandbox pay-ins through the hosted payment page. Payouts use closed-loop sandbox payouts after a successful deposit has created a payment source.
- `TRUELAYER_MODE=live`: intentionally blocked with 503.

To try TrueLayer sandbox, create a sandbox app in TrueLayer Console. Register these redirect URIs:

```text
http://localhost:3000/api/banking/truelayer/callback
http://localhost:3000/api/banking/truelayer/payment-callback
```

The payment callback must be registered exactly as shown. Do not add query parameters such as `?bankingPaymentId=...` in the TrueLayer Console redirect URI.

Then paste your values into the root `.env` file:

```env
TRUELAYER_MODE=sandbox
TRUELAYER_CLIENT_ID=your-sandbox-client-id
TRUELAYER_CLIENT_SECRET=your-sandbox-client-secret
TRUELAYER_MERCHANT_ACCOUNT_ID=your-sandbox-merchant-account-id
TRUELAYER_CERTIFICATE_ID=your-signing-key-kid-from-console
TRUELAYER_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\nPASTE_YOUR_PRIVATE_KEY_HERE\n-----END EC PRIVATE KEY-----"
TRUELAYER_DATA_PROVIDER_ID=uk-cs-mock
TRUELAYER_PAYMENT_PROVIDER_ID=mock-payments-gb-redirect
TRUELAYER_CREDIT_DEPOSITS_ON=executed
```

For the signing key, generate an ES512-compatible EC key pair locally, upload the public key in TrueLayer Console, and paste only the private key into `.env`:

```bash
openssl ecparam -name secp521r1 -genkey -noout -out truelayer-private-key.pem
openssl ec -in truelayer-private-key.pem -pubout -out truelayer-public-key.pem
```

`TRUELAYER_PRIVATE_KEY` is the contents of `truelayer-private-key.pem`, with newlines written as `\n` if you keep it on one `.env` line. `TRUELAYER_CERTIFICATE_ID` is the key id/kid shown by TrueLayer for the uploaded public key.

Then restart Docker:

```bash
docker compose up --build
```

The private key must stay local. Do not paste it into chat, commit it, or put it in `.env.example`. The `\n` characters are intentional: they let a multi-line PEM key live on one `.env` line.

Current sandbox behaviour:

- Connect bank: redirects through TrueLayer's Data API sandbox connection flow when Data API is enabled. If your app credentials only have Payments scope, it uses a local sandbox transaction feed instead of failing with `invalid_scope`.
- Deposit: creates a signed `/v3/payments` request, sends the user to TrueLayer's hosted payment page, then checks `/v3/payments/{id}` after redirect or when `Refresh payments` is clicked.
- Wallet credit: happens only when the provider result maps to `SUCCEEDED`. The app treats TrueLayer `executed` and `settled` deposits as creditable for sandbox learning. Set `TRUELAYER_CREDIT_DEPOSITS_ON=authorized` only if you deliberately want even earlier crediting during experiments.
- Payout: uses a signed `/v3/payouts` closed-loop request when a previous successful deposit has a `payment_source_id`. It still needs webhooks/reconciliation before you would rely on it outside a learning sandbox.

In Prisma Studio:

- `BankConnection` is a user's consent/connection to the TrueLayer sandbox provider. `authorization_required` means the user has not finished TrueLayer's hosted flow yet.
- `ExternalBankAccount` is a bank account returned by the provider.
- `ExternalBankTransaction` is a cached transaction from that bank account.
- `BankingPayment` is an app-side deposit/pay-in record. `pending` means the user has not completed or settled the TrueLayer payment yet, `succeeded` means the wallet has been credited, and `failed` means it should not credit the wallet.
- `BankingPayout` is an app-side payout/withdrawal record.
- `WalletTransaction.referenceType` tells you what caused the wallet movement, for example `BANKING_PAYMENT`, `BANKING_PAYOUT`, or `BET`.
- `WalletTransaction.referenceId` points to the row id in that referenced table.

`TRUELAYER_MODE=live` currently returns a 503 on purpose. To make it real, implement `LiveTrueLayerProvider` with production TrueLayer base URLs, request signing/idempotency, hosted payment/auth redirects, webhooks, reconciliation, and failure/refund handling.

## Server-Side Betting

`POST /api/bets/coin-flip` accepts a positive integer stake, `heads`/`tails`, and an optional client seed. `POST /api/bets/roulette` accepts a positive integer stake, a `number` or `colour` bet type, a validated selection, and an optional client seed. Both endpoints use the same server-side settlement pipeline. The API:

1. Authenticates the session and checks account/exclusion state.
2. Opens a serializable PostgreSQL transaction and locks the player's wallet row with `FOR UPDATE`.
3. Rechecks the balance, creates a pending bet/round, and records the stake ledger entry.
4. Generates a 256-bit server seed with Node `crypto.randomBytes`, commits its SHA-256 hash, and derives the result with HMAC-SHA-256 plus nonce/client seed.
5. Calculates the payout, updates the wallet, writes payout/audit records, and settles the bet in the same transaction.
6. Returns the public result and the now-safe seed disclosure for verification.

The lock prevents two concurrent wagers from observing and spending the same balance. Serializable-conflict retries are bounded. Database constraints also reject negative wallet balances and invalid stake/payout values.

The frontend never generates randomness, determines wins, calculates payouts, or updates a balance directly. Moving any of those responsibilities to the browser would let a player tamper with the outcome or accounting. Server seeds are stored plainly only to demonstrate the protocol; production should encrypt/externalize them under managed keys, define rotation/reveal policy, and have the design independently reviewed.

## Native Verification

With Node 20+ and PostgreSQL available:

```bash
npm install
npm run prisma:generate
npm run test
npm run build
npm run lint
npm run prisma:validate -w @gamba/backend
docker compose config
```
