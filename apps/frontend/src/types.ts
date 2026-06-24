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
  authorizationUri?: string;
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
  bankAccountId: string;
  amount: string;
  currency: string;
  direction: 'inbound' | 'outbound';
  description: string;
  merchantName: string | null;
  category: string | null;
  transactionAt: string;
}

export interface BankingPayment {
  id: string;
  amount: string;
  currency: string;
  status: string;
  providerPaymentId: string;
  sourceTransactionId: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface BankingPayout {
  id: string;
  amount: string;
  currency: string;
  status: string;
  providerPayoutId: string;
  createdAt: string;
  settledAt: string | null;
}

export interface BankingOverview {
  mode: string;
  connections: BankConnection[];
  accounts: BankAccount[];
  transactions: BankTransaction[];
  payments: BankingPayment[];
  payouts: BankingPayout[];
}

export interface BankingConnectResult {
  authorizationUri?: string;
  connection?: BankConnection;
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
