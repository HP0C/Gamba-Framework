import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BankingConnectionStatus,
  BankingPaymentStatus,
  BankingProvider,
  Prisma,
  WalletTransactionType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { AuditManager } from '../audit/audit.manager';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBankingDepositDto } from './dto/create-banking-deposit.dto';
import { CreateBankingPayoutDto } from './dto/create-banking-payout.dto';
import {
  ProviderDepositResult,
  ProviderPayoutResult,
  TRUE_LAYER_PROVIDER,
  TrueLayerProvider,
} from './providers/truelayer-provider.interface';

const BANKING_PROVIDER = BankingProvider.TRUE_LAYER;
const BANKING_CURRENCY = 'GBP';

@Injectable()
export class BankingManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditManager,
    private readonly config: ConfigService,
    @Inject(TRUE_LAYER_PROVIDER) private readonly provider: TrueLayerProvider,
  ) {}

  async connectBank(userId: string, appReturnUrl?: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, username: true },
    });
    const providerConnection = await this.provider.createConnection({
      userId: user.id,
      email: user.email,
      username: user.username,
    });
    const connectionMetadata = {
      ...providerConnection.metadata,
      ...(appReturnUrl ? { appReturnUrl } : {}),
    };
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
        metadata: this.json(connectionMetadata),
      },
      create: {
        userId,
        provider: BANKING_PROVIDER,
        providerConnectionId: providerConnection.providerConnectionId,
        status: providerConnection.status ?? BankingConnectionStatus.ACTIVE,
        consentExpiresAt: providerConnection.consentExpiresAt,
        metadata: this.json(connectionMetadata),
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
    const metadata: Record<string, unknown> = {
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

    return {
      ...this.formatConnection(updated),
      appReturnUrl: typeof metadata.appReturnUrl === 'string' ? metadata.appReturnUrl : undefined,
    };
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
          },
          create: {
            connectionId: connection.id,
            providerAccountId: account.providerAccountId,
            displayName: account.displayName,
            accountType: account.accountType,
            currency: account.currency,
            currentBalance,
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
    const [connections, accounts, transactions, payments, payouts] = await Promise.all([
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
    };
  }

  async createDeposit(userId: string, dto: CreateBankingDepositDto, appReturnUrl?: string) {
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
              raw: this.json({
                provider: BANKING_PROVIDER,
                mode: this.provider.mode,
                status: 'created_locally',
                ...(appReturnUrl ? { appReturnUrl } : {}),
              }),
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
      providerPayment = this.instantDepositsForTesting()
        ? this.createInstantTestingDepositResult(pendingPayment.id, idempotencyKey, amount, dto.sourceTransactionId)
        : await this.provider.createDeposit({
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
      providerPayout = this.instantDepositsForTesting()
        ? this.createInstantTestingPayoutResult(idempotencyKey, amount)
        : await this.createProviderPayout(userId, amount, idempotencyKey);
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
              raw: this.json({
                ...this.metadataRecord(payment.raw),
                providerResult: providerPayment.raw,
              }),
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

  private instantDepositsForTesting(): boolean {
    return this.config.get<string>('BANKING_INSTANT_DEPOSITS_FOR_TESTING', 'false').toLowerCase() === 'true';
  }

  private createInstantTestingDepositResult(
    localPaymentId: string,
    idempotencyKey: string,
    amount: bigint,
    sourceTransactionId?: string,
  ): ProviderDepositResult {
    return {
      providerPaymentId: `test-instant-${idempotencyKey}`,
      paymentSourceId: `test-payment-source-${localPaymentId}`,
      status: BankingPaymentStatus.SUCCEEDED,
      raw: {
        provider: BANKING_PROVIDER,
        mode: this.provider.mode,
        testingMode: 'instant_deposit_without_payment_authorisation',
        amount: amount.toString(),
        sourceTransactionId: sourceTransactionId ?? null,
      },
    };
  }

  private createInstantTestingPayoutResult(idempotencyKey: string, amount: bigint): ProviderPayoutResult {
    return {
      providerPayoutId: `test-instant-payout-${idempotencyKey}`,
      status: BankingPaymentStatus.SUCCEEDED,
      raw: {
        provider: BANKING_PROVIDER,
        mode: this.provider.mode,
        testingMode: 'instant_payout_without_payment_authorisation',
        amount: amount.toString(),
      },
    };
  }

  private async createProviderPayout(
    userId: string,
    amount: bigint,
    idempotencyKey: string,
  ): Promise<ProviderPayoutResult> {
    const paymentSourceId = await this.latestPaymentSourceIdForUser(userId);
    return this.provider.createPayout({
      userId,
      amount,
      currency: BANKING_CURRENCY,
      idempotencyKey,
      paymentSourceId,
    });
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

  private async completeStoredTrueLayerPayment(
    payment: { id: string; userId: string; providerPaymentId: string; raw: Prisma.JsonValue | null },
    error?: string,
  ) {
    const paymentMetadata = this.metadataRecord(payment.raw);
    const appReturnUrl =
      typeof paymentMetadata.appReturnUrl === 'string' ? paymentMetadata.appReturnUrl : undefined;
    if (error) {
      const result = await this.applyProviderDepositResult(payment.userId, payment.id, {
        providerPaymentId: payment.providerPaymentId,
        status: BankingPaymentStatus.FAILED,
        raw: {
          provider: BANKING_PROVIDER,
          mode: this.provider.mode,
          callbackError: error,
        },
      });
      return { ...result, appReturnUrl };
    }

    if (payment.providerPaymentId.startsWith('pending-')) {
      throw new BadRequestException('TrueLayer payment has not been created with the provider yet');
    }

    const providerPayment = await this.provider.getDeposit(payment.providerPaymentId);
    const result = await this.applyProviderDepositResult(payment.userId, payment.id, providerPayment);
    return { ...result, appReturnUrl };
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
}
