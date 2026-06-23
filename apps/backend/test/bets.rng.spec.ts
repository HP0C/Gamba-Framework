import { createHash } from 'crypto';
import { BetsManager } from '../src/bets/bets.manager';

describe('BetsManager RNG helpers', () => {
  const manager = new BetsManager({} as never, {} as never);

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

  it('derives deterministic roulette numbers in the valid range', () => {
    const result = manager.deriveRouletteNumber('c'.repeat(64), 42n, 'client');
    expect(manager.deriveRouletteNumber('c'.repeat(64), 42n, 'client')).toBe(result);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(36);
  });

  it('maps roulette numbers to European roulette colours', () => {
    expect(manager.rouletteColourForNumber(0)).toBe('green');
    expect(manager.rouletteColourForNumber(1)).toBe('red');
    expect(manager.rouletteColourForNumber(2)).toBe('black');
  });

  it('creates a committed roulette round that can be verified after settlement', () => {
    const round = manager.createRouletteRound(7n, 'player-seed');
    expect(round.serverSeedHash).toBe(createHash('sha256').update(round.serverSeed).digest('hex'));
    expect(manager.deriveRouletteNumber(round.serverSeed, 7n, 'player-seed')).toBe(round.resultNumber);
    expect(round.result).toBe(`${round.resultNumber}:${round.resultColour}`);
  });
});
