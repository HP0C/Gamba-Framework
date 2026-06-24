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
  const [selectedGame, setSelectedGame] = useState<GameChoice>('coin_flip');
  const [rouletteBetType, setRouletteBetType] = useState<RouletteBetType>('colour');

  const loadAccount = useCallback(async (): Promise<AccountSnapshot | null> => {
    try {
      const [currentUser, currentWallet, bankingOverview, history] = await Promise.all([
        api.get<User>('/auth/me'),
        api.get<Wallet>('/wallet'),
        api.get<BankingOverview>('/banking'),
        api.get<Bet[]>('/bets'),
      ]);
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
  }, []);

  useEffect(() => void loadAccount(), [loadAccount]);

  const hasOpenBankingConnection = useMemo(
    () =>
      Boolean(
        banking?.accounts.length ||
          banking?.transactions.length ||
          banking?.connections.some((connection) => connection.status === 'active'),
      ),
    [banking],
  );

  const currentAccount = banking?.accounts[0];
  const walletBalance = wallet?.balance ?? '0';

  useEffect(() => {
    if (!user || page === 'bet') return;
    setPage(hasOpenBankingConnection ? 'transactions' : 'connect');
  }, [hasOpenBankingConnection, page, user]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bankingStatus = params.get('banking');
    const paymentStatus = params.get('payment');
    if (!bankingStatus && !paymentStatus) return;

    async function handleReturn() {
      if (bankingStatus) {
        if (bankingStatus === 'connected') {
          try {
            const overview = await api.post<BankingOverview>('/banking/sync');
            setBanking(overview);
            setPage('transactions');
            setMessage('Open Banking connected. Choose an amount to stake.');
          } catch (error) {
            await loadAccount();
            setPage('transactions');
            setMessage(error instanceof Error ? error.message : 'Open Banking connected, but transactions could not sync yet.');
          }
        } else {
          setMessage('Open Banking authorisation did not complete.');
        }
      }

      if (paymentStatus) {
        const snapshot = await loadAccount();
        if (paymentStatus === 'succeeded') {
          const pendingStake = sessionStorage.getItem(PENDING_STAKE_KEY);
          sessionStorage.removeItem(PENDING_STAKE_KEY);
          setSelectedStake(pendingStake ?? snapshot?.wallet.balance ?? '');
          setPage('bet');
          setMessage('Stake deposited into your betting wallet. Choose a game to continue.');
        } else if (paymentStatus === 'pending') {
          setPage('transactions');
          setMessage('The deposit is still pending. Refresh payments in a moment, then continue to bet.');
        } else {
          sessionStorage.removeItem(PENDING_STAKE_KEY);
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
      const account = await loadAccount();
      setPage(account && hasOpenBankingConnection ? 'transactions' : 'connect');
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
      setPage('transactions');
      setMessage('Open Banking connected. Choose an amount to stake.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not connect Open Banking');
    }
  }

  async function syncBankData() {
    setMessage('');
    try {
      const overview = await api.post<BankingOverview>('/banking/sync');
      setBanking(overview);
      setMessage('Current account transactions synced.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sync transactions');
    }
  }

  async function refreshPendingDeposits() {
    setMessage('');
    try {
      const overview = await api.post<BankingOverview>('/banking/deposits/refresh');
      setBanking(overview);
      const snapshot = await loadAccount();
      const pendingStake = sessionStorage.getItem(PENDING_STAKE_KEY);
      if (pendingStake && snapshot && isPositiveMinor(snapshot.wallet.balance)) {
        sessionStorage.removeItem(PENDING_STAKE_KEY);
        setSelectedStake(pendingStake);
        setPage('bet');
        setMessage('Payment settled. Choose a game to continue.');
        return;
      }
      setMessage('Payment statuses refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not refresh payment statuses');
    }
  }

  function chooseTransactionStake(transaction: BankTransaction) {
    setSelectedStake(absoluteMinor(transaction.amount));
    setStakeSourceTransactionId(transaction.id);
    setMessage('');
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

      if (result.authorizationUri) {
        setMessage('Redirecting to Open Banking payment authorisation...');
        window.location.assign(result.authorizationUri);
        return;
      }

      if (result.newBalance) {
        setWallet((current) => current && { ...current, balance: result.newBalance ?? current.balance });
      }
      setPage('bet');
      setMessage('Stake deposited into your betting wallet. Choose a game to continue.');
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
      await loadAccount();
      setPage('transactions');
      setMessage(`Result: ${result.result}. Payout: ${formatMinor(result.payout)}.${payoutMessage}`);
    } catch (error) {
      await loadAccount();
      setMessage(error instanceof Error ? error.message : 'Bet failed');
    }
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
              <p className="eyebrow">Step 2</p>
              <h2>Choose how much to stake</h2>
            </div>
            <div className="button-row">
              <button type="button" className="secondary" onClick={() => void syncBankData()}>Sync transactions</button>
              <button type="button" className="secondary" onClick={() => void refreshPendingDeposits()}>Refresh payments</button>
            </div>
          </div>

          <form className="stake-panel" onSubmit={(event) => void proceedToBet(event)}>
            <label>
              Custom stake in pence
              <input
                value={selectedStake}
                onChange={(event) => {
                  setSelectedStake(event.target.value);
                  setStakeSourceTransactionId(undefined);
                }}
                type="number"
                min="1"
                step="1"
                placeholder="1000"
              />
            </label>
            <button type="submit" disabled={!isPositiveMinor(selectedStake)}>Proceed to bet</button>
          </form>

          <div className="transactions">
            <h3>Current account transactions</h3>
            {banking?.transactions.length ? (
              <ol>
                {banking.transactions.map((transaction) => {
                  const positiveAmount = absoluteMinor(transaction.amount);
                  const isSelected = selectedStake === positiveAmount && stakeSourceTransactionId === transaction.id;
                  return (
                    <li key={transaction.id} className={isSelected ? 'selected' : undefined}>
                      <div>
                        <span>{transaction.merchantName ?? transaction.description}</span>
                        <small>{transaction.category ?? transaction.direction}</small>
                      </div>
                      <strong>{formatMinor(transaction.amount, transaction.currency)}</strong>
                      <button type="button" onClick={() => chooseTransactionStake(transaction)}>
                        Stake this value
                      </button>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p>No transactions are loaded yet. Sync transactions to refresh the current account feed.</p>
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
            <button type="button" className="secondary" onClick={() => setPage('transactions')}>
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
