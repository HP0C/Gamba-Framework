CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');
CREATE TYPE "VerificationStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED');
CREATE TYPE "AccountProvider" AS ENUM ('LOCAL', 'GOOGLE');
CREATE TYPE "WalletTransactionType" AS ENUM ('INITIAL_CREDIT', 'BET_STAKE', 'BET_PAYOUT', 'ADJUSTMENT', 'DEPOSIT', 'WITHDRAWAL');
CREATE TYPE "BetStatus" AS ENUM ('PENDING', 'SETTLED', 'VOID');
CREATE TYPE "GameType" AS ENUM ('COIN_FLIP');

CREATE TABLE "User" (
  "id" UUID NOT NULL, "email" TEXT NOT NULL, "username" TEXT NOT NULL,
  "passwordHash" TEXT, "googleId" TEXT, "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "ageVerificationStatus" "VerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "kycStatus" "VerificationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "gamblingExcludedUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Account" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "provider" "AccountProvider" NOT NULL,
  "providerAccountId" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Session" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "refreshTokenHash" TEXT NOT NULL,
  "userAgent" TEXT, "ipAddress" TEXT, "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Wallet" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "balance" BIGINT NOT NULL DEFAULT 0,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'GBP', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Wallet_balance_check" CHECK ("balance" >= 0)
);
CREATE TABLE "WalletTransaction" (
  "id" UUID NOT NULL, "walletId" UUID NOT NULL, "type" "WalletTransactionType" NOT NULL,
  "amount" BIGINT NOT NULL, "balanceBefore" BIGINT NOT NULL, "balanceAfter" BIGINT NOT NULL,
  "referenceType" TEXT NOT NULL, "referenceId" TEXT NOT NULL, "idempotencyKey" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "GameRound" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "gameType" "GameType" NOT NULL,
  "serverSeedHash" TEXT NOT NULL, "serverSeed" TEXT NOT NULL, "clientSeed" TEXT,
  "nonce" BIGINT NOT NULL, "publicResult" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3), CONSTRAINT "GameRound_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Bet" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "gameRoundId" UUID NOT NULL,
  "gameType" "GameType" NOT NULL, "stake" BIGINT NOT NULL, "selection" TEXT NOT NULL,
  "result" TEXT, "payout" BIGINT NOT NULL DEFAULT 0, "status" "BetStatus" NOT NULL DEFAULT 'PENDING',
  "rngNonce" BIGINT NOT NULL, "serverSeedHash" TEXT NOT NULL, "clientSeed" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "settledAt" TIMESTAMP(3),
  CONSTRAINT "Bet_pkey" PRIMARY KEY ("id"), CONSTRAINT "Bet_stake_check" CHECK ("stake" > 0),
  CONSTRAINT "Bet_payout_check" CHECK ("payout" >= 0)
);
CREATE TABLE "AuditLog" (
  "id" UUID NOT NULL, "userId" UUID, "action" TEXT NOT NULL, "entityType" TEXT NOT NULL,
  "entityId" TEXT, "metadata" JSONB, "ipAddress" TEXT, "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");
CREATE INDEX "Account_userId_idx" ON "Account"("userId");
CREATE INDEX "Session_userId_revokedAt_idx" ON "Session"("userId", "revokedAt");
CREATE UNIQUE INDEX "Wallet_userId_currency_key" ON "Wallet"("userId", "currency");
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key" ON "WalletTransaction"("idempotencyKey");
CREATE INDEX "WalletTransaction_walletId_createdAt_idx" ON "WalletTransaction"("walletId", "createdAt");
CREATE INDEX "WalletTransaction_referenceType_referenceId_idx" ON "WalletTransaction"("referenceType", "referenceId");
CREATE UNIQUE INDEX "GameRound_userId_gameType_nonce_key" ON "GameRound"("userId", "gameType", "nonce");
CREATE UNIQUE INDEX "Bet_gameRoundId_key" ON "Bet"("gameRoundId");
CREATE INDEX "Bet_userId_createdAt_idx" ON "Bet"("userId", "createdAt");
CREATE INDEX "AuditLog_userId_createdAt_idx" ON "AuditLog"("userId", "createdAt");
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Bet" ADD CONSTRAINT "Bet_gameRoundId_fkey" FOREIGN KEY ("gameRoundId") REFERENCES "GameRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
