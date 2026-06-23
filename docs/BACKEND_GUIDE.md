# Backend Guide for First-Time Server Developers

This document explains how this project's backend works, how the frontend talks to it, what the data in Prisma Studio means, and how to extend it safely.

The examples describe the code as it exists today. This is a demo-credit application, not a production-ready real-money gambling platform. The compliance-related database fields are placeholders for future systems and do not provide legal or regulatory compliance by themselves.

## 1. The Big Picture

This application has three main parts:

```text
Browser / React frontend
        |
        | HTTP requests and JSON responses
        v
NestJS backend API
        |
        | Prisma queries and transactions
        v
PostgreSQL database
```

The responsibilities are deliberately separated:

- The **frontend** displays forms and data. It asks the backend to perform actions.
- The **backend** authenticates users, validates requests, applies business rules, resolves bets, and decides what data may be returned.
- **PostgreSQL** permanently stores users, sessions, wallets, ledger entries, bets, rounds, and audit records.
- **Prisma** is the TypeScript library the backend uses to read and write PostgreSQL.
- **Prisma Studio** is a development-only visual database viewer. It is not the application backend and should not be exposed publicly.

When the frontend places a bet, it does not edit a wallet or choose a result. It sends this request:

```json
{
  "stake": 100,
  "selection": "heads",
  "clientSeed": "optional-player-value"
}
```

The backend performs the complete operation and returns the settled public result:

```json
{
  "id": "b6b86a74-...",
  "gameType": "coin_flip",
  "selection": "heads",
  "result": "tails",
  "stake": "100",
  "payout": "0",
  "newBalance": "9900",
  "serverSeedHash": "64-character-sha256-hash",
  "serverSeed": "revealed-only-after-settlement",
  "rngNonce": "1",
  "settledAt": "2026-06-22T15:00:00.000Z"
}
```

Notice that money and nonce values are returned as strings. The database uses `BigInt` integer values, and JSON cannot safely represent every possible `BigInt`. Strings prevent rounding or overflow.

## 2. Starting and Stopping the Application

From the repository root, start everything with:

```bash
docker compose up --build
```

The services are:

| Service | Address | Purpose |
| --- | --- | --- |
| Frontend | `http://localhost:5173` | React user interface |
| Backend | `http://localhost:3000/api` | NestJS HTTP API |
| PostgreSQL | `localhost:5432` | Database, normally accessed by the backend |
| Prisma Studio | `http://localhost:5555` | Optional local database viewer |

Run in the background with:

```bash
docker compose up --build -d
```

Check service state:

```bash
docker compose ps
```

Watch backend logs:

```bash
docker compose logs -f backend
```

Stop the application while preserving database data:

```bash
docker compose down
```

`docker compose down -v` also deletes the PostgreSQL volume. That permanently removes local users, wallets, and bets. Use it only when you intentionally want a fresh database.

### Opening Prisma Studio

Start the optional Studio service:

```bash
docker compose --profile tools up studio
```

Then open `http://localhost:5555`.

Studio is a powerful editor, not only a viewer. An accidental balance or foreign-key edit can make test data inconsistent. Prefer viewing and filtering. Use application endpoints, migrations, or controlled scripts for writes.

## 3. HTTP Basics

The browser and backend communicate with HTTP.

An HTTP request contains:

- A **method**, such as `GET` or `POST`.
- A **path**, such as `/api/wallet`.
- Headers, such as `Content-Type: application/json`.
- Optional cookies, including the authentication tokens.
- An optional JSON body.

An HTTP response contains:

- A status code.
- Headers, including `Set-Cookie` during login.
- Usually a JSON body.

Common status codes in this backend:

| Code | Meaning | Typical example |
| --- | --- | --- |
| `200` | Request succeeded | Wallet returned |
| `201` | Resource/action created | Nest may use this for successful `POST` requests |
| `400` | Request validation failed | Stake is `0` or selection is invalid |
| `401` | Not authenticated | Access cookie is missing or expired |
| `403` | Authenticated but forbidden | Account is suspended or self-excluded |
| `404` | Resource does not exist | Wallet was not found |
| `409` | Data conflicts with an existing record | Duplicate email or username |
| `422` | Valid request, but business rule failed | Insufficient wallet balance |
| `503` | Feature is unavailable | Google OAuth is not configured |

`GET` normally reads data. `POST` normally creates a resource or performs an action. A `POST` is used for a bet because placing a bet changes several database records.

## 4. How the Frontend Calls the Backend

The reusable browser helper is in `apps/frontend/src/api.ts`:

```ts
const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api';

const response = await fetch(`${API_URL}${path}`, {
  ...options,
  credentials: 'include',
  headers: { 'Content-Type': 'application/json', ...options.headers },
});
```

Important parts:

- `API_URL` points to the NestJS API.
- `Content-Type: application/json` tells Nest that the body is JSON.
- `credentials: 'include'` tells the browser to include authentication cookies. Without it, protected calls can return `401` even after login.
- `await` pauses this function until the network request finishes.
- `fetch` does not throw for normal HTTP errors such as `400`; the helper explicitly checks `response.ok`.

The frontend places a bet like this:

```ts
const result = await api.post<BetResult>('/bets/coin-flip', {
  stake: Number(data.get('stake')),
  selection: data.get('selection'),
  clientSeed: data.get('clientSeed') || undefined,
});
```

`api.post` converts the object to JSON. The generic `<BetResult>` tells TypeScript what response shape the frontend expects. It does not validate the actual server response at runtime.

The browser must not do this:

