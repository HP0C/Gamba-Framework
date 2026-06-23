export type CoinFlipSelection = 'heads' | 'tails';

export interface FairRound {
  serverSeed: string;
  serverSeedHash: string;
  nonce: bigint;
  clientSeed?: string;
  result: CoinFlipSelection;
}
