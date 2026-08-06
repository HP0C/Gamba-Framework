import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL, api } from './api';
import {
  BankTransaction,
  BankingConnectResult,
  BankingMoneyMovementResult,
  BankingOverview,
  Bet,
  BetResult,
  User,
  Wallet,
} from './types';

type AppPage = 'connect' | 'transactions' | 'bet';
type GameChoice = 'coin_flip' | 'roulette';
type RouletteBetType = 'number' | 'colour';

interface AccountSnapshot {
  user: User;
  wallet: Wallet;
  banking: BankingOverview;
  bets: Bet[];
}

const PENDING_STAKE_KEY = 'gamba.pendingStake';
const PAYMENT_REFRESH_ATTEMPTS = 6;
const PAYMENT_REFRESH_DELAY_MS = 1_500;

function hasBankingConnection(banking: BankingOverview | null | undefined): boolean {
  return Boolean(
    banking?.accounts.length ||
      banking?.transactions.length ||
      banking?.connections.some((connection) => connection.status === 'active'),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatMinor(value: string, currency = 'GBP'): string {
  const minor = BigInt(value);
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${currency === 'GBP' ? 'GBP ' : `${currency} `}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function absoluteMinor(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

function isPositiveMinor(value: string): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [banking, setBanking] = useState<BankingOverview | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [message, setMessage] = useState('');
  const [page, setPage] = useState<AppPage>('connect');
  const [selectedStake, setSelectedStake] = useState('');
  const [stakeSourceTransactionId, setStakeSourceTransactionId] = useState<string | undefined>();
  const [stakeEditorOpen, setStakeEditorOpen] = useState(false);
  const [selectedGame, setSelectedGame] = useState<GameChoice>('coin_flip');
  const [rouletteBetType, setRouletteBetType] = useState<RouletteBetType>('colour');

  const loadAccount = useCallback(
    async (
      options: { refreshBanking?: boolean; refreshPayments?: boolean } = {},
    ): Promise<AccountSnapshot | null> => {
    try {
      const [currentUser, initialBanking] = await Promise.all([
        api.get<User>('/auth/me'),
        api.get<BankingOverview>('/banking'),
      ]);
      let bankingOverview = initialBanking;

      if (hasBankingConnection(bankingOverview)) {
        if (options.refreshPayments) {
          bankingOverview = await api
            .post<BankingOverview>('/banking/deposits/refresh')
            .catch(() => bankingOverview);
        }
        if (options.refreshBanking) {
          bankingOverview = await api.post<BankingOverview>('/banking/sync').catch(() => bankingOverview);
        }
      }

      const [currentWallet, history] = await Promise.all([api.get<Wallet>('/wallet'), api.get<Bet[]>('/bets')]);
      setUser(currentUser);
      setWallet(currentWallet);
      setBanking(bankingOverview);
      setBets(history);
      return { user: currentUser, wallet: currentWallet, banking: bankingOverview, bets: history };
    } catch {
      setUser(null);
      setWallet(null);
      setBanking(null);
      setBets([]);
      setPage('connect');
      return null;
    }
  },
    [],
  );

  useEffect(() => void loadAccount({ refreshBanking: true, refreshPayments: true }), [loadAccount]);

  const hasOpenBankingConnection = useMemo(() => hasBankingConnection(banking), [banking]);

  const currentAccount = banking?.accounts[0];
  const walletBalance = wallet?.balance ?? '0';
  const selectedStakeTransaction = stakeSourceTransactionId
    ? banking?.transactions.find((transaction) => transaction.id === stakeSourceTransactionId)
    : undefined;

  useEffect(() => {
    if (!user || page === 'bet') return;
    setPage(hasOpenBankingConnection ? 'transactions' : 'connect');
  }, [hasOpenBankingConnection, page, user]);

  useEffect(() => {
    if (page !== 'transactions') setStakeEditorOpen(false);
  }, [page]);

  useEffect(() => {
    if (!user?.id || page !== 'transactions') return;
    let cancelled = false;

    async function refreshTransactionsPage() {
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
      const pendingStake = sessionStorage.getItem(PENDING_STAKE_KEY);
      if (!cancelled && pendingStake && snapshot && isPositiveMinor(snapshot.wallet.balance)) {
        sessionStorage.removeItem(PENDING_STAKE_KEY);
        setSelectedStake(pendingStake);
        setPage('bet');
        setMessage('Payment settled. Choose a game to continue.');
      }
    }

    void refreshTransactionsPage();
    return () => {
      cancelled = true;
    };
  }, [loadAccount, page, user?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bankingStatus = params.get('banking');
    const paymentStatus = params.get('payment');
    if (!bankingStatus && !paymentStatus) return;

    async function handleReturn() {
      if (bankingStatus) {
        if (bankingStatus === 'connected') {
          try {
            await loadAccount({ refreshBanking: true, refreshPayments: true });
            setPage('transactions');
            setMessage('Open Banking connected. Choose an amount to stake.');
          } catch (error) {
            await loadAccount({ refreshBanking: true, refreshPayments: true });
            setPage('transactions');
            setMessage(error instanceof Error ? error.message : 'Open Banking connected, but transactions could not sync yet.');
          }
        } else {
          setMessage('Open Banking authorisation did not complete.');
        }
      }

      if (paymentStatus) {
        if (paymentStatus === 'succeeded') {
          const pendingStake = sessionStorage.getItem(PENDING_STAKE_KEY);
          const snapshot = await waitForSettledDeposit();
          if (snapshot && isPositiveMinor(snapshot.wallet.balance)) {
            sessionStorage.removeItem(PENDING_STAKE_KEY);
            setSelectedStake(pendingStake ?? snapshot.wallet.balance);
            setPage('bet');
            setMessage('Stake deposited into your betting wallet. Choose a game to continue.');
          } else {
            setPage('transactions');
            setMessage('The deposit is still processing. The app will check again automatically when this page refreshes.');
          }
        } else if (paymentStatus === 'pending') {
          const snapshot = await waitForSettledDeposit();
          if (snapshot && isPositiveMinor(snapshot.wallet.balance)) {
            const pendingStake = sessionStorage.getItem(PENDING_STAKE_KEY);
            sessionStorage.removeItem(PENDING_STAKE_KEY);
            setSelectedStake(pendingStake ?? snapshot.wallet.balance);
            setPage('bet');
            setMessage('Payment settled. Choose a game to continue.');
          } else {
            setPage('transactions');
            setMessage('The deposit is still processing. The app will check again automatically when this page refreshes.');
          }
        } else {
          sessionStorage.removeItem(PENDING_STAKE_KEY);
          await loadAccount({ refreshBanking: true, refreshPayments: true });
          setPage('transactions');
          setMessage('The deposit could not be completed.');
        }
      }

      window.history.replaceState({}, document.title, window.location.pathname);
    }

    void handleReturn();
  }, [loadAccount]);

  async function authenticate(path: '/auth/register' | '/auth/login', form: HTMLFormElement) {
    setMessage('');
    const data = Object.fromEntries(new FormData(form));
    try {
      const snapshot = await api.post<{ user: User }>(path, data);
      form.reset();
      setUser(snapshot.user);
      const account = await loadAccount({ refreshBanking: true, refreshPayments: true });
      setPage(account && hasBankingConnection(account.banking) ? 'transactions' : 'connect');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  async function logout() {
    await api.post('/auth/logout');
    sessionStorage.removeItem(PENDING_STAKE_KEY);
    setUser(null);
    setWallet(null);
    setBanking(null);
    setBets([]);
    setSelectedStake('');
    setStakeSourceTransactionId(undefined);
    setStakeEditorOpen(false);
    setPage('connect');
  }

  async function connectBank() {
    setMessage('');
    try {
      const result = await api.post<BankingConnectResult>('/banking/connect');
      setBanking(result.overview);
      if (result.authorizationUri) {
        window.location.assign(result.authorizationUri);
        return;
      }
      await loadAccount({ refreshBanking: true, refreshPayments: true });
      setPage('transactions');
      setMessage('Open Banking connected. Choose an amount to stake.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not connect Open Banking');
    }
  }

  async function waitForSettledDeposit(): Promise<AccountSnapshot | null> {
    for (let attempt = 0; attempt < PAYMENT_REFRESH_ATTEMPTS; attempt += 1) {
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
      if (snapshot && isPositiveMinor(snapshot.wallet.balance)) return snapshot;
      if (attempt < PAYMENT_REFRESH_ATTEMPTS - 1) await sleep(PAYMENT_REFRESH_DELAY_MS);
    }
    return null;
  }

  function chooseTransactionStake(transaction: BankTransaction) {
    setSelectedStake(absoluteMinor(transaction.amount));
    setStakeSourceTransactionId(transaction.id);
    setStakeEditorOpen(true);
    setMessage('');
  }

  function clearSelectedStake() {
    setSelectedStake('');
    setStakeSourceTransactionId(undefined);
    setStakeEditorOpen(false);
  }

  async function proceedToBet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    if (!isPositiveMinor(selectedStake)) {
      setMessage('Choose a stake amount first.');
      return;
    }

    try {
      const result = await api.post<BankingMoneyMovementResult>('/banking/deposits', {
        amount: Number(selectedStake),
        sourceTransactionId: stakeSourceTransactionId,
      });
      sessionStorage.setItem(PENDING_STAKE_KEY, selectedStake);
      setStakeEditorOpen(false);

      if (result.authorizationUri) {
        setMessage('Redirecting to Open Banking payment authorisation...');
        window.location.assign(result.authorizationUri);
        return;
      }

      if (result.newBalance) {
        setWallet((current) => current && { ...current, balance: result.newBalance ?? current.balance });
      }
      const snapshot = result.newBalance ? await loadAccount({ refreshBanking: true, refreshPayments: true }) : await waitForSettledDeposit();
      if (snapshot && isPositiveMinor(snapshot.wallet.balance)) {
        setPage('bet');
        setMessage('Stake deposited into your betting wallet. Choose a game to continue.');
      } else {
        setPage('transactions');
        setMessage('The deposit is still processing. The app will keep checking automatically when you return here.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Deposit failed');
    }
  }

  async function placeBet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');

    if (!isPositiveMinor(walletBalance)) {
      setMessage('Your betting wallet has no funds. Choose a stake from your current account first.');
      setPage('transactions');
      return;
    }

    const form = event.currentTarget;
    const data = new FormData(form);
    const clientSeed = data.get('clientSeed') || undefined;

    try {
      const result =
        selectedGame === 'coin_flip'
          ? await api.post<BetResult>('/bets/coin-flip', {
              stake: Number(walletBalance),
              selection: data.get('selection'),
              clientSeed,
            })
          : await api.post<BetResult>('/bets/roulette', {
              stake: Number(walletBalance),
              betType: data.get('betType'),
              selection: data.get('selection'),
              clientSeed,
            });

      setWallet((current) => current && { ...current, balance: result.newBalance });

      let payoutMessage = '';
      if (isPositiveMinor(result.newBalance)) {
        const payout = await api.post<BankingMoneyMovementResult>('/banking/payouts', {
          amount: Number(result.newBalance),
        });
        payoutMessage = ` ${formatMinor(payout.amount, payout.currency)} was paid back to your current account.`;
      }

      form.reset();
      setRouletteBetType('colour');
      setSelectedStake('');
      setStakeSourceTransactionId(undefined);
      setStakeEditorOpen(false);
      await loadAccount({ refreshBanking: true, refreshPayments: true });
      setPage('transactions');
      setMessage(`Result: ${result.result}. Payout: ${formatMinor(result.payout)}.${payoutMessage}`);
    } catch (error) {
      await loadAccount({ refreshBanking: true, refreshPayments: true });
      setMessage(error instanceof Error ? error.message : 'Bet failed');
    }
  }

  function returnToTransactions() {
    setPage('transactions');
    void loadAccount({ refreshBanking: true, refreshPayments: true });
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Open Banking betting flow</p>
          <h1>Gamba</h1>
        </div>
        {user && <button onClick={() => void logout()}>Log out</button>}
      </header>

      {message && <p className="message" role="status">{message}</p>}

      {!user ? (
        <section className="auth-grid">
          <form onSubmit={(event) => { event.preventDefault(); void authenticate('/auth/register', event.currentTarget); }}>
            <h2>Create account</h2>
            <label>Email<input name="email" type="email" required /></label>
            <label>Username<input name="username" minLength={3} required /></label>
            <label>Password<input name="password" type="password" minLength={12} required /></label>
            <button type="submit">Register</button>
          </form>
          <form onSubmit={(event) => { event.preventDefault(); void authenticate('/auth/login', event.currentTarget); }}>
            <h2>Sign in</h2>
            <label>Email or username<input name="login" required /></label>
            <label>Password<input name="password" type="password" required /></label>
            <button type="submit">Log in</button>
            <a className="button secondary" href={`${API_URL}/auth/google`}>Continue with Google</a>
          </form>
        </section>
      ) : page === 'connect' ? (
        <section className="single-action">
          <div>
            <p className="eyebrow">Step 1</p>
            <h2>Connect your current account</h2>
            <p className="muted">
              Connect Open Banking to view current account transactions and choose an amount to stake.
            </p>
          </div>
          <button type="button" onClick={() => void connectBank()}>Connect Open Banking</button>
        </section>
      ) : page === 'transactions' ? (
        <section className="transaction-page">
          <div className="summary-grid">
            <div className="summary-card">
              <span>Current account</span>
              <strong>{currentAccount ? formatMinor(currentAccount.currentBalance, currentAccount.currency) : 'Not synced'}</strong>
            </div>
            <div className="summary-card">
              <span>Betting wallet</span>
              <strong>{wallet ? formatMinor(wallet.balance, wallet.currency) : 'GBP 0.00'}</strong>
            </div>
          </div>

          <div className="section-heading">
            <div>
              <h2>Choose a transaction to stake from</h2>
              <p className="muted">
                Click a current account transaction first. Its amount will be copied into a stake editor where you can adjust it
                before depositing.
              </p>
            </div>
            {selectedStakeTransaction ? (
              <form className="selected-stake-actions" onSubmit={(event) => void proceedToBet(event)}>
                <button type="button" className="secondary" onClick={() => setStakeEditorOpen(true)}>
                  Adjust
                </button>
                <button type="submit" disabled={!isPositiveMinor(selectedStake)}>Deposit and continue</button>
              </form>
            ) : null}
          </div>

          {stakeEditorOpen && selectedStakeTransaction ? (
            <div className="stake-modal-backdrop">
              <form className="stake-modal" onSubmit={(event) => void proceedToBet(event)}>
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Selected transaction</p>
                    <h2>Adjust your stake</h2>
                  </div>
                  <button type="button" className="secondary" onClick={() => setStakeEditorOpen(false)}>
                    Close
                  </button>
                </div>
                <div className="selected-stake-card">
                  <div>
                    <span>{selectedStakeTransaction.merchantName ?? selectedStakeTransaction.description}</span>
                    <small>{selectedStakeTransaction.category ?? selectedStakeTransaction.direction}</small>
                  </div>
                  <strong>{formatMinor(selectedStakeTransaction.amount, selectedStakeTransaction.currency)}</strong>
                </div>
                <p className="muted">
                  This starts from the transaction amount. Change the number below if you want to stake a different amount.
                </p>
                <label>
                  Stake amount in pence
                  <input
                    value={selectedStake}
                    onChange={(event) => setSelectedStake(event.target.value)}
                    type="number"
                    min="1"
                    step="1"
                    placeholder="1000"
                  />
                </label>
                <div className="button-row">
                  <button type="submit" disabled={!isPositiveMinor(selectedStake)}>Deposit and continue</button>
                  <button type="button" className="secondary" onClick={clearSelectedStake}>
                    Choose another transaction
                  </button>
                </div>
              </form>
            </div>
          ) : null}

          <div className="transactions">
            <h3>Current account transactions</h3>
            {banking?.transactions.length ? (
              <ol>
                {banking.transactions.map((transaction) => {
                  const positiveAmount = absoluteMinor(transaction.amount);
                  const isSelected = stakeSourceTransactionId === transaction.id;
                  return (
                    <li key={transaction.id} className={isSelected ? 'selected' : undefined}>
                      <button type="button" className="transaction-choice" onClick={() => chooseTransactionStake(transaction)}>
                        <div>
                          <span>{transaction.merchantName ?? transaction.description}</span>
                          <small>{transaction.category ?? transaction.direction}</small>
                        </div>
                        <strong>{formatMinor(transaction.amount, transaction.currency)}</strong>
                        <span>{isSelected ? `Selected: ${positiveAmount}p` : 'Use as stake'}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p>No transactions are loaded yet. The app refreshes your current account feed automatically.</p>
            )}
          </div>
        </section>
      ) : (
        <section className="play-grid">
          <form onSubmit={(event) => void placeBet(event)}>
            <p className="eyebrow">Step 3</p>
            <h2>Place your bet</h2>
            <div className="stake-display">
              <span>Stake available</span>
              <strong>{formatMinor(walletBalance, wallet?.currency)}</strong>
            </div>
            <div className="game-toggle" role="group" aria-label="Choose game">
              <button
                type="button"
                className={selectedGame === 'coin_flip' ? 'active' : 'secondary'}
                onClick={() => setSelectedGame('coin_flip')}
              >
                Coin flip
              </button>
              <button
                type="button"
                className={selectedGame === 'roulette' ? 'active' : 'secondary'}
                onClick={() => setSelectedGame('roulette')}
              >
                Roulette
              </button>
            </div>
            {selectedGame === 'coin_flip' ? (
              <label>
                Selection
                <select name="selection">
                  <option value="heads">Heads</option>
                  <option value="tails">Tails</option>
                </select>
              </label>
            ) : (
              <>
                <label>
                  Bet type
                  <select
                    name="betType"
                    value={rouletteBetType}
                    onChange={(event) => setRouletteBetType(event.target.value as RouletteBetType)}
                  >
                    <option value="colour">Colour</option>
                    <option value="number">Number</option>
                  </select>
                </label>
                {rouletteBetType === 'colour' ? (
                  <label>
                    Colour
                    <select name="selection">
                      <option value="red">Red</option>
                      <option value="black">Black</option>
                      <option value="green">Green</option>
                    </select>
                  </label>
                ) : (
                  <label>
                    Number
                    <input name="selection" type="number" min="0" max="36" step="1" required />
                  </label>
                )}
              </>
            )}
            <label>Optional client seed<input name="clientSeed" maxLength={128} /></label>
            <button type="submit" disabled={!isPositiveMinor(walletBalance)}>Place bet</button>
            <button type="button" className="secondary" onClick={returnToTransactions}>
              Back to transactions
            </button>
          </form>
          <div className="history">
            <h2>Recent bets</h2>
            {bets.length === 0 ? <p>No bets yet.</p> : (
              <ol>{bets.map((bet) => (
                <li key={bet.id}>
                  <span>{bet.gameType}: {bet.selection} -&gt; {bet.result}</span>
                  <strong>{formatMinor(bet.stake)} / {formatMinor(bet.payout)}</strong>
                </li>
              ))}</ol>
            )}
          </div>
        </section>
      )}
    </main>
  );
}