```ts
// Never put outcome or accounting decisions in the frontend.
const result = Math.random() > 0.5 ? 'heads' : 'tails';
const payout = result === selection ? stake * 2 : 0;
```

Users control their own browsers. They can change JavaScript, intercept requests, or call the API without the React UI. The backend must assume every request is untrusted.

## 5. Backend Folder Architecture

Each feature uses several file types:

```text
feature/
  feature.controller.ts
  feature.service.ts
  feature.manager.ts
  feature.module.ts
  dto/
```

### Controller

A controller defines HTTP routes and translates HTTP input into a service call.

```ts
@Controller('bets')
@UseGuards(JwtAuthGuard)
export class BetsController {
  constructor(private readonly bets: BetsService) {}

  @Post('coin-flip')
  coinFlip(@RequestUser() user: AuthenticatedUser, @Body() dto: PlaceCoinFlipDto) {
    return this.bets.placeCoinFlip(user.userId, dto);
  }
}
```

This means:

- `@Controller('bets')` sets the route prefix to `/bets`.
- The global `/api` prefix makes the final prefix `/api/bets`.
- `@Post('coin-flip')` creates `POST /api/bets/coin-flip`.
- `@UseGuards(JwtAuthGuard)` requires authentication.
- `@RequestUser()` reads the authenticated identity attached by Passport.
- `@Body()` reads the validated JSON body.
- The controller does not calculate the result or query the wallet.

### DTO

DTO means **Data Transfer Object**. A DTO describes and validates request data.

```ts
export class PlaceCoinFlipDto {
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  stake!: number;

  @IsString()
  @IsIn(['heads', 'tails'])
  selection!: 'heads' | 'tails';

  @IsOptional()
  @IsString()
  @MaxLength(128)
  clientSeed?: string;
}
```

The global `ValidationPipe` in `main.ts` applies these rules. It also uses:

```ts
new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
```

- `whitelist` allows only declared DTO properties.
- `forbidNonWhitelisted` rejects unexpected properties instead of silently trusting them.
- `transform` allows Nest to transform request values where supported.

DTO validation is only the first layer. A positive integer stake may still be rejected by the business layer if the wallet has insufficient funds.

### Service

A service coordinates a use case and shapes public output. For example, `BetsService` sends placement to the manager and handles history formatting.

```ts
placeCoinFlip(userId: string, dto: PlaceCoinFlipDto) {
  return this.manager.placeCoinFlip(userId, dto);
}
```

Services are useful when one use case needs several managers or needs to transform internal data into an API-safe response.

### Manager

A manager contains lower-level business and database orchestration. `BetsManager` owns the critical wallet lock, random round creation, ledger entries, settlement, and transaction retry.

Managers are where you should look when asking, "What actually happens to the database?"

### Module

A module tells Nest which classes belong together and which dependencies are available.

```ts
@Module({
  imports: [AuthModule],
  controllers: [BetsController],
  providers: [BetsManager, BetsService],
})
export class BetsModule {}
```

Nest creates and injects these classes. For example, the controller constructor asks for `BetsService`, and Nest supplies it.

### Guard

A guard runs before the controller. `JwtAuthGuard` rejects protected requests without a valid access token.

### Decorator

Nest decorators are the `@Something(...)` annotations. They add metadata or extract values. The custom `@RequestUser()` decorator retrieves `request.user` after authentication.

## 6. Complete Endpoint Reference

All paths below start with `http://localhost:3000/api`.

### Register

`POST /auth/register`

Request:

```json
{
  "email": "player@example.com",
  "username": "player_one",
  "password": "a-long-password-at-least-12-characters"
}
```

Rules:

- Email must be valid and at most 254 characters.
- Username must be 3-30 letters, numbers, or underscores.
- Password must be 12-128 characters.
- Email and username must be unique.

Response:

```json
{
  "user": {
    "id": "uuid",
    "email": "player@example.com",
    "username": "player_one"
  }
}
```

The response also sets `access_token` and `refresh_token` HTTP-only cookies. The plain password is never stored. The backend stores an Argon2id password hash.

Local registration also creates:

- One `Account` with provider `LOCAL`.
- One GBP `Wallet`.
- An `INITIAL_CREDIT` ledger entry when `DEFAULT_WALLET_BALANCE` is greater than zero.
- One `Session`.
- One `AUTH_REGISTER` audit record.

### Login

`POST /auth/login`

```json
{
  "login": "player_one",
  "password": "a-long-password-at-least-12-characters"
}
```

`login` may be a username or email. A successful response sets fresh cookies and creates a new database session.

### Current User

`GET /auth/me`

Authentication required. Response:

```json
{
  "id": "uuid",
  "email": "player@example.com",
  "username": "player_one",
  "createdAt": "2026-06-22T15:00:00.000Z"
}
```

### Refresh Session

`POST /auth/refresh`

The browser sends the refresh cookie. The backend verifies its JWT signature, finds the corresponding `Session`, verifies its Argon2id hash, revokes the old session, creates a new session, and replaces both cookies.

```json
{
  "refreshed": true
}
```

The frontend helper automatically tries this once when an ordinary API call returns `401`.

### Logout

`POST /auth/logout`

Authentication required. It sets `Session.revokedAt` and clears both cookies.

```json
{
  "loggedOut": true
}
```

### Google OAuth

- `GET /auth/google`
- `GET /auth/google/callback`

These routes contain the OAuth structure. Without configured Google credentials, they return `503`. OAuth requires correct Google Console credentials and redirect URI configuration.

### Wallet

`GET /wallet`

Authentication required.

```json
{
  "balance": "10100",
  "currency": "GBP"
}
```

