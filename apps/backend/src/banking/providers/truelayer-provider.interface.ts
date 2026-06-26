import { BankingConnectionStatus, BankingMandateStatus, BankingPaymentStatus } from '@prisma/client';

export type TrueLayerProviderMode = 'sandbox' | 'live';

export interface CreateProviderConnectionInput {
  userId: string;
  email: string;
  username: string;
}

export interface ProviderConnection {
  providerConnectionId: string;
  status?: BankingConnectionStatus;
  authorizationUri?: string;
  consentExpiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ProviderBankAccount {
  providerAccountId: string;
  displayName: string;
  accountType: string;
  currency: string;
  currentBalance: bigint;
  raw?: Record<string, unknown>;
}

export interface ProviderBankTransaction {
  providerTransactionId: string;
  amount: bigint;
  currency: string;
  direction: 'INBOUND' | 'OUTBOUND';
  description: string;
  merchantName?: string;
  category?: string;
  transactionAt: Date;
  raw?: Record<string, unknown>;
}

export interface ProviderDepositResult {
  providerPaymentId: string;
  paymentSourceId?: string;
  status: BankingPaymentStatus;
  authorizationUri?: string;
  raw?: Record<string, unknown>;
}

export interface ProviderPayoutResult {
  providerPayoutId: string;
  status: BankingPaymentStatus;
  raw?: Record<string, unknown>;
}

export interface ProviderExternalPayoutBeneficiary {
  accountHolderName: string;
  accountIdentifier: Record<string, string>;
}

export interface ProviderMandateResult {
  providerMandateId: string;
  providerUserId?: string;
  status: BankingMandateStatus;
  authorizationUri?: string;
  raw?: Record<string, unknown>;
}

export interface CreateProviderMoneyMovementInput {
  userId: string;
  amount: bigint;
  currency: string;
  idempotencyKey: string;
}

export interface CreateProviderMandateInput {
  userId: string;
  email: string;
  username: string;
  currency: string;
  maximumIndividualAmount: bigint;
  dailyLimit: bigint;
  validFrom: Date;
  validTo: Date;
  idempotencyKey: string;
}

export interface CreateProviderDepositInput extends CreateProviderMoneyMovementInput {
  email: string;
  username: string;
  localPaymentId: string;
  sourceTransactionId?: string;
}

export interface CreateProviderMandatePaymentInput extends CreateProviderMoneyMovementInput {
  providerMandateId: string;
  localPaymentId: string;
  sourceTransactionId?: string;
}

export interface CreateProviderPayoutInput extends CreateProviderMoneyMovementInput {
  paymentSourceId?: string;
  providerUserId?: string;
  externalBeneficiary?: ProviderExternalPayoutBeneficiary;
}

export interface TrueLayerProvider {
  readonly mode: TrueLayerProviderMode;
  createConnection(input: CreateProviderConnectionInput): Promise<ProviderConnection>;
  listAccounts(providerConnectionId: string): Promise<ProviderBankAccount[]>;
  listTransactions(providerConnectionId: string, providerAccountId: string): Promise<ProviderBankTransaction[]>;
  createMandate(input: CreateProviderMandateInput): Promise<ProviderMandateResult>;
  getMandate(providerMandateId: string): Promise<ProviderMandateResult>;
  createMandatePayment(input: CreateProviderMandatePaymentInput): Promise<ProviderDepositResult>;
  createDeposit(input: CreateProviderDepositInput): Promise<ProviderDepositResult>;
  getDeposit(providerPaymentId: string): Promise<ProviderDepositResult>;
  createPayout(input: CreateProviderPayoutInput): Promise<ProviderPayoutResult>;
}

export const TRUE_LAYER_PROVIDER = Symbol('TRUE_LAYER_PROVIDER');
