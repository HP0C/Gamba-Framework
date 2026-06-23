# Gamba Server Skeleton

A TypeScript monorepo for a local, demo-credit betting application. It contains a NestJS API, PostgreSQL/Prisma 6 persistence, a deliberately thin React/Vite client, Docker Compose, and optional Prisma Studio.

New to backend development? Read the detailed [Backend and Prisma Studio Guide](docs/BACKEND_GUIDE.md) for endpoint examples, request flows, architecture explanations, and a field-by-field database reference.

> **Not approved for real-money use.** A real gambling product requires qualified legal advice and applicable licensing, jurisdiction controls, age verification, KYC, AML/sanctions controls, responsible-gambling and self-exclusion systems, affordability/limit policy, payment security, fraud monitoring, privacy governance, independent game/RNG testing, operational security, and regulator-approved audit/reporting before launch. The fields and comments here are integration placeholders, not compliance.

## Structure

```text
apps/
  backend/
    prisma/                 schema and initial migration
    src/
      auth/                 password, Google OAuth structure, JWT sessions
      users/ wallet/ bets/  controllers, services, managers, modules
      games/ audit/ prisma/ server-owned support modules
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

Open the UI at <http://localhost:5173>; the API is at <http://localhost:3000/api>. The backend waits for PostgreSQL and runs `prisma migrate deploy` before starting. Local Compose defaults issue new password accounts GBP 100.00 of explicitly labeled demo credit through a ledger transaction.

Set non-demo secrets in a root `.env` before sharing any environment:

```env
JWT_ACCESS_SECRET=generate-a-long-random-secret
JWT_REFRESH_SECRET=generate-a-different-long-random-secret
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

The committed Compose fallbacks are localhost-only development values, not deployable secrets.

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

## Server-Side Betting

`POST /api/bets/coin-flip` accepts only a positive integer stake, `heads`/`tails`, and an optional client seed. The API:

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

## Current Limitations

- Demo credits only; no deposits, withdrawals, payments, or cash value.
- Compliance state fields are placeholders and are not enforced as a complete policy.
- Google linking needs production collision/account-takeover review and configured credentials.
- No email verification, password reset, MFA, CSRF tokens, rate limiting, device/risk scoring, observability, or admin tooling.
- Tests cover deterministic fair-game primitives and accounting invariants; a disposable PostgreSQL integration suite should exercise concurrent wagers and full ledger rollback.
- No idempotency key contract yet; clients should not automatically replay bet requests until one is added.

## Before Any Real-Money Launch

Obtain licensing and legal/regulatory sign-off for every jurisdiction; implement verified age/KYC/AML/sanctions and geolocation decisions before wagering; add self-exclusion, limits, safer-gambling intervention and immutable regulator-grade audit retention; integrate certified payments and reconciliation; commission independent RNG/game/math and penetration testing; add idempotency, fraud/risk controls, monitoring, incident response, backups/disaster recovery, privacy retention, and hardened secret/key management. Treat every control as a tested, auditable production system rather than a schema flag.
