CREATE TYPE "BankingMandateStatus" AS ENUM (
  'AUTHORIZATION_REQUIRED',
  'AUTHORIZING',
  'AUTHORIZED',
  'REVOKED',
  'FAILED'
);

CREATE TABLE "BankingMandate" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "provider" "BankingProvider" NOT NULL,
  "providerMandateId" TEXT NOT NULL,
  "providerUserId" TEXT,
  "mandateType" TEXT NOT NULL DEFAULT 'sweeping',
  "currency" VARCHAR(3) NOT NULL DEFAULT 'GBP',
  "maximumIndividualAmount" BIGINT NOT NULL,
  "dailyLimit" BIGINT NOT NULL,
  "validFrom" TIMESTAMP(3) NOT NULL,
  "validTo" TIMESTAMP(3) NOT NULL,
  "status" "BankingMandateStatus" NOT NULL DEFAULT 'AUTHORIZATION_REQUIRED',
  "authorizationUri" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "raw" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "authorizedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  CONSTRAINT "BankingMandate_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "BankingPayment" ADD COLUMN "mandateId" UUID;

CREATE UNIQUE INDEX "BankingMandate_provider_providerMandateId_key"
  ON "BankingMandate"("provider", "providerMandateId");

CREATE UNIQUE INDEX "BankingMandate_idempotencyKey_key"
  ON "BankingMandate"("idempotencyKey");

CREATE INDEX "BankingMandate_userId_status_idx"
  ON "BankingMandate"("userId", "status");

CREATE INDEX "BankingPayment_mandateId_idx"
  ON "BankingPayment"("mandateId");

ALTER TABLE "BankingMandate"
  ADD CONSTRAINT "BankingMandate_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "BankingPayment"
  ADD CONSTRAINT "BankingPayment_mandateId_fkey"
  FOREIGN KEY ("mandateId") REFERENCES "BankingMandate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