`10100` minor GBP units means GBP 101.00. It is a string for integer safety.

### Place a Coin Flip

`POST /bets/coin-flip`

Authentication required.

```json
{
  "stake": 100,
  "selection": "heads",
  "clientSeed": "my-optional-seed"
}
```

`stake: 100` means GBP 1.00 in this demo. The request cannot specify `result`, `payout`, or `newBalance`. Extra DTO fields are rejected.

### Bet History

`GET /bets`

Authentication required. It returns the newest 50 bets for the current user:

```json
[
  {
    "id": "uuid",
    "gameType": "coin_flip",
    "stake": "100",
    "selection": "heads",
    "result": "tails",
    "payout": "0",
    "status": "settled",
    "serverSeedHash": "...",
    "rngNonce": "1",
    "createdAt": "...",
    "settledAt": "..."
  }
]
```

History does not currently return the revealed server seed. The placement response does. A mature provably-fair API would normally provide a deliberate round-verification endpoint or reveal history.

## 7. Calling the API Without React

You can test with a browser tool such as Postman or Insomnia. Enable its cookie jar so cookies from login are sent on later calls.

You can also use `curl` with a cookie file:

```bash
curl -i -c cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"email":"new@example.com","username":"new_player","password":"long-demo-password"}' \
  http://localhost:3000/api/auth/register
```

Read the wallet with the saved cookies:

```bash
curl -b cookies.txt http://localhost:3000/api/wallet
```

Place a bet:

```bash
curl -b cookies.txt \
  -H "Content-Type: application/json" \
  -d '{"stake":100,"selection":"heads","clientSeed":"demo"}' \
  http://localhost:3000/api/bets/coin-flip
```

Do not commit `cookies.txt`. It contains local authentication tokens.

## 8. Authentication in Detail

### Password Hashing

During registration:

```ts
const passwordHash = await argon2.hash(password, {
  type: argon2.argon2id,
});
```

Hashing is one-way. Login hashes are verified with `argon2.verify`; the server does not decrypt a password. Prisma Studio shows `passwordHash`, never the original password.

### Access and Refresh Tokens

An access token is short lived and authenticates ordinary API calls. A refresh token lasts longer and creates a replacement session.

The signed payload contains:

```ts
{
  sub: userId,
  sid: sessionId,
  type: 'access' // or 'refresh'
}
```

- `sub` means JWT subject and identifies the user.
- `sid` identifies the database session.
- `type` prevents a refresh token from being accepted as an access token or vice versa.

The browser receives cookies configured with:

```ts
{
  httpOnly: true,
  secure: NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/'
}
```

- `httpOnly` prevents ordinary frontend JavaScript from reading the cookie.
- `secure` requires HTTPS in production.
- `sameSite: 'lax'` reduces some cross-site request risks.
- `path: '/'` sends it to all API paths on this host.

The database stores a hash of the refresh token, not the token itself. If the database is exposed, the stored hash cannot simply be copied into a browser as a valid token.

### Authentication Request Flow

```text
Request with access_token cookie
  -> cookie-parser reads the Cookie header
  -> JwtStrategy extracts access_token
  -> Passport verifies signature and expiry
  -> validate() returns { userId, sessionId }
  -> Passport assigns that object to request.user
  -> JwtAuthGuard allows the controller
  -> @RequestUser() returns request.user
```

The frontend never sends a `userId` when placing a bet. The backend gets it from the signed token. Accepting a user-supplied `userId` would let one player attempt to act as another.

## 9. Registration Flow From End to End

This flow is useful for understanding the architecture:

```text
React registration form
  -> POST /api/auth/register
  -> AuthController.register()
  -> RegisterDto validation
  -> AuthService.register()
  -> AuthManager hashes password
  -> UsersManager transaction creates User, Account, Wallet, ledger entry
  -> AuthManager creates Session and JWT cookies
  -> AuditService records AUTH_REGISTER
  -> controller returns public user fields
```

The user, wallet, and initial ledger entry are created in one Prisma transaction:

```ts
return prisma.$transaction(async (tx) => {
  const user = await tx.user.create(...);
  const wallet = await tx.wallet.create(...);
  await tx.walletTransaction.create(...);
  return user;
});
```

If one query fails, PostgreSQL rolls the whole transaction back. You should not end up with a user but no wallet.

## 10. Bet Flow and Race-Condition Protection

Two requests can reach the server at nearly the same time. Imagine a wallet has `100` and two requests each stake `100`:

```text
Unsafe implementation:
Request A reads balance 100
Request B reads balance 100
Request A subtracts 100
Request B subtracts 100
Both incorrectly believe the money was available
```

This backend locks the wallet row inside a serializable transaction:

```sql
SELECT "id"
FROM "Wallet"
WHERE "userId" = $1 AND "currency" = 'GBP'
FOR UPDATE
```

`FOR UPDATE` means another transaction trying to lock that wallet must wait. After request A finishes, request B reads the updated balance and may receive `422 Insufficient balance`.

The complete transaction performs:

1. Lock the GBP wallet row.
2. Load the wallet, user state, and latest nonce.
3. Check account/exclusion state.
4. Check available balance.
5. Create the random round and pending bet.
6. Deduct the stake.
7. Insert the stake ledger entry.
8. Calculate payout on the server.
9. Credit any payout.
10. Insert the payout ledger entry when applicable.
11. Mark the bet and round settled.
12. Insert an audit event.
13. Commit all writes together.

If any step throws an error, PostgreSQL rolls back the complete operation. Prisma error `P2034` can indicate a transaction conflict. The manager retries that conflict up to three times.

