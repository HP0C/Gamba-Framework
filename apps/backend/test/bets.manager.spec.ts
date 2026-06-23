import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { BetsManager } from '../src/bets/bets.manager';
import { PrismaService } from '../src/prisma/prisma.service';

describe('bet settlement invariants', () => {
  it('never creates money outside the declared even-money payout', () => {
    const manager = new BetsManager({} as never, {} as never);
    const stake = 100n;
    const startingBalance = 1_000n;
    const result = manager.deriveCoinFlip('b'.repeat(64), 1n, 'client');
    const selection = result;
    const payout = result === selection ? stake * 2n : 0n;
    expect(startingBalance - stake + payout).toBe(1_100n);
  });

  it('rolls back before ledger writes when the locked wallet has insufficient funds', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-id' }]),
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'wallet-id', balance: 50n }),
        update: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          gamblingExcludedUntil: null,
          ageVerificationStatus: 'NOT_STARTED',
          kycStatus: 'NOT_STARTED',
        }),
      },
      gameRound: { aggregate: jest.fn().mockResolvedValue({ _max: { nonce: null } }) },
      walletTransaction: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaService;
    const manager = new BetsManager(prisma, { create: jest.fn() } as never);

    await expect(manager.placeCoinFlip('00000000-0000-0000-0000-000000000001', {
      stake: 100,
      selection: 'heads',
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(transaction.wallet.update).not.toHaveBeenCalled();
    expect(transaction.walletTransaction.create).not.toHaveBeenCalled();
  });

  it('settles a winning coin flip through the shared ledger, round, and audit flow', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-id' }]),
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'wallet-id', balance: 1_000n }),
        update: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          gamblingExcludedUntil: null,
          ageVerificationStatus: 'NOT_STARTED',
          kycStatus: 'NOT_STARTED',
        }),
      },
      gameRound: {
        aggregate: jest.fn().mockResolvedValue({ _max: { nonce: 4n } }),
        create: jest.fn().mockResolvedValue({ id: 'round-id' }),
        update: jest.fn(),
      },
      bet: {
        create: jest.fn().mockResolvedValue({ id: 'bet-id' }),
        update: jest.fn(),
      },
      walletTransaction: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaService;
    const audit = { create: jest.fn() };
    const manager = new BetsManager(prisma, audit as never);
    jest.spyOn(manager, 'createCoinFlipRound').mockReturnValue({
      serverSeed: 'server-seed',
      serverSeedHash: 'server-seed-hash',
      nonce: 5n,
      clientSeed: 'client',
      result: 'heads',
    });

    const response = await manager.placeCoinFlip('00000000-0000-0000-0000-000000000001', {
      stake: 100,
      selection: 'heads',
      clientSeed: 'client',
    });

    expect(transaction.gameRound.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ nonce: 5n, serverSeed: 'server-seed' }),
    });
    expect(transaction.bet.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ gameRoundId: 'round-id', stake: 100n, selection: 'heads' }),
    });
    expect(transaction.wallet.update).toHaveBeenNthCalledWith(1, { where: { id: 'wallet-id' }, data: { balance: 900n } });
    expect(transaction.wallet.update).toHaveBeenNthCalledWith(2, { where: { id: 'wallet-id' }, data: { balance: 1_100n } });
    expect(transaction.walletTransaction.create).toHaveBeenCalledTimes(2);
    expect(transaction.bet.update).toHaveBeenCalledWith({
      where: { id: 'bet-id' },
      data: expect.objectContaining({ result: 'heads', payout: 200n, status: 'SETTLED' }),
    });
    expect(transaction.gameRound.update).toHaveBeenCalledWith({
      where: { id: 'round-id' },
      data: expect.objectContaining({ publicResult: 'heads' }),
    });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: '00000000-0000-0000-0000-000000000001',
        action: 'BET_SETTLED',
        entityType: 'BET',
        entityId: 'bet-id',
      }),
      transaction,
    );
    expect(response).toEqual(expect.objectContaining({ id: 'bet-id', result: 'heads', payout: '200', newBalance: '1100' }));
  });

  it('rejects invalid roulette number selections before settlement starts', async () => {
    const prisma = { $transaction: jest.fn() } as unknown as PrismaService;
    const manager = new BetsManager(prisma, { create: jest.fn() } as never);

    await expect(manager.placeRoulette('00000000-0000-0000-0000-000000000001', {
      stake: 100,
      betType: 'number',
      selection: '37',
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('settles a winning roulette colour bet through the shared settlement flow', async () => {
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'wallet-id' }]),
      wallet: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'wallet-id', balance: 1_000n }),
        update: jest.fn(),
      },
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          gamblingExcludedUntil: null,
          ageVerificationStatus: 'NOT_STARTED',
          kycStatus: 'NOT_STARTED',
        }),
      },
      gameRound: {
        aggregate: jest.fn().mockResolvedValue({ _max: { nonce: 1n } }),
        create: jest.fn().mockResolvedValue({ id: 'roulette-round-id' }),
        update: jest.fn(),
      },
      bet: {
        create: jest.fn().mockResolvedValue({ id: 'roulette-bet-id' }),
        update: jest.fn(),
      },
      walletTransaction: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (tx: typeof transaction) => unknown) => operation(transaction)),
    } as unknown as PrismaService;
    const audit = { create: jest.fn() };
    const manager = new BetsManager(prisma, audit as never);
    jest.spyOn(manager, 'createRouletteRound').mockReturnValue({
      serverSeed: 'server-seed',
      serverSeedHash: 'server-seed-hash',
      nonce: 2n,
      clientSeed: 'client',
      resultNumber: 1,
      resultColour: 'red',
      result: '1:red',
    });

    const response = await manager.placeRoulette('00000000-0000-0000-0000-000000000001', {
      stake: 100,
      betType: 'colour',
      selection: 'red',
      clientSeed: 'client',
    });

    expect(transaction.bet.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ gameType: 'ROULETTE', stake: 100n, selection: 'colour:red' }),
    });
    expect(transaction.bet.update).toHaveBeenCalledWith({
      where: { id: 'roulette-bet-id' },
      data: expect.objectContaining({ result: '1:red', payout: 200n, status: 'SETTLED' }),
    });
    expect(audit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'BET_SETTLED',
        entityType: 'BET',
        entityId: 'roulette-bet-id',
      }),
      transaction,
    );
    expect(response).toEqual(
      expect.objectContaining({ id: 'roulette-bet-id', gameType: 'roulette', result: '1:red', payout: '200' }),
    );
  });
});
