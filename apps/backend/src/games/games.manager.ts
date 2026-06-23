import { Injectable } from '@nestjs/common';
import { createHash, createHmac, randomBytes } from 'crypto';
import { CoinFlipSelection, FairRound } from './types/coin-flip.types';

@Injectable()
export class GamesManager {
  createCoinFlipRound(nonce: bigint, clientSeed?: string): FairRound {
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
}