## 11. Secure Randomness and the Fairness Fields

`BetsManager` creates a 32-byte cryptographically random server seed:

```ts
const serverSeed = randomBytes(32).toString('hex');
const serverSeedHash = createHash('sha256')
  .update(serverSeed)
  .digest('hex');
```

`randomBytes` comes from Node's cryptographic library. `Math.random()` is not appropriate for gambling results.

The result is derived using HMAC-SHA-256:

```ts
const digest = createHmac('sha256', serverSeed)
  .update(`${clientSeed ?? ''}:${nonce.toString()}`)
  .digest();

const headsOdds = 30;
const value = digest.readUInt32BE(0);
const bucket = value % 100;

const result = bucket < headsOdds ? 'heads' : 'tails';
```

With the current setting, `heads` appears about 30% of the time and `tails` about 70% of the time. That is not the same thing as "the player has a 30% chance to win" unless the backend controls the only winning selection. Because this coin-flip endpoint lets the player choose `heads` or `tails`, choosing `tails` currently has the higher hit rate.

Field meanings:

- `serverSeed`: Secret random input generated by the backend. This is revealed in the placement response only after settlement. It must not be sent before settlement.
- `serverSeedHash`: SHA-256 commitment to the seed. A player can later hash the revealed seed and compare it with this value.
- `clientSeed`: Optional player-provided public input. It does not let the player directly choose the result because the server seed remains secret.
- `nonce` / `rngNonce`: Increasing number that keeps rounds distinct for a user and game.
- `publicResult`: The settled result stored on `GameRound`.

The current skeleton stores plaintext server seeds in PostgreSQL for demonstration. A production system needs an independently reviewed reveal scheme and managed encryption or external key storage.

## 12. Prisma Terminology

The schema is `apps/backend/prisma/schema.prisma`.

### Model and Table

A Prisma `model` normally maps to a PostgreSQL table:

```prisma
model Wallet {
  id       String @id @default(uuid()) @db.Uuid
  balance  BigInt @default(0)
}
```

In Studio, selecting `Wallet` displays its table records.

### Record / Row

A record is one object in Prisma and one row in PostgreSQL. One `User` row represents one user.

### Field / Column

A scalar field such as `email`, `balance`, or `createdAt` maps to a database column. Relation fields such as `user` or `transactions` are Prisma navigation properties and may not be standalone columns.

### Primary Key

`@id` marks the unique primary identifier. Most IDs are UUID strings such as:

```text
32b43e39-8fe1-4e56-a438-02897a02c967
```

Never treat an ID as a display name. It is an internal stable identifier.

### Foreign Key

A foreign key connects tables. For example, `Wallet.userId` contains the ID of a `User`:

```prisma
userId String @db.Uuid
user   User   @relation(fields: [userId], references: [id])
```

In Studio, `userId` is the stored UUID. `user` is the relation you can navigate.

### Unique Constraint

`@unique` means no two rows may contain the same non-null value. User email and username are unique.

```prisma
email String @unique
```

`@@unique([userId, currency])` means the combination is unique. A user may have wallets in different currencies, but cannot have two GBP wallets.

### Index

An index speeds up common lookups and ordering:

```prisma
@@index([userId, createdAt])
```

Indexes do not normally change API behavior. They improve database query performance and cost storage/write work.

### Optional Field

A `?` means the value can be `null`:

```prisma
passwordHash String?
settledAt    DateTime?
```

A Google-only account can have no password hash. A pending bet can have no settlement time.

### Default Value

`@default(...)` supplies a value when a record is created:

```prisma
createdAt DateTime @default(now())
status    BetStatus @default(PENDING)
```

### Updated Timestamp

`@updatedAt` tells Prisma to update the field when Prisma changes the record:

```prisma
updatedAt DateTime @updatedAt
```

### Enum

An enum restricts a field to named values:

```prisma
enum BetStatus {
  PENDING
  SETTLED
  VOID
}
```

Studio offers these defined choices instead of accepting any string.

### Delete Behavior

Relations declare behavior such as:

- `onDelete: Cascade`: deleting a parent also deletes children. Local accounts and sessions cascade with their user.
- `onDelete: Restrict`: PostgreSQL refuses to delete the parent while financial records reference it.
- `onDelete: SetNull`: deleting the parent preserves the child but clears the reference. Audit logs can remain after a user reference is removed.

Financial records use `Restrict` because silently deleting ledger or bet history would damage traceability.

## 13. Prisma Studio: Every Enum

### `UserStatus`

| Value | Meaning |
| --- | --- |
| `ACTIVE` | Account can authenticate and may wager if other controls permit |
| `SUSPENDED` | Account is temporarily blocked |
| `CLOSED` | Account is considered closed |

### `VerificationStatus`

| Value | Meaning |
| --- | --- |
| `NOT_STARTED` | No verification process has begun |
| `PENDING` | Verification is in progress |
| `VERIFIED` | A future verification provider/policy approved it |
| `REJECTED` | Verification failed or was rejected |

These are placeholders. Changing a Studio field to `VERIFIED` does not perform KYC or age verification.

### `AccountProvider`

| Value | Meaning |
| --- | --- |
| `LOCAL` | Username/email and password account |
| `GOOGLE` | Account identity linked through Google OAuth |

### `WalletTransactionType`

| Value | Meaning today |
| --- | --- |
| `INITIAL_CREDIT` | Demo starting balance created with a local user |
| `BET_STAKE` | Money removed when a bet is placed |
| `BET_PAYOUT` | Money credited when a winning bet settles |
| `ADJUSTMENT` | Reserved for a controlled correction workflow; not implemented |
| `DEPOSIT` | Reserved for a future payment/deposit system; not implemented |
| `WITHDRAWAL` | Reserved for a future withdrawal system; not implemented |

