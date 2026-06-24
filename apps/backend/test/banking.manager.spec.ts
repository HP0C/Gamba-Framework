import { BankingPaymentStatus } from '@prisma/client';
import { BankingManager } from '../src/banking/banking.manager';
import { PrismaService } from '../src/prisma/prisma.service';

describe('banking wallet ledger behaviour', () => {
  const userId = '00000000-0000-0000-0000-000000000001';

  it('credits the wallet and writes a deposit ledger entry after a successful provider deposit', async () => {
    const pendingPayment = {
      id: 'payment-id',
      userId,
      walletId: 'wallet-id',
      providerPaymentId: 'pending-id',
      paymentSourceId: null,
      status: BankingPaymentStatus.PENDING,
      amount: 500n,
      currency: 'GBP',
      settledAt: null,
    };
    const createTransaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-id' }]),
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'wallet-id', balance: 1_000n }),
      },
      bankingPayment: {
        create: jest.fn().mockResolvedValue(pendingPayment),
      },
    };
    const settleTransaction = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'payment-id' }])
        .mockResolvedValueOnce([{ id: 'wallet-id' }]),
      bankingPayment: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(pendingPayment),
        update: jest.fn().mockResolvedValue({
          id: 'payment-id',
          status: BankingPaymentStatus.SUCCEEDED,
          amount: 500n,
          currency: 'GBP',
        }),
      },
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'wallet-id', balance: 1_000n }),
        update: jest.fn(),
      },
      walletTransaction: { create: jest.fn() },
      externalBankAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: userId,
          email: 'player@example.test',
          username: 'player',
        }),
      },
      $transaction: jest
        .fn()
        .mockImplementationOnce(async (operation: (tx: typeof createTransaction) => unknown) =>
          operation(createTransaction),
        )
        .mockImplementationOnce(async (operation: (tx: typeof settleTransaction) => unknown) =>
          operation(settleTransaction),
        ),
    } as unknown as PrismaService;
    const provider = {
      createDeposit: jest.fn().mockResolvedValue({
        providerPaymentId: 'provider-payment-id',
        paymentSourceId: 'provider-source-id',
        status: BankingPaymentStatus.SUCCEEDED,
      }),
    };
    const audit = { create: jest.fn() };
    const manager = new BankingManager(prisma, audit as never, provider as never);

    const response = await manager.createDeposit(userId, { amount: 500 });

    expect(createTransaction.bankingPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId,
        walletId: 'wallet-id',
        amount: 500n,
        status: BankingPaymentStatus.PENDING,
      }),
    });
    expect(provider.createDeposit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        email: 'player@example.test',
        username: 'player',
        amount: 500n,
        localPaymentId: 'payment-id',
      }),
    );
    expect(settleTransaction.wallet.update).toHaveBeenCalledWith({
      where: { id: 'wallet-id' },
      data: { balance: 1_500n },
    });
    expect(settleTransaction.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: 'wallet-id',
        type: 'DEPOSIT',
        amount: 500n,
        balanceBefore: 1_000n,
        balanceAfter: 1_500n,
        referenceType: 'BANKING_PAYMENT',
        referenceId: 'payment-id',
      }),
    });
    expect(settleTransaction.bankingPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-id' },
      data: expect.objectContaining({
        providerPaymentId: 'provider-payment-id',
        paymentSourceId: 'provider-source-id',
        status: BankingPaymentStatus.SUCCEEDED,
      }),
    });
    expect(response).toEqual(expect.objectContaining({ id: 'payment-id', amount: '500', newBalance: '1500' }));
  });

  it('reserves wallet funds and writes a withdrawal ledger entry before a provider payout is settled', async () => {
    const reserveTransaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-id' }]),
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'wallet-id', balance: 1_000n }),
        update: jest.fn(),
      },
      bankingPayout: {
        create: jest.fn().mockResolvedValue({ id: 'payout-id' }),
      },
      walletTransaction: { create: jest.fn() },
    };
    const settleTransaction = {
      bankingPayout: {
        update: jest.fn().mockResolvedValue({
          id: 'payout-id',
          status: BankingPaymentStatus.SUCCEEDED,
          amount: 400n,
          currency: 'GBP',
        }),
      },
      externalBankAccount: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementationOnce(async (operation: (tx: typeof reserveTransaction) => unknown) =>
          operation(reserveTransaction),
        )
        .mockImplementationOnce(async (operation: (tx: typeof settleTransaction) => unknown) =>
          operation(settleTransaction),
        ),
    } as unknown as PrismaService;
    const provider = {
      createPayout: jest.fn().mockResolvedValue({
        providerPayoutId: 'provider-payout-id',
        status: BankingPaymentStatus.SUCCEEDED,
      }),
    };
    const audit = { create: jest.fn() };
    const manager = new BankingManager(prisma, audit as never, provider as never);

    const response = await manager.createPayout(userId, { amount: 400 });

    expect(reserveTransaction.wallet.update).toHaveBeenCalledWith({ where: { id: 'wallet-id' }, data: { balance: 600n } });
    expect(reserveTransaction.walletTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        walletId: 'wallet-id',
        type: 'WITHDRAWAL',
        amount: -400n,
        balanceBefore: 1_000n,
        balanceAfter: 600n,
        referenceType: 'BANKING_PAYOUT',
        referenceId: 'payout-id',
      }),
    });
    expect(settleTransaction.bankingPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-id' },
      data: expect.objectContaining({ providerPayoutId: 'provider-payout-id', status: BankingPaymentStatus.SUCCEEDED }),
    });
    expect(response).toEqual(expect.objectContaining({ id: 'payout-id', amount: '400', newBalance: '600' }));
  });
});
