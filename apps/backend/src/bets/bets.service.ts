import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BetsManager } from './bets.manager';
import { PlaceCoinFlipDto } from './dto/place-coin-flip.dto';
import { PlaceRouletteDto } from './dto/place-roulette.dto';

@Injectable()
export class BetsService {
  constructor(private readonly manager: BetsManager, private readonly prisma: PrismaService) {}

  placeCoinFlip(userId: string, dto: PlaceCoinFlipDto) {
    return this.manager.placeCoinFlip(userId, dto);
  }

  placeRoulette(userId: string, dto: PlaceRouletteDto) {
    return this.manager.placeRoulette(userId, dto);
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
      stake: bet.stake.toString(),
      selection: bet.selection,
      result: bet.result,
      payout: bet.payout.toString(),
      status: bet.status.toLowerCase(),
      serverSeedHash: bet.serverSeedHash,
      rngNonce: bet.rngNonce.toString(),
      createdAt: bet.createdAt,
      settledAt: bet.settledAt,
    }));
  }
}