An enum value existing in the schema does not mean its business workflow exists.

### `BetStatus`

| Value | Meaning |
| --- | --- |
| `PENDING` | Bet has been accepted but not settled yet |
| `SETTLED` | Result and payout are final |
| `VOID` | Bet was cancelled/invalidated; no void workflow exists yet |

Coin flips normally move from `PENDING` to `SETTLED` inside one fast database transaction, so Studio may rarely display the pending state.

### `GameType`

| Value | Meaning |
| --- | --- |
| `COIN_FLIP` | Current heads/tails game |

## 14. Prisma Studio: Every Model and Field

### `User`

The main player identity.

| Field | Meaning |
| --- | --- |
| `id` | UUID primary key used by related records |
| `email` | Unique login/contact email, normalized to lowercase during creation |
| `username` | Unique public/login name |
| `passwordHash` | Argon2id hash; null for accounts without a local password |
| `googleId` | Unique Google profile ID when linked; null otherwise |
| `status` | `ACTIVE`, `SUSPENDED`, or `CLOSED` |
| `ageVerificationStatus` | Placeholder age-check state |
| `kycStatus` | Placeholder identity/KYC state |
| `gamblingExcludedUntil` | If this future date exists, betting is blocked until that time |
| `createdAt` | Creation timestamp |
| `updatedAt` | Last Prisma update timestamp |
| `accounts` | Relation to login-provider records |
| `sessions` | Relation to refresh/login sessions |
| `wallets` | Relation to currency wallets |
| `bets` | Relation to the user's bets |
| `gameRounds` | Relation to random game rounds |
| `auditLogs` | Relation to audit events involving this user |

Do not edit `passwordHash` manually. A plain password placed there will not work and would expose sensitive data.

### `Account`

Describes an authentication provider attached to a user. It is separate from `User` so one user can eventually link multiple sign-in methods.

| Field | Meaning |
| --- | --- |
| `id` | Account-record UUID |
| `userId` | Foreign key to `User.id` |
| `provider` | `LOCAL` or `GOOGLE` |
| `providerAccountId` | Provider's identifier: lowercase email for local, Google ID for Google |
| `createdAt` | Provider link creation time |
| `updatedAt` | Last link update time |
| `user` | Navigable relation to the owning user |

The pair `(provider, providerAccountId)` must be unique.

### `Session`

Represents a refreshable login session, often corresponding to one browser/device login.

| Field | Meaning |
| --- | --- |
| `id` | Session UUID; also appears as JWT `sid` |
| `userId` | Owner's `User.id` |
| `refreshTokenHash` | Argon2id hash of the refresh token cookie |
| `userAgent` | Browser/client description supplied by the HTTP request |
| `ipAddress` | Request IP recorded at session creation |
| `expiresAt` | Time after which refresh is rejected |
| `revokedAt` | Null while active; timestamp after logout or rotation |
| `createdAt` | Session creation time |
| `user` | Relation to the user |

An old revoked session is expected after refresh token rotation. It is useful security history, not necessarily an error.

### `Wallet`

Stores the current spendable balance for one user and currency.

| Field | Meaning |
| --- | --- |
| `id` | Wallet UUID |
| `userId` | Owner's `User.id` |
| `balance` | Current integer balance in minor units |
| `currency` | Three-character currency code, currently `GBP` |
| `createdAt` | Wallet creation time |
| `updatedAt` | Last balance/update time |
| `user` | Relation to the owner |
| `transactions` | Relation to the wallet ledger entries |

The wallet is a fast current total. `WalletTransaction` is the explanation/history of how it changed. For a consistent wallet, replaying its transactions in order should agree with its current balance.

Never directly increase `Wallet.balance` in Studio. That creates money with no ledger entry and destroys reconciliation.

### `WalletTransaction`

An append-style ledger entry describing one wallet movement.

| Field | Meaning |
| --- | --- |
| `id` | Ledger-entry UUID |
| `walletId` | Wallet affected by this entry |
| `type` | Business category such as `BET_STAKE` |
| `amount` | Signed change: negative removes funds, positive adds funds |
| `balanceBefore` | Wallet balance immediately before this movement |
| `balanceAfter` | Wallet balance immediately after this movement |
| `referenceType` | Text naming the kind of business object that caused it |
| `referenceId` | ID of the specific business object that caused it |
| `idempotencyKey` | Optional future duplicate-request protection key; currently unused/null |
| `createdAt` | Ledger-entry time |
| `wallet` | Relation to the affected wallet |

The central invariant is:

```text
balanceAfter = balanceBefore + amount
```

#### What `referenceType` and `referenceId` mean

These two fields form a flexible reference:

```text
referenceType = "BET"
referenceId   = the Bet.id that caused the movement
```

or:

```text
referenceType = "USER"
referenceId   = the User.id that received the initial demo credit
```

Current combinations:

| Transaction type | `referenceType` | `referenceId` points to |
| --- | --- | --- |
| `INITIAL_CREDIT` | `USER` | `User.id` |
| `BET_STAKE` | `BET` | `Bet.id` |
| `BET_PAYOUT` | `BET` | The same `Bet.id` as its stake entry |

`referenceType` is a plain string, not a Prisma enum. `referenceId` is not a declared database foreign key because it may refer to different tables depending on the type. PostgreSQL therefore cannot automatically prove that the referenced row exists. Application code must use valid combinations consistently.

