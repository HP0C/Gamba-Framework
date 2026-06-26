import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  BankingConnectionStatus,
  BankingMandateStatus,
  BankingPaymentStatus,
  BankingProvider,
  Prisma,
  WalletTransactionType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditManager } from '../audit/audit.manager';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBankingDepositDto } from './dto/create-banking-deposit.dto';
import { CreateBankingMandateDto } from './dto/create-banking-mandate.dto';
import { CreateBankingPayoutDto } from './dto/create-banking-payout.dto';
import { CreateMandateDepositDto } from './dto/create-mandate-deposit.dto';
import {
  ProviderExternalPayoutBeneficiary,
  ProviderDepositResult,
  ProviderMandateResult,
  ProviderPayoutResult,
  TRUE_LAYER_PROVIDER,
  TrueLayerProvider,
} from './providers/truelayer-provider.interface';

const BANKING_PROVIDER = BankingProvider.TRUE_LAYER;
const BANKING_CURRENCY = 'GBP';
const PROVIDER_PAYMENT_POLL_ATTEMPTS = 8;
const PROVIDER_PAYMENT_POLL_DELAY_MS = 1_000;

@Injectable()
export class BankingManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditManager,
    @Inject(TRUE_LAYER_PROVIDER) private readonly provider: TrueLayerProvider,
  ) {}

  async connectBank(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, username: true },
    });
    const providerConnection = await this.provider.createConnection({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const connection = await this.prisma.bankConnection.upsert({
      where: {
        provider_providerConnectionId: {
          provider: BANKING_PROVIDER,
          providerConnectionId: providerConnection.providerConnectionId,
        },
      },
      update: {
        status: providerConnection.status ?? BankingConnectionStatus.ACTIVE,
        consentExpiresAt: providerConnection.consentExpiresAt,
        metadata: this.json(providerConnection.metadata),
      },
      create: {
        userId,
        provider: BANKING_PROVIDER,
        providerConnectionId: providerConnection.providerConnectionId,
        status: providerConnection.status ?? BankingConnectionStatus.ACTIVE,
        consentExpiresAt: providerConnection.consentExpiresAt,
        metadata: this.json(providerConnection.metadata),
      },
    });

    await this.audit.create({
      userId,
      action: 'BANKING_CONNECTION_STARTED',
      entityType: 'BANK_CONNECTION',
      entityId: connection.id,
      metadata: {
        provider: BANKING_PROVIDER,
        mode: this.provider.mode,
        status: connection.status,
      },
    });

    if (providerConnection.authorizationUri) {
      return {
        authorizationUri: providerConnection.authorizationUri,
        connection: this.formatConnection(connection),
        overview: await this.overview(userId),
      };
    }

    return { overview: await this.syncBankData(userId) };
  }

  async completeTrueLayerConnection(userId: string, input: { error?: string; providerConnectionId?: string }) {
    const connection = await this.findConnectionForCallback(userId, input.providerConnectionId);
    if (!connection) throw new NotFoundException('Pending TrueLayer connection not found');

    return this.completeStoredTrueLayerConnection(connection, input.error);
  }

  async completeTrueLayerConnectionCallback(input: { error?: string; providerConnectionId?: string }) {
    const connection = await this.findConnectionForProviderCallback(input.providerConnectionId);
    if (!connection) throw new NotFoundException('Pending TrueLayer connection not found');

    return this.completeStoredTrueLayerConnection(connection, input.error);
  }

  private async completeStoredTrueLayerConnection(
    connection: { id: string; userId: string; metadata: Prisma.JsonValue | null },
    error?: string,
  ) {
    const metadata = {
      ...this.metadataRecord(connection.metadata),
      callbackReceivedAt: new Date().toISOString(),
      callbackError: error,
    };
    const status = error ? BankingConnectionStatus.ERROR : BankingConnectionStatus.ACTIVE;
    const updated = await this.prisma.bankConnection.update({
      where: { id: connection.id },
      data: { status, metadata: this.json(metadata) },
    });

    await this.audit.create({
      userId: connection.userId,
      action: error ? 'BANKING_CONNECTION_FAILED' : 'BANKING_CONNECTION_AUTHORIZED',
      entityType: 'BANK_CONNECTION',
      entityId: updated.id,
      metadata: { provider: BANKING_PROVIDER, mode: this.provider.mode, status: updated.status },
    });

    return this.formatConnection(updated);
  }

  async syncBankData(userId: string) {
    let connection = await this.findActiveConnection(userId);
    if (!connection) {
      const connected = await this.connectBank(userId);
      if ('authorizationUri' in connected && connected.authorizationUri) {
        throw new BadRequestException('Connect and authorise a bank connection first');
      }
      connection = await this.findActiveConnection(userId);
    }
    if (!connection) throw new NotFoundException('Bank connection was not created');

    const accounts = await this.provider.listAccounts(connection.providerConnectionId);

    await this.prisma.$transaction(async (tx) => {
      const balanceAdjustment = await this.cachedExternalBalanceAdjustment(tx, userId);

      for (const [index, account] of accounts.entries()) {
        const currentBalance = account.currentBalance + (index === 0 ? balanceAdjustment : 0n);
        const savedAccount = await tx.externalBankAccount.upsert({
          where: {
            connectionId_providerAccountId: {
              connectionId: connection.id,
              providerAccountId: account.providerAccountId,
            },
          },
          update: {
            displayName: account.displayName,
            accountType: account.accountType,
            currency: account.currency,
            currentBalance,
            raw: this.json(account.raw),
          },
          create: {
            connectionId: connection.id,
            providerAccountId: account.providerAccountId,
            displayName: account.displayName,
            accountType: account.accountType,
            currency: account.currency,
            currentBalance,
            raw: this.json(account.raw),
          },
        });

        const transactions = await this.provider.listTransactions(
          connection.providerConnectionId,
          account.providerAccountId,
        );
        for (const transaction of transactions) {
          await tx.externalBankTransaction.upsert({
            where: {
              bankAccountId_providerTransactionId: {
                bankAccountId: savedAccount.id,
                providerTransactionId: transaction.providerTransactionId,
              },
            },
            update: {
              amount: transaction.amount,
              currency: transaction.currency,
              direction: transaction.direction,
              description: transaction.description,
              merchantName: transaction.merchantName,
              category: transaction.category,
              transactionAt: transaction.transactionAt,
              raw: this.json(transaction.raw),
            },
            create: {
              bankAccountId: savedAccount.id,
              providerTransactionId: transaction.providerTransactionId,
              amount: transaction.amount,
              currency: transaction.currency,
              direction: transaction.direction,
              description: transaction.description,
              merchantName: transaction.merchantName,
              category: transaction.category,
              transactionAt: transaction.transactionAt,
              raw: this.json(transaction.raw),
            },
          });
        }
      }

      await this.audit.create(
        {
          userId,
          action: 'BANKING_SYNCED',
          entityType: 'BANK_CONNECTION',
          entityId: connection.id,
          metadata: { provider: BANKING_PROVIDER, accountCount: accounts.length },
        },
        tx,
      );
    });

    return this.overview(userId);
  }

  async overview(userId: string) {
    const [connections, accounts, transactions, payments, payouts, mandates] = await Promise.all([
      this.prisma.bankConnection.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.externalBankAccount.findMany({
        where: { connection: { userId } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.externalBankTransaction.findMany({
        where: { bankAccount: { connection: { userId } } },
        orderBy: { transactionAt: 'desc' },
        take: 20,
      }),
      this.prisma.bankingPayment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.bankingPayout.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      this.prisma.bankingMandate.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return {
      mode: this.provider.mode,
      connections: connections.map((connection) => this.formatConnection(connection)),
      accounts: accounts.map((account) => ({
        id: account.id,
        displayName: account.displayName,
        accountType: account.accountType,
        currency: account.currency,
        currentBalance: account.currentBalance.toString(),
      })),
      transactions: transactions.map((transaction) => ({
        id: transaction.id,
        bankAccountId: transaction.bankAccountId,
        amount: transaction.amount.toString(),
        currency: transaction.currency,
        direction: transaction.direction.toLowerCase(),
        description: transaction.description,
        merchantName: transaction.merchantName,
        category: transaction.category,
        transactionAt: transaction.transactionAt,
      })),
      payments: payments.map((payment) => ({
        id: payment.id,
        amount: payment.amount.toString(),
        currency: payment.currency,
        status: payment.status.toLowerCase(),
        providerPaymentId: payment.providerPaymentId,
        mandateId: payment.mandateId,
        sourceTransactionId: payment.sourceTransactionId,
        createdAt: payment.createdAt,
        settledAt: payment.settledAt,
      })),
      payouts: payouts.map((payout) => ({
        id: payout.id,
        amount: payout.amount.toString(),
        currency: payout.currency,
        status: payout.status.toLowerCase(),
        providerPayoutId: payout.providerPayoutId,
        createdAt: payout.createdAt,
        settledAt: payout.settledAt,
      })),
      mandates: mandates.map((mandate) => this.formatMandate(mandate)),
    };
  }

  async createMandate(userId: string, dto: CreateBankingMandateDto) {
    const maximumIndividualAmount = BigInt(dto.maximumIndividualAmount);
    const dailyLimit = BigInt(dto.dailyLimit);
    if (maximumIndividualAmount <= 0n) throw new BadRequestException('Maximum individual amount must be positive');
    if (dailyLimit <= 0n) throw new BadRequestException('Daily limit must be positive');
    if (dailyLimit < maximumIndividualAmount) {
      throw new BadRequestException('Daily limit must be at least the maximum individual amount');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, username: true },
    });
    const idempotencyKey = randomUUID();
    const validFrom = new Date();
    const validTo = new Date(validFrom);
    validTo.setUTCDate(validTo.getUTCDate() + (dto.validDays ?? 365));

    const pending = await this.prisma.bankingMandate.create({
      data: {
        userId,
        provider: BANKING_PROVIDER,
        providerMandateId: `pending-${idempotencyKey}`,
        mandateType: 'sweeping',
        currency: BANKING_CURRENCY,
        maximumIndividualAmount,
        dailyLimit,
        validFrom,
        validTo,
        status: BankingMandateStatus.AUTHORIZATION_REQUIRED,
        idempotencyKey,
        raw: this.json({ provider: BANKING_PROVIDER, mode: this.provider.mode, status: 'created_locally' }),
      },
    });

    await this.audit.create({
      userId,
      action: 'BANKING_MANDATE_CREATED',
      entityType: 'BANKING_MANDATE',
      entityId: pending.id,
      metadata: {
        provider: BANKING_PROVIDER,
        maximumIndividualAmount: maximumIndividualAmount.toString(),
        dailyLimit: dailyLimit.toString(),
        validTo: validTo.toISOString(),
      },
    });

    let providerMandate: ProviderMandateResult;
    try {
      providerMandate = await this.provider.createMandate({
        userId,
        email: user.email,
        username: user.username,
        currency: BANKING_CURRENCY,
        maximumIndividualAmount,
        dailyLimit,
        validFrom,
        validTo,
        idempotencyKey,
      });
    } catch (error) {
      const failed = await this.prisma.bankingMandate.update({
        where: { id: pending.id },
        data: {
          status: BankingMandateStatus.FAILED,
          raw: this.json({
            provider: BANKING_PROVIDER,
            mode: this.provider.mode,
            error: error instanceof Error ? error.message : 'Unknown provider error',
          }),
        },
      });
      await this.audit.create({
        userId,
        action: 'BANKING_MANDATE_FAILED',
        entityType: 'BANKING_MANDATE',
        entityId: failed.id,
        metadata: { provider: BANKING_PROVIDER },
      });
      throw error;
    }

    const saved = await this.applyProviderMandateResult(userId, pending.id, providerMandate);
    return { mandate: saved, authorizationUri: saved.authorizationUri };
  }

  async completeTrueLayerMandateCallback(input: { error?: string; providerMandateId?: string }) {
    const mandate = await this.findMandateForProviderCallback(input.providerMandateId);
    if (!mandate) throw new NotFoundException('Pending TrueLayer mandate was not found');

    return this.completeStoredTrueLayerMandate(mandate, input.error);
  }

  async createMandateDeposit(userId: string, dto: CreateMandateDepositDto) {
    const amount = BigInt(dto.amount);
    if (amount <= 0n) throw new BadRequestException('Deposit amount must be positive');

    if (dto.sourceTransactionId) {
      const sourceTransaction = await this.findSourceTransactionForUser(userId, dto.sourceTransactionId);
      if (!sourceTransaction) throw new BadRequestException('Source bank transaction was not found for this user');
    }

    const prepared = await this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const mandate = await this.lockAuthorizedMandate(tx, userId, dto.mandateId);
          this.validateMandatePayment(mandate, amount);

          const usedToday = await this.mandateAmountUsedToday(tx, mandate.id);
          if (usedToday + amount > mandate.dailyLimit) {
            throw new UnprocessableEntityException('This deposit would exceed the mandate daily limit');
          }

          const wallet = await this.lockWallet(tx, userId);
          const idempotencyKey = randomUUID();
          const payment = await tx.bankingPayment.create({
            data: {
              userId,
              walletId: wallet.id,
              mandateId: mandate.id,
              sourceTransactionId: dto.sourceTransactionId,
              provider: BANKING_PROVIDER,
              providerPaymentId: `pending-${idempotencyKey}`,
              amount,
              currency: BANKING_CURRENCY,
              status: BankingPaymentStatus.PENDING,
              idempotencyKey,
              raw: this.json({
                provider: BANKING_PROVIDER,
                mode: this.provider.mode,
                mandateId: mandate.id,
                status: 'created_locally',
              }),
            },
          });

          await this.audit.create(
            {
              userId,
              action: 'BANKING_MANDATE_DEPOSIT_CREATED',
              entityType: 'BANKING_PAYMENT',
              entityId: payment.id,
              metadata: {
                provider: BANKING_PROVIDER,
                mandateId: mandate.id,
                amount: amount.toString(),
                status: payment.status,
              },
            },
            tx,
          );

          return {
            mandateProviderId: mandate.providerMandateId,
            idempotencyKey,
            paymentId: payment.id,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    let providerPayment: ProviderDepositResult;
    try {
      const createdPayment = await this.provider.createMandatePayment({
        userId,
        providerMandateId: prepared.mandateProviderId,
        amount,
        currency: BANKING_CURRENCY,
        idempotencyKey: prepared.idempotencyKey,
        localPaymentId: prepared.paymentId,
        sourceTransactionId: dto.sourceTransactionId,
      });
      providerPayment = await this.waitForProviderPaymentSettlement(createdPayment);
    } catch (error) {
      await this.markDepositFailed(userId, prepared.paymentId, prepared.idempotencyKey, error);
      throw error;
    }

    return this.applyProviderDepositResult(userId, prepared.paymentId, providerPayment);
  }

  async createDeposit(userId: string, dto: CreateBankingDepositDto) {
    const amount = BigInt(dto.amount);
    if (amount <= 0n) throw new BadRequestException('Deposit amount must be positive');

    if (dto.sourceTransactionId) {
      const sourceTransaction = await this.findSourceTransactionForUser(userId, dto.sourceTransactionId);
      if (!sourceTransaction) throw new BadRequestException('Source bank transaction was not found for this user');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, username: true },
    });
    const idempotencyKey = randomUUID();
    const pendingPayment = await this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const wallet = await this.lockWallet(tx, userId);
          const payment = await tx.bankingPayment.create({
            data: {
              userId,
              walletId: wallet.id,
              sourceTransactionId: dto.sourceTransactionId,
              provider: BANKING_PROVIDER,
              providerPaymentId: `pending-${idempotencyKey}`,
              amount,
              currency: BANKING_CURRENCY,
              status: BankingPaymentStatus.PENDING,
              idempotencyKey,
              raw: this.json({ provider: BANKING_PROVIDER, mode: this.provider.mode, status: 'created_locally' }),
            },
          });

          await this.audit.create(
            {
              userId,
              action: 'BANKING_DEPOSIT_CREATED',
              entityType: 'BANKING_PAYMENT',
              entityId: payment.id,
              metadata: {
                provider: BANKING_PROVIDER,
                amount: amount.toString(),
                status: payment.status,
              },
            },
            tx,
          );

          return payment;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    let providerPayment: ProviderDepositResult;
    try {
      providerPayment = await this.provider.createDeposit({
        userId,
        email: user.email,
        username: user.username,
        amount,
        currency: BANKING_CURRENCY,
        idempotencyKey,
        localPaymentId: pendingPayment.id,
        sourceTransactionId: dto.sourceTransactionId,
      });
    } catch (error) {
      await this.markDepositFailed(userId, pendingPayment.id, idempotencyKey, error);
      throw error;
    }

    return this.applyProviderDepositResult(userId, pendingPayment.id, providerPayment);
  }

  async completeTrueLayerPayment(userId: string, input: { error?: string; paymentId?: string; providerPaymentId?: string }) {
    const payment = await this.findPaymentForCallback(userId, input.paymentId, input.providerPaymentId);
    if (!payment) throw new NotFoundException('Pending TrueLayer payment was not found');

    return this.completeStoredTrueLayerPayment(payment, input.error);
  }

  async completeTrueLayerPaymentCallback(input: { error?: string; paymentId?: string; providerPaymentId?: string }) {
    const payment = await this.findPaymentForProviderCallback(input.paymentId, input.providerPaymentId);
    if (!payment) throw new NotFoundException('Pending TrueLayer payment was not found');

    return this.completeStoredTrueLayerPayment(payment, input.error);
  }

  async refreshPendingDeposits(userId: string) {
    const payments = await this.prisma.bankingPayment.findMany({
      where: {
        userId,
        provider: BANKING_PROVIDER,
        status: BankingPaymentStatus.PENDING,
        NOT: { providerPaymentId: { startsWith: 'pending-' } },
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const payment of payments) {
      const providerPayment = await this.provider.getDeposit(payment.providerPaymentId);
      await this.applyProviderDepositResult(userId, payment.id, providerPayment);
    }

    return this.overview(userId);
  }

  async createPayout(userId: string, dto: CreateBankingPayoutDto) {
    const amount = BigInt(dto.amount);
    if (amount <= 0n) throw new BadRequestException('Payout amount must be positive');

    const idempotencyKey = randomUUID();
    const paymentSourceId = await this.latestPaymentSourceIdForUser(userId);
    const providerUserId = await this.latestProviderUserIdForUser(userId);
    const externalBeneficiary = await this.latestExternalPayoutBeneficiaryForUser(userId);
    const pending = await this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const wallet = await this.lockWallet(tx, userId);
          if (wallet.balance < amount) throw new UnprocessableEntityException('Insufficient wallet balance');

          const payout = await tx.bankingPayout.create({
            data: {
              userId,
              walletId: wallet.id,
              provider: BANKING_PROVIDER,
              providerPayoutId: `pending-${idempotencyKey}`,
              amount,
              currency: BANKING_CURRENCY,
              status: BankingPaymentStatus.PENDING,
              idempotencyKey,
            },
          });
          const newBalance = wallet.balance - amount;
          await tx.wallet.update({ where: { id: wallet.id }, data: { balance: newBalance } });
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: WalletTransactionType.WITHDRAWAL,
              amount: -amount,
              balanceBefore: wallet.balance,
              balanceAfter: newBalance,
              referenceType: 'BANKING_PAYOUT',
              referenceId: payout.id,
              idempotencyKey: `wallet:${idempotencyKey}`,
            },
          });

          await this.audit.create(
            {
              userId,
              action: 'BANKING_PAYOUT_REQUESTED',
              entityType: 'BANKING_PAYOUT',
              entityId: payout.id,
              metadata: { provider: BANKING_PROVIDER, amount: amount.toString() },
            },
            tx,
          );

          return { payoutId: payout.id, newBalance };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );

    let providerPayout: ProviderPayoutResult;
    try {
      providerPayout = await this.provider.createPayout({
        userId,
        amount,
        currency: BANKING_CURRENCY,
        idempotencyKey,
        paymentSourceId,
        providerUserId,
        externalBeneficiary,
      });
    } catch (error) {
      await this.failPayoutAndRefund(userId, pending.payoutId, amount, idempotencyKey);
      throw error;
    }

    if (providerPayout.status === BankingPaymentStatus.FAILED) {
      return this.failPayoutAndRefund(userId, pending.payoutId, amount, idempotencyKey, providerPayout);
    }

    const settled = await this.prisma.$transaction(async (tx) => {
      const payout = await tx.bankingPayout.update({
        where: { id: pending.payoutId },
        data: {
          providerPayoutId: providerPayout.providerPayoutId,
          status: providerPayout.status,
          raw: this.json(providerPayout.raw),
          settledAt: providerPayout.status === BankingPaymentStatus.SUCCEEDED ? new Date() : undefined,
        },
      });
      if (providerPayout.status !== BankingPaymentStatus.FAILED) {
        await this.adjustCachedBankAccountBalance(tx, userId, amount);
      }
      await this.audit.create(
        {
          userId,
          action:
            providerPayout.status === BankingPaymentStatus.SUCCEEDED
              ? 'BANKING_PAYOUT_SETTLED'
              : 'BANKING_PAYOUT_PENDING',
          entityType: 'BANKING_PAYOUT',
          entityId: payout.id,
          metadata: {
            provider: BANKING_PROVIDER,
            amount: payout.amount.toString(),
            status: payout.status,
          },
        },
        tx,
      );
      return payout;
    });

    return {
      id: settled.id,
      status: settled.status.toLowerCase(),
      amount: settled.amount.toString(),
      currency: settled.currency,
      newBalance: pending.newBalance.toString(),
    };
  }

  private async applyProviderMandateResult(
    userId: string,
    mandateId: string,
    providerMandate: ProviderMandateResult,
  ) {
    const updated = await this.prisma.bankingMandate.update({
      where: { id: mandateId },
      data: {
        providerMandateId: providerMandate.providerMandateId,
        providerUserId: providerMandate.providerUserId,
        status: providerMandate.status,
        authorizationUri: providerMandate.authorizationUri,
        raw: this.json(providerMandate.raw),
        authorizedAt:
          providerMandate.status === BankingMandateStatus.AUTHORIZED ? new Date() : undefined,
        revokedAt: providerMandate.status === BankingMandateStatus.REVOKED ? new Date() : undefined,
      },
    });

    await this.audit.create({
      userId,
      action:
        updated.status === BankingMandateStatus.AUTHORIZED
          ? 'BANKING_MANDATE_AUTHORIZED'
          : updated.status === BankingMandateStatus.FAILED
            ? 'BANKING_MANDATE_FAILED'
            : 'BANKING_MANDATE_UPDATED',
      entityType: 'BANKING_MANDATE',
      entityId: updated.id,
      metadata: {
        provider: BANKING_PROVIDER,
        status: updated.status,
        maximumIndividualAmount: updated.maximumIndividualAmount.toString(),
        dailyLimit: updated.dailyLimit.toString(),
      },
    });

    return this.formatMandate(updated);
  }

  private async completeStoredTrueLayerMandate(
    mandate: { id: string; userId: string; providerMandateId: string },
    error?: string,
  ) {
    if (error) {
      return this.applyProviderMandateResult(mandate.userId, mandate.id, {
        providerMandateId: mandate.providerMandateId,
        status: BankingMandateStatus.FAILED,
        raw: {
          provider: BANKING_PROVIDER,
          mode: this.provider.mode,
          callbackError: error,
        },
      });
    }

    if (mandate.providerMandateId.startsWith('pending-')) {
      throw new BadRequestException('TrueLayer mandate has not been created with the provider yet');
    }

    const providerMandate = await this.provider.getMandate(mandate.providerMandateId);
    return this.applyProviderMandateResult(mandate.userId, mandate.id, providerMandate);
  }

  private async applyProviderDepositResult(
    userId: string,
    paymentId: string,
    providerPayment: ProviderDepositResult,
  ) {
    return this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const payment = await this.lockBankingPayment(tx, userId, paymentId);
          const nextStatus =
            payment.status === BankingPaymentStatus.PENDING ? providerPayment.status : payment.status;
          const settledAt =
            nextStatus === BankingPaymentStatus.SUCCEEDED || nextStatus === BankingPaymentStatus.FAILED
              ? payment.settledAt ?? new Date()
              : payment.settledAt;

          let newBalance: bigint | undefined;
          if (providerPayment.status === BankingPaymentStatus.SUCCEEDED && !payment.settledAt) {
            const wallet = await this.lockWallet(tx, userId);
            if (wallet.id !== payment.walletId) throw new NotFoundException('Wallet for payment was not found');

            newBalance = wallet.balance + payment.amount;
            await tx.wallet.update({ where: { id: wallet.id }, data: { balance: newBalance } });
            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: WalletTransactionType.DEPOSIT,
                amount: payment.amount,
                balanceBefore: wallet.balance,
                balanceAfter: newBalance,
                referenceType: 'BANKING_PAYMENT',
                referenceId: payment.id,
                idempotencyKey: `wallet-deposit:${payment.id}`,
              },
            });
            await this.adjustCachedBankAccountBalance(tx, userId, -payment.amount);
          }

          const updated = await tx.bankingPayment.update({
            where: { id: payment.id },
            data: {
              providerPaymentId: providerPayment.providerPaymentId,
              paymentSourceId: providerPayment.paymentSourceId ?? payment.paymentSourceId,
              status: nextStatus,
              raw: this.json(providerPayment.raw),
              settledAt,
            },
          });

          await this.audit.create(
            {
              userId,
              action:
                nextStatus === BankingPaymentStatus.SUCCEEDED
                  ? 'BANKING_DEPOSIT_SETTLED'
                  : nextStatus === BankingPaymentStatus.FAILED
                    ? 'BANKING_DEPOSIT_FAILED'
                    : 'BANKING_DEPOSIT_PENDING',
              entityType: 'BANKING_PAYMENT',
              entityId: updated.id,
              metadata: {
                provider: BANKING_PROVIDER,
                amount: updated.amount.toString(),
                status: updated.status,
              },
            },
            tx,
          );

          return {
            id: updated.id,
            status: updated.status.toLowerCase(),
            amount: updated.amount.toString(),
            currency: updated.currency,
            newBalance: newBalance?.toString(),
            authorizationUri: providerPayment.authorizationUri,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async markDepositFailed(userId: string, paymentId: string, idempotencyKey: string, error: unknown) {
    await this.applyProviderDepositResult(userId, paymentId, {
      providerPaymentId: `pending-${idempotencyKey}`,
      status: BankingPaymentStatus.FAILED,
      raw: {
        provider: BANKING_PROVIDER,
        mode: this.provider.mode,
        error: error instanceof Error ? error.message : 'Unknown provider error',
      },
    });
  }

  private async waitForProviderPaymentSettlement(providerPayment: ProviderDepositResult) {
    let latest = providerPayment;
    for (let attempt = 0; attempt < PROVIDER_PAYMENT_POLL_ATTEMPTS; attempt += 1) {
      if (latest.status !== BankingPaymentStatus.PENDING) return latest;
      await this.sleep(PROVIDER_PAYMENT_POLL_DELAY_MS);
      latest = await this.provider.getDeposit(providerPayment.providerPaymentId);
    }
    return latest;
  }

  private formatConnection(connection: {
    id: string;
    provider: BankingProvider;
    status: BankingConnectionStatus;
    consentExpiresAt: Date | null;
    metadata: Prisma.JsonValue | null;
  }) {
    const metadata = this.metadataRecord(connection.metadata);
    const authorizationUri = typeof metadata.authorizationUri === 'string' ? metadata.authorizationUri : undefined;
    return {
      id: connection.id,
      provider: connection.provider.toLowerCase(),
      status: connection.status.toLowerCase(),
      consentExpiresAt: connection.consentExpiresAt,
      authorizationUri,
    };
  }

  private formatMandate(mandate: {
    id: string;
    provider: BankingProvider;
    providerMandateId: string;
    status: BankingMandateStatus;
    currency: string;
    maximumIndividualAmount: bigint;
    dailyLimit: bigint;
    validFrom: Date;
    validTo: Date;
    authorizationUri: string | null;
    authorizedAt: Date | null;
    revokedAt: Date | null;
  }) {
    return {
      id: mandate.id,
      provider: mandate.provider.toLowerCase(),
      providerMandateId: mandate.providerMandateId,
      status: mandate.status.toLowerCase(),
      currency: mandate.currency,
      maximumIndividualAmount: mandate.maximumIndividualAmount.toString(),
      dailyLimit: mandate.dailyLimit.toString(),
      validFrom: mandate.validFrom,
      validTo: mandate.validTo,
      authorizationUri: mandate.authorizationUri ?? undefined,
      authorizedAt: mandate.authorizedAt,
      revokedAt: mandate.revokedAt,
    };
  }

  private findActiveConnection(userId: string) {
    return this.prisma.bankConnection.findFirst({
      where: {
        userId,
        provider: BANKING_PROVIDER,
        status: BankingConnectionStatus.ACTIVE,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findConnectionForCallback(userId: string, providerConnectionId?: string) {
    if (providerConnectionId) {
      return this.prisma.bankConnection.findFirst({
        where: {
          userId,
          provider: BANKING_PROVIDER,
          providerConnectionId,
        },
      });
    }

    return this.prisma.bankConnection.findFirst({
      where: {
        userId,
        provider: BANKING_PROVIDER,
        status: BankingConnectionStatus.AUTHORIZATION_REQUIRED,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  private findConnectionForProviderCallback(providerConnectionId?: string) {
    if (!providerConnectionId) return null;

    return this.prisma.bankConnection.findFirst({
      where: {
        provider: BANKING_PROVIDER,
        providerConnectionId,
        status: BankingConnectionStatus.AUTHORIZATION_REQUIRED,
      },
    });
  }

  private findSourceTransactionForUser(userId: string, sourceTransactionId: string) {
    return this.prisma.externalBankTransaction.findFirst({
      where: {
        id: sourceTransactionId,
        bankAccount: { connection: { userId } },
      },
    });
  }

  private findMandateForProviderCallback(providerMandateId?: string) {
    if (!providerMandateId) return null;

    return this.prisma.bankingMandate.findFirst({
      where: {
        provider: BANKING_PROVIDER,
        providerMandateId,
      },
    });
  }

  private async latestPaymentSourceIdForUser(userId: string): Promise<string | undefined> {
    const payment = await this.prisma.bankingPayment.findFirst({
      where: {
        userId,
        provider: BANKING_PROVIDER,
        status: BankingPaymentStatus.SUCCEEDED,
        paymentSourceId: { not: null },
      },
      orderBy: { settledAt: 'desc' },
      select: { paymentSourceId: true },
    });
    return payment?.paymentSourceId ?? undefined;
  }

  private async latestProviderUserIdForUser(userId: string): Promise<string | undefined> {
    const mandate = await this.prisma.bankingMandate.findFirst({
      where: {
        userId,
        provider: BANKING_PROVIDER,
        providerUserId: { not: null },
      },
      orderBy: { updatedAt: 'desc' },
      select: { providerUserId: true },
    });
    return mandate?.providerUserId ?? undefined;
  }

  private async latestExternalPayoutBeneficiaryForUser(
    userId: string,
  ): Promise<ProviderExternalPayoutBeneficiary | undefined> {
    const account = await this.prisma.externalBankAccount.findFirst({
      where: {
        connection: { userId },
        currency: BANKING_CURRENCY,
      },
      orderBy: { updatedAt: 'desc' },
      select: {
        displayName: true,
        raw: true,
      },
    });
    if (!account) return undefined;

    const raw = this.metadataRecord(account.raw);
    const holderNames = Array.isArray(raw.account_holder_names) ? raw.account_holder_names : [];
    const accountHolderName =
      holderNames.find((name): name is string => typeof name === 'string' && name.trim().length > 0) ??
      account.displayName;
    const identifiers = Array.isArray(raw.account_identifiers) ? raw.account_identifiers : [];
    const accountIdentifier = this.preferredAccountIdentifier(identifiers);
    if (!accountIdentifier) return undefined;

    return {
      accountHolderName,
      accountIdentifier,
    };
  }

  private preferredAccountIdentifier(identifiers: unknown[]): Record<string, string> | undefined {
    const records = identifiers.filter(
      (identifier): identifier is Record<string, unknown> =>
        Boolean(identifier) && typeof identifier === 'object' && !Array.isArray(identifier),
    );
    const scan = records.find(
      (identifier) =>
        identifier.type === 'sort_code_account_number' &&
        typeof identifier.sort_code === 'string' &&
        typeof identifier.account_number === 'string',
    );
    if (scan) {
      return {
        type: 'sort_code_account_number',
        sort_code: String(scan.sort_code),
        account_number: String(scan.account_number),
      };
    }

    const iban = records.find((identifier) => identifier.type === 'iban' && typeof identifier.iban === 'string');
    if (iban) {
      return {
        type: 'iban',
        iban: String(iban.iban),
      };
    }

    return undefined;
  }

  private async adjustCachedBankAccountBalance(
    db: Pick<Prisma.TransactionClient, 'externalBankAccount'>,
    userId: string,
    amountDelta: bigint,
  ) {
    const account = await db.externalBankAccount.findFirst({
      where: { connection: { userId }, currency: BANKING_CURRENCY },
      orderBy: { createdAt: 'asc' },
    });
    if (!account) return;
    await db.externalBankAccount.update({
      where: { id: account.id },
      data: { currentBalance: account.currentBalance + amountDelta },
    });
  }

  private async cachedExternalBalanceAdjustment(
    db: Pick<Prisma.TransactionClient, 'bankingPayment' | 'bankingPayout'>,
    userId: string,
  ): Promise<bigint> {
    const [deposits, payouts] = await Promise.all([
      db.bankingPayment.aggregate({
        where: {
          userId,
          provider: BANKING_PROVIDER,
          status: BankingPaymentStatus.SUCCEEDED,
        },
        _sum: { amount: true },
      }),
      db.bankingPayout.aggregate({
        where: {
          userId,
          provider: BANKING_PROVIDER,
          status: { not: BankingPaymentStatus.FAILED },
        },
        _sum: { amount: true },
      }),
    ]);

    return (payouts._sum.amount ?? 0n) - (deposits._sum.amount ?? 0n);
  }

  private findPaymentForCallback(userId: string, paymentId?: string, providerPaymentId?: string) {
    if (paymentId) {
      return this.prisma.bankingPayment.findFirst({
        where: { id: paymentId, userId, provider: BANKING_PROVIDER },
      });
    }

    if (providerPaymentId) {
      return this.prisma.bankingPayment.findFirst({
        where: { provider: BANKING_PROVIDER, providerPaymentId, userId },
      });
    }

    return this.prisma.bankingPayment.findFirst({
      where: { userId, provider: BANKING_PROVIDER, status: BankingPaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });
  }

  private findPaymentForProviderCallback(paymentId?: string, providerPaymentId?: string) {
    if (paymentId) {
      return this.prisma.bankingPayment.findFirst({
        where: { id: paymentId, provider: BANKING_PROVIDER },
      });
    }

    if (providerPaymentId) {
      return this.prisma.bankingPayment.findFirst({
        where: { provider: BANKING_PROVIDER, providerPaymentId },
      });
    }

    return null;
  }

  private async lockAuthorizedMandate(
    tx: Prisma.TransactionClient,
    userId: string,
    mandateId?: string,
  ) {
    const now = new Date();
    const locked = mandateId
      ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "BankingMandate"
          WHERE "id" = ${mandateId}::uuid
            AND "userId" = ${userId}::uuid
            AND "provider" = ${BANKING_PROVIDER}::"BankingProvider"
          FOR UPDATE
        `)
      : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "BankingMandate"
          WHERE "userId" = ${userId}::uuid
            AND "provider" = ${BANKING_PROVIDER}::"BankingProvider"
            AND "status" = ${BankingMandateStatus.AUTHORIZED}::"BankingMandateStatus"
            AND "validFrom" <= ${now}
            AND "validTo" > ${now}
          ORDER BY "createdAt" DESC
          LIMIT 1
          FOR UPDATE
        `);
    if (!locked[0]) throw new NotFoundException('No authorised Open Banking mandate was found');

    return tx.bankingMandate.findUniqueOrThrow({ where: { id: locked[0].id } });
  }

  private validateMandatePayment(
    mandate: {
      status: BankingMandateStatus;
      validFrom: Date;
      validTo: Date;
      maximumIndividualAmount: bigint;
    },
    amount: bigint,
  ) {
    const now = new Date();
    if (mandate.status !== BankingMandateStatus.AUTHORIZED) {
      throw new BadRequestException('Open Banking mandate is not authorised');
    }
    if (mandate.validFrom > now || mandate.validTo <= now) {
      throw new BadRequestException('Open Banking mandate is outside its valid date range');
    }
    if (amount > mandate.maximumIndividualAmount) {
      throw new UnprocessableEntityException('This deposit exceeds the mandate individual payment limit');
    }
  }

  private async mandateAmountUsedToday(
    tx: Prisma.TransactionClient,
    mandateId: string,
  ): Promise<bigint> {
    const startOfToday = new Date();
    startOfToday.setUTCHours(0, 0, 0, 0);
    const used = await tx.bankingPayment.aggregate({
      where: {
        mandateId,
        status: { not: BankingPaymentStatus.FAILED },
        createdAt: { gte: startOfToday },
      },
      _sum: { amount: true },
    });

    return used._sum.amount ?? 0n;
  }

  private async completeStoredTrueLayerPayment(
    payment: { id: string; userId: string; providerPaymentId: string },
    error?: string,
  ) {
    if (error) {
      return this.applyProviderDepositResult(payment.userId, payment.id, {
        providerPaymentId: payment.providerPaymentId,
        status: BankingPaymentStatus.FAILED,
        raw: {
          provider: BANKING_PROVIDER,
          mode: this.provider.mode,
          callbackError: error,
        },
      });
    }

    if (payment.providerPaymentId.startsWith('pending-')) {
      throw new BadRequestException('TrueLayer payment has not been created with the provider yet');
    }

    const providerPayment = await this.provider.getDeposit(payment.providerPaymentId);
    return this.applyProviderDepositResult(payment.userId, payment.id, providerPayment);
  }

  private async lockBankingPayment(tx: Prisma.TransactionClient, userId: string, paymentId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "BankingPayment"
      WHERE "id" = ${paymentId}::uuid AND "userId" = ${userId}::uuid
      FOR UPDATE
    `);
    if (!locked[0]) throw new NotFoundException('Banking payment not found');
    return tx.bankingPayment.findUniqueOrThrow({ where: { id: locked[0].id } });
  }

  private async lockWallet(tx: Prisma.TransactionClient, userId: string) {
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Wallet"
      WHERE "userId" = ${userId}::uuid AND "currency" = ${BANKING_CURRENCY}
      FOR UPDATE
    `);
    if (!locked[0]) throw new NotFoundException('Wallet not found');
    return tx.wallet.findUniqueOrThrow({ where: { id: locked[0].id } });
  }

  private async failPayoutAndRefund(
    userId: string,
    payoutId: string,
    amount: bigint,
    idempotencyKey: string,
    providerPayout?: ProviderPayoutResult,
  ) {
    return this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const wallet = await this.lockWallet(tx, userId);
          const refundedBalance = wallet.balance + amount;
          const payout = await tx.bankingPayout.update({
            where: { id: payoutId },
            data: {
              providerPayoutId: providerPayout?.providerPayoutId,
              status: BankingPaymentStatus.FAILED,
              raw: this.json(providerPayout?.raw),
              settledAt: new Date(),
            },
          });
          await tx.wallet.update({ where: { id: wallet.id }, data: { balance: refundedBalance } });
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: WalletTransactionType.ADJUSTMENT,
              amount,
              balanceBefore: wallet.balance,
              balanceAfter: refundedBalance,
              referenceType: 'BANKING_PAYOUT_FAILED',
              referenceId: payout.id,
              idempotencyKey: `wallet-refund:${idempotencyKey}`,
            },
          });
          await this.audit.create(
            {
              userId,
              action: 'BANKING_PAYOUT_FAILED_REFUNDED',
              entityType: 'BANKING_PAYOUT',
              entityId: payout.id,
              metadata: { provider: BANKING_PROVIDER, amount: amount.toString() },
            },
            tx,
          );
          return {
            id: payout.id,
            status: payout.status.toLowerCase(),
            amount: payout.amount.toString(),
            currency: payout.currency,
            newBalance: refundedBalance.toString(),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private json(value: Record<string, unknown> | undefined): Prisma.InputJsonObject | undefined {
    return value as Prisma.InputJsonObject | undefined;
  }

  private metadataRecord(value: Prisma.JsonValue | null): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private async withSerializationRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2034' || attempt === 2) {
          throw error;
        }
      }
    }
    throw new Error('Unreachable transaction retry state');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
