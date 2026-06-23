import { createHash } from 'crypto';
import { GamesManager } from '../src/games/games.manager';

describe('GamesManager', () => {
  const manager = new GamesManager();

  it('creates a committed coin flip that can be verified after settlement', () => {
    const round = manager.createCoinFlipRound(7n, 'player-seed');
    expect(round.serverSeedHash).toBe(createHash('sha256').update(round.serverSeed).digest('hex'));
    expect(manager.deriveCoinFlip(round.serverSeed, 7n, 'player-seed')).toBe(round.result);
    expect(['heads', 'tails']).toContain(round.result);
  });

  it('is deterministic for the same seed, nonce, and client seed', () => {
    const result = manager.deriveCoinFlip('a'.repeat(64), 42n, 'client');
    expect(manager.deriveCoinFlip('a'.repeat(64), 42n, 'client')).toBe(result);
  });
});