The name is `referenceType`, not "referenceType A." A value such as `BET` answers, "What kind of thing caused this ledger entry?" `referenceId` answers, "Which exact bet was it?"

#### Ledger examples

Initial GBP 100.00 demo credit:

```text
type:            INITIAL_CREDIT
amount:          10000
balanceBefore:   0
balanceAfter:    10000
referenceType:   USER
referenceId:     <new user's ID>
```

GBP 1.00 losing bet:

```text
type:            BET_STAKE
amount:          -100
balanceBefore:   10000
balanceAfter:    9900
referenceType:   BET
referenceId:     <bet ID>
```

GBP 1.00 winning bet has two entries:

```text
BET_STAKE:  amount -100, balance 10000 -> 9900
BET_PAYOUT: amount +200, balance 9900  -> 10100
```

The payout is `200`, not profit `100`. The stake was already removed, so subtracting 100 and adding 200 produces a net gain of 100.

#### What `idempotencyKey` is for

Networks can retry requests. An idempotency key would let a client label one intended operation so the server can recognize a duplicate instead of charging twice. The field is unique when present, but no endpoint currently reads or creates it. Do not assume duplicate bet retries are handled yet.

### `Bet`

The business record of a player's wager.

| Field | Meaning |
| --- | --- |
| `id` | Bet UUID, also used by related ledger references |
| `userId` | Player's `User.id` |
| `gameRoundId` | Unique foreign key to the random `GameRound` |
| `gameType` | Currently `COIN_FLIP` |
| `stake` | Positive integer amount risked in minor units |
| `selection` | Player choice, currently `heads` or `tails` |
| `result` | Server result; nullable before settlement |
| `payout` | Total credited payout; zero on a loss |
| `status` | `PENDING`, `SETTLED`, or `VOID` |
| `rngNonce` | Round nonce copied for audit/query convenience |
| `serverSeedHash` | Pre-reveal seed commitment copied onto the bet |
| `clientSeed` | Optional player seed |
| `createdAt` | Bet acceptance/creation time |
| `settledAt` | Settlement time, null while pending |
| `user` | Relation to the player |
| `gameRound` | Relation to the corresponding random round |

`stake`, `result`, and `payout` must be written by the backend flow. Editing only the bet does not update the wallet or ledger.

### `GameRound`

Stores the randomness and fairness material separately from the financial bet.

| Field | Meaning |
| --- | --- |
| `id` | Round UUID |
| `userId` | User whose round this is |
| `gameType` | Current game type |
| `serverSeedHash` | SHA-256 commitment to the secret seed |
| `serverSeed` | Secret seed, stored for this demo and revealed after settlement |
| `clientSeed` | Optional player-supplied seed |
| `nonce` | Increasing per-user/per-game round number |
| `publicResult` | Settled public result, such as `heads` |
| `createdAt` | Round creation time |
| `settledAt` | Round settlement time |
| `user` | Relation to the user |
| `bet` | Optional one-to-one relation to its bet |

Why both `Bet` and `GameRound`? `Bet` is financial/business data. `GameRound` is game-generation data. Keeping them separate allows game/rng logic to evolve without turning the financial record into one large mixed table.

The combination `(userId, gameType, nonce)` is unique, preventing duplicate nonces for one user's game.

### `AuditLog`

Records important actions for investigation and traceability.

| Field | Meaning |
| --- | --- |
| `id` | Audit-event UUID |
| `userId` | Related user when known; may be null |
| `action` | Event name such as `AUTH_REGISTER`, `AUTH_LOGIN`, `BET_SETTLED` |
| `entityType` | Kind of object affected, such as `USER`, `SESSION`, or `BET` |
| `entityId` | Specific object ID when available |
| `metadata` | JSON details specific to the event |
| `ipAddress` | Optional request IP; currently not populated for every event |
| `userAgent` | Optional client description; currently not populated for every event |
| `createdAt` | Event time |
| `user` | Optional relation to `User` |

For `BET_SETTLED`, metadata currently contains string values for game type, stake, payout, seed hash, and nonce.

Audit logs should be append-only in a serious system. The current table is a foundation, not a regulator-grade immutable audit system.

## 15. Reading a Bet in Prisma Studio

To investigate one bet:

1. Open the `Bet` model.
2. Copy its `id`, `userId`, and `gameRoundId`.
3. Open `WalletTransaction` and filter `referenceType` to `BET` and `referenceId` to that bet ID.
4. Expect one `BET_STAKE` entry and, for a win, one `BET_PAYOUT` entry.
5. Open `GameRound` and find the row whose `id` equals `gameRoundId`.
6. Check that `Bet.result` equals `GameRound.publicResult`.
7. Check that `Bet.serverSeedHash` equals `GameRound.serverSeedHash`.
8. Open `AuditLog` and find `entityType = BET`, `entityId = <bet ID>`.

For each ledger entry, verify:

```text
balanceAfter = balanceBefore + amount
```

For consecutive entries in the same wallet, the older entry's `balanceAfter` should equal the next entry's `balanceBefore`.

## 16. Safe and Unsafe Studio Actions

Generally safe in local development:

- View tables and relations.
- Filter records by user or bet ID.
- Copy IDs for debugging.
- Inspect enum/status values.
- Delete the entire Docker volume when you explicitly want a clean demo database.

Risky even in development:

- Editing a wallet balance without a ledger entry.
- Editing a settled result or payout.
- Changing a transaction amount without matching balances.
- Creating a `VERIFIED` compliance status and treating it as a real check.
- Copying password hashes or refresh-token hashes into logs/messages.
- Deleting a row to work around a foreign-key error.
- Revealing an unsettled server seed.

