import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BetStatus, GameType, Prisma, UserStatus, WalletTransactionType } from '@prisma/client';
import { createHash, createHmac, randomBytes } from 'crypto';
import { AuditManager } from '../audit/audit.manager';
import { PrismaService } from '../prisma/prisma.service';
import { PlaceCoinFlipDto } from './dto/place-coin-flip.dto';
import { PlaceRouletteDto } from './dto/place-roulette.dto';

export type CoinFlipSelection = 'heads' | 'tails';
export type RouletteBetType = 'number' | 'colour';
export type RouletteColour = 'red' | 'black' | 'green';

const ROULETTE_GAME_TYPE = 'ROULETTE' as GameType;
const ROULETTE_RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const ROULETTE_OUTCOMES = 37;
const UINT32_RANGE = 0x1_0000_0000;
const ROULETTE_REJECTION_LIMIT = Math.floor(UINT32_RANGE / ROULETTE_OUTCOMES) * ROULETTE_OUTCOMES;

export interface FairCoinFlipRound {
  serverSeed: string;
  serverSeedHash: string;
  nonce: bigint;
  clientSeed?: string;
  result: CoinFlipSelection;
}

export interface FairRouletteRound {
  serverSeed: string;
  serverSeedHash: string;
  nonce: bigint;
  clientSeed?: string;
  resultNumber: number;
  resultColour: RouletteColour;
  result: string;
}

interface RouletteSelection {
  betType: RouletteBetType;
  selection: number | RouletteColour;
  display: string;
}

interface ResolvedGame {
  result: string;
  payout: bigint;
  serverSeed: string;
  serverSeedHash: string;
  clientSeed?: string;
}

interface SettleBetInput {
  userId: string;
  gameType: GameType;
  stake: bigint;
  selection: string;
  clientSeed?: string;
  resolveGame: (context: { nonce: bigint; clientSeed?: string }) => ResolvedGame;
}

