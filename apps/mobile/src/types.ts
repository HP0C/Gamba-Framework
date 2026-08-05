export interface User {
  id: string;
  email: string;
  username: string;
}

export interface Wallet {
  balance: string;
  currency: string;
}

export interface BankConnection {
  id: string;
  provider: string;
  status: string;
  consentExpiresAt: string | null;
}

export interface BankAccount {
  id: string;
  displayName: string;
  accountType: string;
  currency: string;
  currentBalance: string;
}

export interface BankTransaction {
  id: string;
  amount: string;
  currency: string;
  direction: 'inbound' | 'outbound';
  description: string;
  merchantName: string | null;
  category: string | null;
  transactionAt: string;
}

export interface BankingOverview {
  mode: string;
  connections: BankConnection[];
  accounts: BankAccount[];
  transactions: BankTransaction[];
  payments: Array<{ id: string; amount: string; status: string }>;
  payouts: Array<{ id: string; amount: string; status: string }>;
}

export interface BankingConnectResult {
  authorizationUri?: string;
  overview: BankingOverview;
}

export interface BankingMoneyMovementResult {
  id: string;
  status: string;
  amount: string;
  currency: string;
  newBalance?: string;
  authorizationUri?: string;
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

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTtl: number;
  refreshTtl: number;
}
