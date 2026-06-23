import { Injectable } from '@nestjs/common';
import { minorUnits } from '../common/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { BetsManager } from './bets.manager';
import { PlaceCoinFlipDto } from './dto/place-coin-flip.dto';

@Injectable()
export class BetsService {
  constructor(private readonly manager: BetsManager, private readonly prisma: PrismaService) {}

  placeCoinFlip(userId: string, dto: PlaceCoinFlipDto) {
    return this.manager.placeCoinFlip(userId, dto);
  }

  async history(userId: string) {
    const bets = await this.prisma.bet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return bets.map((bet) => ({
      id: bet.id,
      gameType: bet.gameType.toLowerCase(),
      stake: minorUnits(bet.stake),
      selection: bet.selection,
      result: bet.result,
      payout: minorUnits(bet.payout),
      status: bet.status.toLowerCase(),
      serverSeedHash: bet.serverSeedHash,
      rngNonce: bet.rngNonce.toString(),
      createdAt: bet.createdAt,
      settledAt: bet.settledAt,
    }));
  }
}
