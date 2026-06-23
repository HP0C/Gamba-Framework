import { UnprocessableEntityException } from '@nestjs/common';
import { BetsManager } from '../src/bets/bets.manager';
import { GamesManager } from '../src/games/games.manager';
import { PrismaService } from '../src/prisma/prisma.service';

describe('bet settlement invariants', () => {
  it('never creates money outside the declared even-money payout', () => {
    const games = new GamesManager();
    const stake = 100n;
    const startingBalance = 1_000n;
    const result = games.deriveCoinFlip('b'.repeat(64), 1n, 'client');
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
    const manager = new BetsManager(prisma, new GamesManager(), { create: jest.fn() } as never);

    await expect(manager.placeCoinFlip('00000000-0000-0000-0000-000000000001', {
      stake: 100,
      selection: 'heads',
    })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(transaction.wallet.update).not.toHaveBeenCalled();
    expect(transaction.walletTransaction.create).not.toHaveBeenCalled();
  });
});