Some unsafe edits will be rejected by database constraints, but constraints cannot detect every semantic inconsistency.

## 17. Prisma Code Examples

Prisma methods are strongly typed from the schema.

Find one user:

```ts
const user = await prisma.user.findUnique({
  where: { id: userId },
});
```

Find a GBP wallet using the composite unique key:

```ts
const wallet = await prisma.wallet.findUnique({
  where: {
    userId_currency: {
      userId,
      currency: 'GBP',
    },
  },
});
```

Get the newest 50 bets:

```ts
const bets = await prisma.bet.findMany({
  where: { userId },
  orderBy: { createdAt: 'desc' },
  take: 50,
});
```

Load related data with `include`:

```ts
const bet = await prisma.bet.findUnique({
  where: { id: betId },
  include: {
    gameRound: true,
    user: {
      select: { id: true, username: true },
    },
  },
});
```

Use `select` to return only necessary fields. Avoid returning raw Prisma user objects from public endpoints because they contain `passwordHash` and internal compliance state.

Create related records in a transaction:

```ts
await prisma.$transaction(async (tx) => {
  const record = await tx.someModel.create({ data: ... });
  await tx.auditLog.create({
    data: {
      action: 'SOMETHING_HAPPENED',
      entityType: 'SOME_MODEL',
      entityId: record.id,
    },
  });
});
```

Do not implement wallet accounting with a standalone read followed by unrelated writes. Use the established lock and transaction approach.

## 18. Adding a New Read Endpoint

Suppose you want `GET /api/bets/:id` for one of the current user's bets.

Manager-level database method:

```ts
findForUser(userId: string, betId: string) {
  return this.prisma.bet.findFirst({
    where: { id: betId, userId },
    include: { gameRound: true },
  });
}
```

Including `userId` is essential. Searching only by `id` could expose another player's bet if they know its UUID.

Service-level use case:

```ts
async getBet(userId: string, betId: string) {
  const bet = await this.manager.findForUser(userId, betId);
  if (!bet) throw new NotFoundException('Bet not found');

  return {
    id: bet.id,
    result: bet.result,
    stake: bet.stake.toString(),
    payout: bet.payout.toString(),
  };
}
```

Controller route:

```ts
@Get(':id')
getBet(
  @RequestUser() user: AuthenticatedUser,
  @Param('id', new ParseUUIDPipe()) betId: string,
) {
  return this.bets.getBet(user.userId, betId);
}
```

Then add tests for:

- Authenticated owner receives the bet.
- Another user receives `404` rather than the data.
- Invalid UUID receives `400`.
- Missing authentication receives `401`.

This snippet is a teaching example, not an endpoint already present in the repository.

## 19. Changing the Database Schema

Do not only edit PostgreSQL or Studio. Change `schema.prisma` and create a migration.

Typical native-development flow with Node 20+:

```bash
npm run prisma:migrate
npm run prisma:generate
```

The underlying command is `prisma migrate dev`. It compares the schema, creates migration SQL, applies it to a development database, and regenerates Prisma Client.

Review generated SQL in:

```text
apps/backend/prisma/migrations/<timestamp_name>/migration.sql
```

Committed environments apply reviewed migrations with:

```bash
npx prisma migrate deploy
```

The backend container already runs `migrate deploy` at startup.

After schema changes:

1. Create and review the migration.
2. Regenerate Prisma Client.
3. Update manager/service code.
4. Add or update DTO validation.
5. Update API response types in the frontend.
6. Add tests.
7. Rebuild Docker images.

Never casually change the meaning of an existing financial field. Prefer additive, reviewed migrations and explicit backfills.

## 20. Adding Another Game

A new game is more than a frontend form. A careful sequence is:

1. Add a new `GameType` enum value and migration.
2. Define request DTO rules.
3. Add the HTTP route in `BetsController`.
4. Add the use-case method in `BetsService`.
5. Implement secure server-side outcome derivation and settlement in `BetsManager`.
6. Define payout rules on the backend.
7. Reuse the wallet lock and serializable transaction.
8. Create round, bet, ledger, and audit records atomically.
9. Return only settled public values.
10. Add deterministic RNG unit tests and accounting tests.
11. Add concurrency/integration tests against PostgreSQL.
12. Add the frontend form last.

Do not copy the coin-flip manager and remove the transaction protection. Extract shared settlement logic only when the behavior and invariants are understood.

## 21. Docker and Environment Variables

Docker Compose creates a private network. Inside that network, the backend connects to hostname `postgres`, not `localhost`:

```env
DATABASE_URL=postgresql://gamba:gamba@postgres:5432/gamba?schema=public
```

From a process running directly on your computer, PostgreSQL is normally `localhost:5432` instead.

Important backend settings:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | Signs short-lived access tokens |
| `JWT_REFRESH_SECRET` | Separately signs refresh tokens |
| `JWT_ACCESS_TTL_SECONDS` | Access-token lifetime |
| `JWT_REFRESH_TTL_SECONDS` | Refresh-token/session lifetime |
| `GOOGLE_CLIENT_ID` | Google OAuth application ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth secret |
| `GOOGLE_CALLBACK_URL` | Google redirect back to this backend |
| `FRONTEND_URL` | Allowed CORS origin and OAuth redirect target |
| `DEFAULT_WALLET_BALANCE` | Local demo starting balance in minor units |
| `PORT` | Backend listening port |
| `NODE_ENV` | Controls production cookie security behavior |

Do not commit real secrets. The Compose defaults are only for localhost development.

## 22. CORS

