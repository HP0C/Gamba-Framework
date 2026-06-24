CREATE TYPE "BankingProvider" AS ENUM ('TRUE_LAYER');
CREATE TYPE "BankingConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED', 'ERROR');
CREATE TYPE "BankingPaymentStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ExternalTransactionDirection" AS ENUM ('INBOUND', 'OUTBOUND');

CREATE TABLE "BankConnection" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "BankingProvider" NOT NULL,
  "providerConnectionId" TEXT NOT NULL,
  "status" "BankingConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "consentExpiresAt" TIMESTAMP(3),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalBankAccount" (
  "id" UUID NOT NULL,
  "connectionId" UUID NOT NULL,
  "providerAccountId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "accountType" TEXT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'GBP',
  "currentBalance" BIGINT NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalBankAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalBankTransaction" (
  "id" UUID NOT NULL,
  "bankAccountId" UUID NOT NULL,
  "providerTransactionId" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'GBP',
  "direction" "ExternalTransactionDirection" NOT NULL,
  "description" TEXT NOT NULL,
  "merchantName" TEXT,
  "category" TEXT,
  "transactionAt" TIMESTAMP(3) NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalBankTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BankingPayment" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "walletId" UUID NOT NULL,
  "sourceTransactionId" UUID,
  "provider" "BankingProvider" NOT NULL,
  "providerPaymentId" TEXT NOT NULL,
  "paymentSourceId" TEXT,
  "amount" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'GBP',
  "status" "BankingPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "BankingPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BankingPayment_amount_check" CHECK ("amount" > 0)
);

CREATE TABLE "BankingPayout" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "walletId" UUID NOT NULL,
  "provider" "BankingProvider" NOT NULL,
  "providerPayoutId" TEXT NOT NULL,
  "amount" BIGINT NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'GBP',
  "status" "BankingPaymentStatus" NOT NULL DEFAULT 'PENDING',
  "idempotencyKey" TEXT NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "BankingPayout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BankingPayout_amount_check" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "BankConnection_provider_providerConnectionId_key" ON "BankConnection"("provider", "providerConnectionId");
CREATE INDEX "BankConnection_userId_idx" ON "BankConnection"("userId");
CREATE UNIQUE INDEX "ExternalBankAccount_connectionId_providerAccountId_key" ON "ExternalBankAccount"("connectionId", "providerAccountId");
CREATE INDEX "ExternalBankAccount_connectionId_idx" ON "ExternalBankAccount"("connectionId");
CREATE UNIQUE INDEX "ExternalBankTransaction_bankAccountId_providerTransactionId_key" ON "ExternalBankTransaction"("bankAccountId", "providerTransactionId");
CREATE INDEX "ExternalBankTransaction_bankAccountId_transactionAt_idx" ON "ExternalBankTransaction"("bankAccountId", "transactionAt");
CREATE UNIQUE INDEX "BankingPayment_idempotencyKey_key" ON "BankingPayment"("idempotencyKey");
CREATE UNIQUE INDEX "BankingPayment_provider_providerPaymentId_key" ON "BankingPayment"("provider", "providerPaymentId");
CREATE INDEX "BankingPayment_userId_createdAt_idx" ON "BankingPayment"("userId", "createdAt");
CREATE UNIQUE INDEX "BankingPayout_idempotencyKey_key" ON "BankingPayout"("idempotencyKey");
CREATE UNIQUE INDEX "BankingPayout_provider_providerPayoutId_key" ON "BankingPayout"("provider", "providerPayoutId");
CREATE INDEX "BankingPayout_userId_createdAt_idx" ON "BankingPayout"("userId", "createdAt");

ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalBankAccount" ADD CONSTRAINT "ExternalBankAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalBankTransaction" ADD CONSTRAINT "ExternalBankTransaction_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "ExternalBankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BankingPayment" ADD CONSTRAINT "BankingPayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankingPayment" ADD CONSTRAINT "BankingPayment_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankingPayment" ADD CONSTRAINT "BankingPayment_sourceTransactionId_fkey" FOREIGN KEY ("sourceTransactionId") REFERENCES "ExternalBankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankingPayout" ADD CONSTRAINT "BankingPayout_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankingPayout" ADD CONSTRAINT "BankingPayout_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
