# Gamba Server Skeleton

The native Expo client is in `apps/mobile`. See [`apps/mobile/README.md`](apps/mobile/README.md) for phone/emulator setup, TrueLayer deep-link configuration, and a complete testing checklist.

A monorepo for an Open Banking betting application prototype. It contains a NestJS API, PostgreSQL/Prisma 6 persistence, a poopy React/Vite client, Docker Compose, and optional Prisma Studio.

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
docker compose --profile tools up -d --build
docker compose --profile tools down
```

Open the UI at <http://localhost:5173>; the API is at <http://localhost:3000/api>. The backend waits for PostgreSQL and runs `prisma migrate deploy` before starting. Local Compose starts new wallet balances at GBP 0.00 so deposits must come through the banking flow.

Start Prisma Studio at <http://localhost:5555>:

```bash
docker compose --profile tools up studio
```
## Authentication

- `POST /api/auth/register` creates a local user and Argon2id password hash.
- `POST /api/auth/login` verifies password credentials.
- `POST /api/auth/refresh` rotates the refresh session.
- `POST /api/auth/logout` revokes the current session.
- `GET /api/auth/me` returns the current user.
- `GET /api/auth/google` and `/callback` provide the Passport Google OAuth structure and return 503 until credentials are configured.

Access and refresh JWTs use secure, HTTP-only, SameSite=Lax cookies. Refresh tokens are Argon2id-hashed in revocable database sessions. 

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


## Server-Side Betting

`POST /api/bets/coin-flip` accepts a positive integer stake, `heads`/`tails`, and an optional client seed. `POST /api/bets/roulette` accepts a positive integer stake, a `number` or `colour` bet type, a validated selection, and an optional client seed. Both endpoints use the same server-side settlement pipeline. The API:

1. Authenticates the session and checks account/exclusion state.
2. Opens a serializable PostgreSQL transaction and locks the player's wallet row with `FOR UPDATE`.
3. Rechecks the balance, creates a pending bet/round, and records the stake ledger entry.
4. Generates a 256-bit server seed with Node `crypto.randomBytes`, commits its SHA-256 hash, and derives the result with HMAC-SHA-256 plus nonce/client seed.
5. Calculates the payout, updates the wallet, writes payout/audit records, and settles the bet in the same transaction.
6. Returns the public result and the now-safe seed disclosure for verification.


## API Endpoint Reference

All backend routes are prefixed with `/api`. Most app routes use HTTP-only cookies for auth, so browser requests should include credentials. Money values are integer minor units, for example pence, and response money fields are usually strings so large `BIGINT` values do not lose precision in JavaScript.

### Auth

#### `POST /api/auth/register`

Creates a username/password account, creates a wallet, creates a session, and sets `access_token` and `refresh_token` cookies.

Request body:

```json
{
  "email": "player@example.com",
  "username": "player_123",
  "password": "at-least-12-characters"
}
```

Rules:

- `email` must be a valid email.
- `username` must be 3-30 characters and only contain letters, numbers, and underscores.
- `password` must be 12-128 characters.

Response:

```json
{
  "user": {
    "id": "uuid",
    "email": "player@example.com",
    "username": "player_123"
  }
}
```

Common errors:

- `409` if email or username is already registered.
- `400` if validation fails.

#### `POST /api/auth/login`

Logs in with email or username and password. Sets `access_token` and `refresh_token` cookies.

Request body:

```json
{
  "login": "player@example.com",
  "password": "at-least-12-characters"
}
```

Response:

```json
{
  "user": {
    "id": "uuid",
    "email": "player@example.com",
    "username": "player_123"
  }
}
```

Common errors:

- `401` if the credentials are wrong, the account has no password login, or the account is not active.

#### `POST /api/auth/refresh`

Uses the `refresh_token` cookie to rotate the session and issue fresh cookies.

Request body: none.

Response:

```json
{
  "refreshed": true
}
```

Common errors:

- `401` if the refresh cookie is missing, expired, invalid, or already revoked.

#### `POST /api/auth/logout`

Requires login. Revokes the current session and clears auth cookies.

Request body: none.

Response:

```json
{
  "loggedOut": true
}
```

#### `GET /api/auth/me`

Requires login. Returns the current logged-in user.

Response:

```json
{
  "id": "uuid",
  "email": "player@example.com",
  "username": "player_123",
  "createdAt": "2026-06-24T12:00:00.000Z"
}
```

#### `GET /api/auth/google`

Starts Google OAuth. The browser is redirected to Google.

Request body: none.

Response:

- Redirects to Google if `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` are configured.
- Returns `503` if Google OAuth is not configured.

#### `GET /api/auth/google/callback`

Google redirects here after OAuth. The backend creates or links a local user, sets auth cookies, and redirects to `FRONTEND_URL`.

This route is normally called by Google, not manually by the frontend.

### Wallet

#### `GET /api/wallet`

Requires login. Returns the logged-in user's betting wallet balance.

Response:

```json
{
  "balance": "0",
  "currency": "GBP"
}
```

### Banking

#### `GET /api/banking`

Requires login. Returns the user's bank connections, cached current accounts, recent current account transactions, deposit records, and payout records.

Response:

```json
{
  "mode": "sandbox",
  "connections": [
    {
      "id": "uuid",
      "provider": "true_layer",
      "status": "active",
      "consentExpiresAt": "2026-07-24T12:00:00.000Z",
      "authorizationUri": "https://..."
    }
  ],
  "accounts": [
    {
      "id": "uuid",
      "displayName": "Current Account",
      "accountType": "transaction",
      "currency": "GBP",
      "currentBalance": "123450"
    }
  ],
  "transactions": [
    {
      "id": "uuid",
      "bankAccountId": "uuid",
      "amount": "-1000",
      "currency": "GBP",
      "direction": "outbound",
      "description": "Coffee shop",
      "merchantName": "Example Coffee",
      "category": "eating_out",
      "transactionAt": "2026-06-24T12:00:00.000Z"
    }
  ],
  "payments": [
    {
      "id": "uuid",
      "amount": "1000",
      "currency": "GBP",
      "status": "succeeded",
      "providerPaymentId": "truelayer-payment-id",
      "sourceTransactionId": "uuid-or-null",
      "createdAt": "2026-06-24T12:00:00.000Z",
      "settledAt": "2026-06-24T12:01:00.000Z"
    }
  ],
  "payouts": [
    {
      "id": "uuid",
      "amount": "2000",
      "currency": "GBP",
      "status": "pending",
      "providerPayoutId": "truelayer-payout-id",
      "createdAt": "2026-06-24T12:00:00.000Z",
      "settledAt": null
    }
  ]
}
```

#### `POST /api/banking/connect`

Requires login. Starts an Open Banking connection.

Request body: none.

Response when user must authorise with TrueLayer:

```json
{
  "authorizationUri": "https://app.truelayer-sandbox.com/...",
  "connection": {
    "id": "uuid",
    "provider": "true_layer",
    "status": "authorization_required",
    "consentExpiresAt": null,
    "authorizationUri": "https://app.truelayer-sandbox.com/..."
  },
  "overview": {
    "mode": "sandbox",
    "connections": [],
    "accounts": [],
    "transactions": [],
    "payments": [],
    "payouts": []
  }
}
```

Response when the connection can be completed without a hosted redirect:

```json
{
  "overview": {
    "mode": "sandbox",
    "connections": [],
    "accounts": [],
    "transactions": [],
    "payments": [],
    "payouts": []
  }
}
```

#### `GET /api/banking/truelayer/callback`

TrueLayer redirects here after the hosted Open Banking connection flow.

Query parameters may include:

- `connection_id`
- `connectionId`
- `error`

Response:

- Redirects to `FRONTEND_URL?banking=connected` on success.
- Redirects to `FRONTEND_URL?banking=error` on failure.

This route is normally called by TrueLayer, not manually by the frontend.

#### `POST /api/banking/sync`

Requires login. Fetches/caches bank accounts and transactions from the configured provider, then returns the same shape as `GET /api/banking`.

Request body: none.

Response: banking overview object.

#### `POST /api/banking/deposits`

Requires login. Creates a deposit/pay-in from the current account into the betting wallet. In sandbox mode this usually returns a hosted payment URL that the frontend redirects to.

Request body:

```json
{
  "amount": 1000,
  "sourceTransactionId": "optional-uuid"
}
```

Rules:

- `amount` must be a positive integer in pence.
- `sourceTransactionId` is optional. If provided, it must belong to the logged-in user's cached bank transactions.

Response:

```json
{
  "id": "uuid",
  "status": "pending",
  "amount": "1000",
  "currency": "GBP",
  "newBalance": "1000",
  "authorizationUri": "https://app.truelayer-sandbox.com/..."
}
```

Notes:

- `newBalance` is only present when the wallet balance changed immediately.
- `authorizationUri` is present when the user must complete a hosted TrueLayer payment.

#### `GET /api/banking/truelayer/payment-callback`

TrueLayer redirects here after the hosted payment flow.

Query parameters may include:

- `payment_id`
- `paymentId`
- `bankingPaymentId`
- `error`

Response:

- Redirects to `FRONTEND_URL?payment=succeeded`, `pending`, `failed`, or `error`.

This route is normally called by TrueLayer, not manually by the frontend.

#### `POST /api/banking/deposits/refresh`

Requires login. Checks pending TrueLayer deposits and credits the wallet if the provider status has become creditable.

Request body: none.

Response: banking overview object.

#### `POST /api/banking/payouts`

Requires login. Creates a payout/withdrawal from the betting wallet back to the latest valid TrueLayer payment source.

Request body:

```json
{
  "amount": 1000
}
```

Rules:

- `amount` must be a positive integer in pence.
- User must have enough betting wallet balance.
- For closed-loop TrueLayer payouts, the user usually needs at least one successful previous deposit with a `paymentSourceId`.

Response:

```json
{
  "id": "uuid",
  "status": "pending",
  "amount": "1000",
  "currency": "GBP",
  "newBalance": "0"
}
```

Common errors:

- `422` if the wallet balance is insufficient.
- `400` or `503` if the TrueLayer payout cannot be created or no valid payment source exists.

### Bets

#### `GET /api/bets`

Requires login. Returns up to 50 recent bets for the current user.

Response:

```json
[
  {
    "id": "uuid",
    "gameType": "coin_flip",
    "stake": "1000",
    "selection": "heads",
    "result": "heads",
    "payout": "2000",
    "status": "settled",
    "serverSeedHash": "sha256-hash",
    "rngNonce": "1",
    "createdAt": "2026-06-24T12:00:00.000Z",
    "settledAt": "2026-06-24T12:00:00.000Z"
  }
]
```

#### `POST /api/bets/coin-flip`

Requires login. Places and settles a coin flip bet server-side.

Request body:

```json
{
  "stake": 1000,
  "selection": "heads",
  "clientSeed": "optional-client-seed"
}
```

Rules:

- `stake` must be a positive integer in pence and at most `1000000000`.
- `selection` must be `heads` or `tails`.
- `clientSeed` is optional and max 128 characters.
- The user must have enough betting wallet balance.

Response:

```json
{
  "id": "uuid",
  "gameType": "coin_flip",
  "selection": "heads",
  "result": "tails",
  "stake": "1000",
  "payout": "0",
  "newBalance": "0",
  "serverSeedHash": "sha256-hash",
  "serverSeed": "revealed-server-seed",
  "rngNonce": "1",
  "settledAt": "2026-06-24T12:00:00.000Z"
}
```

#### `POST /api/bets/roulette`

Requires login. Places and settles a roulette bet server-side.

Request body for a colour bet:

```json
{
  "stake": 1000,
  "betType": "colour",
  "selection": "red",
  "clientSeed": "optional-client-seed"
}
```

Request body for a number bet:

```json
{
  "stake": 1000,
  "betType": "number",
  "selection": "17",
  "clientSeed": "optional-client-seed"
}
```

Rules:

- `stake` must be a positive integer in pence and at most `1000000000`.
- `betType` must be `colour` or `number`.
- For `colour`, `selection` must be `red`, `black`, or `green`.
- For `number`, `selection` must be a string containing an integer from `0` to `36`.
- `clientSeed` is optional and max 128 characters.
- The user must have enough betting wallet balance.

Response:

```json
{
  "id": "uuid",
  "gameType": "roulette",
  "selection": "colour:red",
  "result": "red:23",
  "stake": "1000",
  "payout": "2000",
  "newBalance": "2000",
  "serverSeedHash": "sha256-hash",
  "serverSeed": "revealed-server-seed",
  "rngNonce": "2",
  "settledAt": "2026-06-24T12:00:00.000Z"
}
```

Common errors:

- `400` if validation fails.
- `401` if not logged in.
- `422` if the wallet balance is insufficient.