The frontend and backend use different ports, so browsers consider them different origins. The backend allows the configured frontend origin:

```ts
app.enableCors({
  origin: config.getOrThrow<string>('FRONTEND_URL'),
  credentials: true,
});
```

Both sides are required for cookie authentication:

- Backend: `credentials: true` in CORS.
- Frontend: `credentials: 'include'` in `fetch`.

Do not replace the configured origin with unrestricted `*` while using credentialed requests.

## 23. Debugging Checklist

### Frontend cannot reach backend

```bash
docker compose ps
docker compose logs --tail 100 backend
```

Confirm the backend is on port 3000 and `VITE_API_URL` includes `/api`.

### Every protected request returns `401`

- Confirm login succeeded.
- Confirm browser cookies include `access_token` and `refresh_token` for localhost.
- Confirm frontend requests use `credentials: 'include'`.
- Check JWT secrets did not change while old cookies remained.
- Clear localhost cookies and log in again.
- Check token/session expiry settings.

### Registration returns `400`

Read the JSON `message`. Common causes are password shorter than 12 characters, invalid username characters, or an unexpected property.

### Registration returns `409`

Email or username already exists. Find the user in Studio or use another value.

### Bet returns `422`

The wallet balance is lower than the stake. Inspect `Wallet` and its ordered `WalletTransaction` records.

### Bet returns `403`

Check `User.status` and `gamblingExcludedUntil`. Verification statuses are not fully enforced in this demo.

### Prisma types appear wrong after schema changes

```bash
npm run prisma:generate
```

Restart the TypeScript process/editor if it still holds old generated types.

### Database appears empty after restart

Check whether the Compose volume was deleted. Normal `docker compose down` preserves it; `docker compose down -v` removes it.

## 24. Testing and Verification

Run through Docker for the supported Node version, or install Node 20+ locally.

```bash
npm run prisma:generate
npm run test
npm run build
npm run lint
npm run prisma:validate -w @gamba/backend
docker compose config
```

Current tests cover fairness determinism and a manager-level insufficient-funds invariant. Important future integration tests include:

- Two simultaneous bets competing for one small balance.
- Rollback after an error midway through settlement.
- Refresh-token rotation and reuse rejection.
- Self-excluded/suspended account rejection.
- Ledger reconciliation over many wins and losses.
- Database constraints for negative balances and invalid bets.

## 25. Security and Compliance Boundaries

The following are only placeholders or incomplete foundations:

- Age verification
- KYC and identity verification
- AML and sanctions screening
- Jurisdiction and geolocation rules
- Deposit, withdrawal, and payment processing
- Responsible-gambling limits and intervention
- Self-exclusion synchronization
- Affordability policy
- Fraud/device/risk monitoring
- Regulator-grade immutable auditing
- Certified game math and RNG review

Do not implement one of these by manually changing a Studio status. Real controls require external providers, policy decisions, error handling, evidence, retention, review, and legal/regulatory approval.

## 26. Glossary

| Term | Plain-English meaning |
| --- | --- |
| API | Defined way for one program to request actions/data from another |
| Backend | Trusted server code that applies rules and accesses the database |
| Frontend | Browser interface the user sees and can modify |
| Endpoint | One HTTP method and path, such as `POST /api/auth/login` |
| DTO | Class describing and validating request data |
| Controller | Nest class that defines HTTP endpoints |
| Service | Class coordinating a use case and public output |
| Manager | Class performing lower-level business/database orchestration |
| Module | Nest registration and dependency boundary |
| Guard | Code that allows or rejects a request before the controller |
| ORM | Library mapping code objects to relational database records |
| Prisma | ORM/client used by this backend |
| PostgreSQL | Relational database storing permanent application data |
| Migration | Versioned SQL change to database structure |
| Transaction | Group of database operations that all commit or all roll back |
| Row lock | Database protection that makes competing writes wait |
| Ledger | Ordered history explaining every balance movement |
| Foreign key | Stored ID connecting one table to another |
| UUID | Random-looking unique identifier used for records |
| Enum | Field restricted to a fixed list of named values |
| JWT | Signed token containing authentication claims |
| Cookie | Browser-managed value sent with matching HTTP requests |
| Hash | One-way derived value used for passwords or commitments |
| HMAC | Keyed cryptographic hash used here to derive game results |
| Nonce | Number used once per user/game round to distinguish inputs |
| Minor units | Integer currency units, such as pence instead of decimal pounds |
| Reconciliation | Proving current balances match the transaction history |
| Idempotency | Repeating one intended request without performing it twice |

## 27. Recommended Learning Path

Use this order when exploring the code:

1. Open `apps/frontend/src/api.ts` to see how HTTP requests are sent.
2. Open `apps/backend/src/main.ts` to see global API setup.
3. Read one controller, starting with `wallet.controller.ts`.
4. Follow it into `WalletService` and `WalletManager`.
5. Read the wallet models in `schema.prisma` and inspect matching Studio rows.
6. Follow registration through controller, service, manager, and Studio records.
7. Follow one live bet through `BetsManager` and inspect all related records using its bet ID.
8. Read the transaction and row-lock sections again after seeing the records.
9. Add a small protected read endpoint with tests.
10. Only then attempt new balance-changing behavior.

The most important habit is to trace one request across every layer. Ask these questions each time:

- What untrusted data came from the browser?
- Where is it validated?
- How is the authenticated user identified?
- Which business rule decides whether the action is allowed?
- Which database rows change?
- Must those changes be atomic?
- What can safely be returned to the browser?
- What test proves the critical behavior?

Those questions are the foundation of building backend applications safely.
