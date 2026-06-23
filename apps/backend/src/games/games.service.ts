import { Injectable } from '@nestjs/common';
import { GamesManager } from './games.manager';

@Injectable()
export class GamesService {
  constructor(private readonly manager: GamesManager) {}

  createCoinFlipRound(nonce: bigint, clientSeed?: string) {
    return this.manager.createCoinFlipRound(nonce, clientSeed);
  }
}