@Injectable()
export class BetsManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditManager,
  ) {}

  async placeCoinFlip(userId: string, dto: PlaceCoinFlipDto) {
    const stake = BigInt(dto.stake);
    return this.settleBet({
      userId,
      gameType: GameType.COIN_FLIP,
      stake,
      selection: dto.selection,
      clientSeed: dto.clientSeed,
      resolveGame: ({ nonce, clientSeed }) => {
        const fairRound = this.createCoinFlipRound(nonce, clientSeed);
        const payout = fairRound.result === dto.selection ? stake * 2n : 0n;

        return {
          result: fairRound.result,
          payout,
          serverSeed: fairRound.serverSeed,
          serverSeedHash: fairRound.serverSeedHash,
          clientSeed: fairRound.clientSeed,
        };
      },
    });
  }

  async placeRoulette(userId: string, dto: PlaceRouletteDto) {
    const stake = BigInt(dto.stake);
    const selection = this.normaliseRouletteSelection(dto);

    return this.settleBet({
      userId,
      gameType: ROULETTE_GAME_TYPE,
      stake,
      selection: selection.display,
      clientSeed: dto.clientSeed,
      resolveGame: ({ nonce, clientSeed }) => {
        const fairRound = this.createRouletteRound(nonce, clientSeed);
        const payout = this.calculateRoulettePayout(stake, selection, fairRound);

        return {
          result: fairRound.result,
          payout,
          serverSeed: fairRound.serverSeed,
          serverSeedHash: fairRound.serverSeedHash,
          clientSeed: fairRound.clientSeed,
        };
      },
    });
  }

  createCoinFlipRound(nonce: bigint, clientSeed?: string): FairCoinFlipRound {
    const serverSeed = randomBytes(32).toString('hex');
    const serverSeedHash = createHash('sha256').update(serverSeed).digest('hex');
    const result = this.deriveCoinFlip(serverSeed, nonce, clientSeed);
    return { serverSeed, serverSeedHash, nonce, clientSeed, result };
  }

  deriveCoinFlip(serverSeed: string, nonce: bigint, clientSeed?: string): CoinFlipSelection {
    const digest = createHmac('sha256', serverSeed)
      .update(`${clientSeed ?? ''}:${nonce.toString()}`)
      .digest();
    const headsOdds = 30;
    const value = digest.readUInt32BE(0);
    const bucket = value % 100;

    return bucket < headsOdds ? 'heads' : 'tails';
  }

  createRouletteRound(nonce: bigint, clientSeed?: string): FairRouletteRound {
    const serverSeed = randomBytes(32).toString('hex');
    const serverSeedHash = createHash('sha256').update(serverSeed).digest('hex');
    const resultNumber = this.deriveRouletteNumber(serverSeed, nonce, clientSeed);
    const resultColour = this.rouletteColourForNumber(resultNumber);
    return {
      serverSeed,
      serverSeedHash,
      nonce,
      clientSeed,
      resultNumber,
      resultColour,
      result: `${resultNumber}:${resultColour}`,
    };
  }

  deriveRouletteNumber(serverSeed: string, nonce: bigint, clientSeed?: string): number {
    for (let counter = 0; ; counter += 1) {
      const digest = createHmac('sha256', serverSeed)
        .update(`roulette:${clientSeed ?? ''}:${nonce.toString()}:${counter}`)
        .digest();

      for (let offset = 0; offset <= digest.length - 4; offset += 4) {
        const value = digest.readUInt32BE(offset);
        if (value < ROULETTE_REJECTION_LIMIT) return value % ROULETTE_OUTCOMES;
      }
    }
  }

  rouletteColourForNumber(number: number): RouletteColour {
    if (number === 0) return 'green';
    return ROULETTE_RED_NUMBERS.has(number) ? 'red' : 'black';
  }

  private settleBet(input: SettleBetInput) {
    return this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          const wallet = await this.lockWallet(tx, input.userId);
          const [user, nonce] = await Promise.all([
            tx.user.findUniqueOrThrow({ where: { id: input.userId } }),
            this.nextNonce(tx, input.userId, input.gameType),
          ]);
          this.assertWageringAllowed(user);
          if (wallet.balance < input.stake) throw new UnprocessableEntityException('Insufficient balance');

          const resolvedGame = input.resolveGame({ nonce, clientSeed: input.clientSeed });
          if (resolvedGame.payout < 0n) throw new Error('Resolved game produced a negative payout');
          const gameRound = await this.createGameRound(tx, input, nonce, resolvedGame);
          const bet = await this.createPendingBet(tx, input, nonce, gameRound.id, resolvedGame);
          const afterStake = await this.applyStake(tx, wallet, input.stake, bet.id);
          const finalBalance = await this.applyPayout(tx, wallet.id, afterStake, resolvedGame.payout, bet.id);
          const settledAt = await this.settleRecordsAndAudit(tx, input, bet.id, gameRound.id, nonce, resolvedGame);

          return this.formatSettledBet(input, bet.id, nonce, finalBalance, settledAt, resolvedGame);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
  }

  private async lockWallet(tx: Prisma.TransactionClient, userId: string) {
    // The row lock serializes all balance-changing bets for this wallet.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "Wallet"
      WHERE "userId" = ${userId}::uuid AND "currency" = 'GBP'
      FOR UPDATE
    `);
    if (!locked[0]) throw new NotFoundException('Wallet not found');
    return tx.wallet.findUniqueOrThrow({ where: { id: locked[0].id } });
  }

  private async nextNonce(tx: Prisma.TransactionClient, userId: string, gameType: GameType) {
    const nonceAggregate = await tx.gameRound.aggregate({
      where: { userId, gameType },
      _max: { nonce: true },
    });
    return (nonceAggregate._max.nonce ?? 0n) + 1n;
  }

  private createGameRound(
    tx: Prisma.TransactionClient,
    input: SettleBetInput,
    nonce: bigint,
    resolvedGame: ResolvedGame,
  ) {
    // Encrypt or externalize server seeds with a managed key/HSM before production.
    return tx.gameRound.create({
      data: {
        userId: input.userId,
        gameType: input.gameType,
        serverSeed: resolvedGame.serverSeed,
        serverSeedHash: resolvedGame.serverSeedHash,
        clientSeed: resolvedGame.clientSeed,
        nonce,
      },
    });
  }

  private createPendingBet(
    tx: Prisma.TransactionClient,
    input: SettleBetInput,
    nonce: bigint,
    gameRoundId: string,
    resolvedGame: ResolvedGame,
  ) {
    return tx.bet.create({
      data: {
        userId: input.userId,
        gameRoundId,
        gameType: input.gameType,
        stake: input.stake,
        selection: input.selection,
        rngNonce: nonce,
        serverSeedHash: resolvedGame.serverSeedHash,
        clientSeed: resolvedGame.clientSeed,
      },
    });
  }

  private async applyStake(
    tx: Prisma.TransactionClient,
    wallet: { id: string; balance: bigint },
    stake: bigint,
    betId: string,
  ) {
    const afterStake = wallet.balance - stake;
    await tx.wallet.update({ where: { id: wallet.id }, data: { balance: afterStake } });
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: WalletTransactionType.BET_STAKE,
        amount: -stake,
        balanceBefore: wallet.balance,
        balanceAfter: afterStake,
        referenceType: 'BET',
        referenceId: betId,
      },
    });
    return afterStake;
  }

  private async applyPayout(
    tx: Prisma.TransactionClient,
    walletId: string,
    balanceBeforePayout: bigint,
    payout: bigint,
    betId: string,
  ) {
    const finalBalance = balanceBeforePayout + payout;
    if (payout > 0n) {
      await tx.wallet.update({ where: { id: walletId }, data: { balance: finalBalance } });
      await tx.walletTransaction.create({
        data: {
          walletId,
          type: WalletTransactionType.BET_PAYOUT,
          amount: payout,
          balanceBefore: balanceBeforePayout,
          balanceAfter: finalBalance,
          referenceType: 'BET',
          referenceId: betId,
        },
      });
    }
    return finalBalance;
  }

  private async settleRecordsAndAudit(
    tx: Prisma.TransactionClient,
    input: SettleBetInput,
    betId: string,
    gameRoundId: string,
    nonce: bigint,
    resolvedGame: ResolvedGame,
  ) {
    const settledAt = new Date();
    await Promise.all([
      tx.bet.update({
        where: { id: betId },
        data: { result: resolvedGame.result, payout: resolvedGame.payout, status: BetStatus.SETTLED, settledAt },
      }),
      tx.gameRound.update({
        where: { id: gameRoundId },
        data: { publicResult: resolvedGame.result, settledAt },
      }),
      this.audit.create(
        {
          userId: input.userId,
          action: 'BET_SETTLED',
          entityType: 'BET',
          entityId: betId,
          metadata: {
            gameType: input.gameType,
            stake: input.stake.toString(),
            payout: resolvedGame.payout.toString(),
            serverSeedHash: resolvedGame.serverSeedHash,
            nonce: nonce.toString(),
          },
        },
        tx,
      ),
    ]);
    return settledAt;
  }

  private formatSettledBet(
    input: SettleBetInput,
    betId: string,
    nonce: bigint,
    finalBalance: bigint,
    settledAt: Date,
    resolvedGame: ResolvedGame,
  ) {
    return {
      id: betId,
      gameType: input.gameType.toLowerCase(),
      selection: input.selection,
      result: resolvedGame.result,
      stake: input.stake.toString(),
      payout: resolvedGame.payout.toString(),
      newBalance: finalBalance.toString(),
      serverSeedHash: resolvedGame.serverSeedHash,
      serverSeed: resolvedGame.serverSeed,
      rngNonce: nonce.toString(),
      settledAt,
    };
  }

  private normaliseRouletteSelection(dto: PlaceRouletteDto): RouletteSelection {
    const selection = dto.selection.trim().toLowerCase();

    if (dto.betType === 'number') {
      if (!/^\d+$/.test(selection)) throw new BadRequestException('Roulette number selection must be 0-36');
      const selectedNumber = Number(selection);
      if (!Number.isInteger(selectedNumber) || selectedNumber < 0 || selectedNumber > 36) {
        throw new BadRequestException('Roulette number selection must be 0-36');
      }
      return { betType: 'number', selection: selectedNumber, display: `number:${selectedNumber}` };
    }

    if (!['red', 'black', 'green'].includes(selection)) {
      throw new BadRequestException('Roulette colour selection must be red, black, or green');
    }
    return { betType: 'colour', selection: selection as RouletteColour, display: `colour:${selection}` };
  }

  private calculateRoulettePayout(
    stake: bigint,
    selection: RouletteSelection,
    round: Pick<FairRouletteRound, 'resultNumber' | 'resultColour'>,
  ): bigint {
    if (selection.betType === 'number') {
      return round.resultNumber === selection.selection ? stake * 36n : 0n;
    }

    if (round.resultColour !== selection.selection) return 0n;
    return selection.selection === 'green' ? stake * 36n : stake * 2n;
  }

  private assertWageringAllowed(user: {
    status: UserStatus;
    gamblingExcludedUntil: Date | null;
    ageVerificationStatus: string;
    kycStatus: string;
  }): void {
    if (user.status !== UserStatus.ACTIVE) throw new ForbiddenException('Account is not active');
    if (user.gamblingExcludedUntil && user.gamblingExcludedUntil > new Date()) {
      throw new ForbiddenException('Account is currently excluded from gambling');
    }
    // Production policy must enforce age, identity/KYC, jurisdiction, AML, limits,
    // affordability/responsible-gambling controls, and fraud/risk decisions here.
    void user.ageVerificationStatus;
    void user.kycStatus;
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
