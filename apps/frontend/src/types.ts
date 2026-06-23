export interface User {
  id: string;
  email: string;
  username: string;
}

export interface Wallet {
  balance: string;
  currency: string;
}

export interface Bet {
  id: string;
  gameType: string;
  stake: string;
  selection: string;
  result: string | null;
  payout: string;
  status: string;
  createdAt: string;
}

export interface BetResult extends Bet {
  newBalance: string;
  serverSeedHash: string;
  serverSeed: string;
  rngNonce: string;
}
