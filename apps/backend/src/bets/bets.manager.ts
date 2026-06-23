import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BetStatus, GameType, Prisma, UserStatus, WalletTransactionType } from '@prisma/client';
import { AuditManager } from '../audit/audit.manager';
import { minorUnits } from '../common/serialize';
import { GamesManager } from '../games/games.manager';
import { PrismaService } from '../prisma/prisma.service';
import { PlaceCoinFlipDto } from './dto/place-coin-flip.dto';

@Injectable()
export class BetsManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly games: GamesManager,
    private readonly audit: AuditManager,
  ) {}

  async placeCoinFlip(userId: string, dto: PlaceCoinFlipDto) {
    const stake = BigInt(dto.stake);
    return this.withSerializationRetry(() =>
      this.prisma.$transaction(
        async (tx) => {
          // The row lock serializes all balance-changing bets for this wallet.
          const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id" FROM "Wallet"
            WHERE "userId" = ${userId}::uuid AND "currency" = 'GBP'
            FOR UPDATE
          `);
          if (!locked[0]) throw new NotFoundException('Wallet not found');

          const [wallet, user, nonceAggregate] = await Promise.all([
            tx.wallet.findUniqueOrThrow({ where: { id: locked[0].id } }),
            tx.user.findUniqueOrThrow({ where: { id: userId } }),
            tx.gameRound.aggregate({
              where: { userId, gameType: GameType.COIN_FLIP },
              _max: { nonce: true },
            }),
          ]);
          this.assertWageringAllowed(user);
          if (wallet.balance < stake) throw new UnprocessableEntityException('Insufficient balance');

          const nonce = (nonceAggregate._max.nonce ?? 0n) + 1n;
          const fairRound = this.games.createCoinFlipRound(nonce, dto.clientSeed);
          // Encrypt or externalize server seeds with a managed key/HSM before production.
          const gameRound = await tx.gameRound.create({
            data: {
              userId,
              gameType: GameType.COIN_FLIP,
              serverSeed: fairRound.serverSeed,
              serverSeedHash: fairRound.serverSeedHash,
              clientSeed: fairRound.clientSeed,
              nonce,
            },
          });
          const bet = await tx.bet.create({
            data: {
              userId,
              gameRoundId: gameRound.id,
              gameType: GameType.COIN_FLIP,
              stake,
              selection: dto.selection,
              rngNonce: nonce,
              serverSeedHash: fairRound.serverSeedHash,
              clientSeed: fairRound.clientSeed,
            },
          });

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
              referenceId: bet.id,
            },
          });

          const payout = fairRound.result === dto.selection ? stake * 2n : 0n;
          const finalBalance = afterStake + payout;
          if (payout > 0n) {
            await tx.wallet.update({ where: { id: wallet.id }, data: { balance: finalBalance } });
            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: WalletTransactionType.BET_PAYOUT,
                amount: payout,
                balanceBefore: afterStake,
                balanceAfter: finalBalance,
                referenceType: 'BET',
                referenceId: bet.id,
              },
            });
          }

          const settledAt = new Date();
          await Promise.all([
            tx.bet.update({
              where: { id: bet.id },
              data: { result: fairRound.result, payout, status: BetStatus.SETTLED, settledAt },
            }),
            tx.gameRound.update({
              where: { id: gameRound.id },
              data: { publicResult: fairRound.result, settledAt },
            }),
            this.audit.create(
              {
                userId,
                action: 'BET_SETTLED',
                entityType: 'BET',
                entityId: bet.id,
                metadata: {
                  gameType: 'COIN_FLIP',
                  stake: stake.toString(),
                  payout: payout.toString(),
                  serverSeedHash: fairRound.serverSeedHash,
                  nonce: nonce.toString(),
                },
              },
              tx,
            ),
          ]);

          return {
            id: bet.id,
            gameType: 'coin_flip',
            selection: dto.selection,
            result: fairRound.result,
            stake: minorUnits(stake),
            payout: minorUnits(payout),
            newBalance: minorUnits(finalBalance),
            serverSeedHash: fairRound.serverSeedHash,
            serverSeed: fairRound.serverSeed,
            rngNonce: nonce.toString(),
            settledAt,
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      ),
    );
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
