import { Injectable } from '@nestjs/common';
import { BankingPaymentStatus } from '@prisma/client';
import {
  CreateProviderConnectionInput,
  CreateProviderDepositInput,
  CreateProviderPayoutInput,
  ProviderBankAccount,
  ProviderBankTransaction,
  ProviderConnection,
  ProviderDepositResult,
  ProviderPayoutResult,
  TrueLayerProvider,
} from './truelayer-provider.interface';

@Injectable()
export class MockTrueLayerProvider implements TrueLayerProvider {
  readonly mode = 'mock' as const;

  async createConnection(input: CreateProviderConnectionInput): Promise<ProviderConnection> {
    return {
      providerConnectionId: `mock-truelayer-connection-${input.userId}`,
      consentExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      metadata: {
        mode: 'mock',
        provider: 'TrueLayer Mock Bank',
        note: 'Replace this provider with live TrueLayer API calls before handling real money.',
      },
    };
  }

  async listAccounts(providerConnectionId: string): Promise<ProviderBankAccount[]> {
    return [
      {
        providerAccountId: `${providerConnectionId}-current-gbp`,
        displayName: 'TrueLayer Mock Current Account',
        accountType: 'transaction',
        currency: 'GBP',
        currentBalance: 124_350n,
        raw: {
          account_id: `${providerConnectionId}-current-gbp`,
          display_name: 'TrueLayer Mock Current Account',
          currency: 'GBP',
        },
      },
    ];
  }

  async listTransactions(
    providerConnectionId: string,
    providerAccountId: string,
  ): Promise<ProviderBankTransaction[]> {
    const prefix = `${providerConnectionId}:${providerAccountId}`;
    return [
      {
        providerTransactionId: `${prefix}:coffee-1000`,
        amount: -1_000n,
        currency: 'GBP',
        direction: 'OUTBOUND',
        description: 'Coffee shop',
        merchantName: 'Example Coffee',
        category: 'eating_out',
        transactionAt: new Date('2026-06-21T09:15:00.000Z'),
        raw: { transaction_id: `${prefix}:coffee-1000`, amount_in_minor: -1_000 },
      },
      {
        providerTransactionId: `${prefix}:groceries-4325`,
        amount: -4_325n,
        currency: 'GBP',
        direction: 'OUTBOUND',
        description: 'Weekly groceries',
        merchantName: 'Mock Market',
        category: 'groceries',
        transactionAt: new Date('2026-06-20T17:40:00.000Z'),
        raw: { transaction_id: `${prefix}:groceries-4325`, amount_in_minor: -4_325 },
      },
      {
        providerTransactionId: `${prefix}:train-1000`,
        amount: -1_000n,
        currency: 'GBP',
        direction: 'OUTBOUND',
        description: 'Train fare',
        merchantName: 'Mock Rail',
        category: 'transport',
        transactionAt: new Date('2026-06-19T07:55:00.000Z'),
        raw: { transaction_id: `${prefix}:train-1000`, amount_in_minor: -1_000 },
      },
      {
        providerTransactionId: `${prefix}:salary-250000`,
        amount: 250_000n,
        currency: 'GBP',
        direction: 'INBOUND',
        description: 'Salary payment',
        merchantName: 'Example Employer',
        category: 'income',
        transactionAt: new Date('2026-06-18T08:00:00.000Z'),
        raw: { transaction_id: `${prefix}:salary-250000`, amount_in_minor: 250_000 },
      },
    ];
  }

  async createDeposit(input: CreateProviderDepositInput): Promise<ProviderDepositResult> {
    return {
      providerPaymentId: `mock-payment-${input.idempotencyKey}`,
      paymentSourceId: `mock-payment-source-${input.userId}`,
      status: BankingPaymentStatus.SUCCEEDED,
      raw: {
        provider: 'truelayer',
        mode: 'mock',
        payment_id: `mock-payment-${input.idempotencyKey}`,
        amount_in_minor: input.amount.toString(),
        source_transaction_id: input.sourceTransactionId ?? null,
      },
    };
  }

  async getDeposit(providerPaymentId: string): Promise<ProviderDepositResult> {
    return {
      providerPaymentId,
      status: BankingPaymentStatus.SUCCEEDED,
      raw: {
        provider: 'truelayer',
        mode: 'mock',
        payment_id: providerPaymentId,
      },
    };
  }

  async createPayout(input: CreateProviderPayoutInput): Promise<ProviderPayoutResult> {
    return {
      providerPayoutId: `mock-payout-${input.idempotencyKey}`,
      status: BankingPaymentStatus.SUCCEEDED,
      raw: {
        provider: 'truelayer',
        mode: 'mock',
        payout_id: `mock-payout-${input.idempotencyKey}`,
        amount_in_minor: input.amount.toString(),
      },
    };
  }
}
