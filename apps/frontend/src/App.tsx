import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL, api } from './api';
import {
  BankTransaction,
  BankingConnectResult,
  BankingMandateResult,
  BankingMoneyMovementResult,
  BankingOverview,
  Bet,
  BetResult,
  User,
  Wallet,
} from './types';

type AppPage = 'connect' | 'mandate' | 'transactions' | 'bet';
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

function hasBankingConnection(overview: BankingOverview | null): boolean {
  return Boolean(
    overview?.accounts.length ||
      overview?.transactions.length ||
      overview?.connections.some((connection) => connection.status === 'active'),
  );
}

function hasAuthorizedMandate(overview: BankingOverview | null): boolean {
  return Boolean(overview?.mandates?.some((mandate) => mandate.status === 'authorized'));
}

function nextSetupPage(overview: BankingOverview | null): AppPage {
  if (!hasBankingConnection(overview)) return 'connect';
  if (!hasAuthorizedMandate(overview)) return 'mandate';
  return 'transactions';
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

  const authorizedMandate = useMemo(
    () => banking?.mandates?.find((mandate) => mandate.status === 'authorized') ?? null,
    [banking],
  );

  const currentAccount = banking?.accounts[0];
  const walletBalance = wallet?.balance ?? '0';

  useEffect(() => {
    if (!user || page === 'bet') return;
    const setupPage = nextSetupPage(banking);
    if (page !== setupPage) setPage(setupPage);
  }, [banking, page, user]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bankingStatus = params.get('banking');
    const paymentStatus = params.get('payment');
    const mandateStatus = params.get('mandate');
    if (!bankingStatus && !paymentStatus && !mandateStatus) return;

    async function handleReturn() {
      if (bankingStatus) {
        if (bankingStatus === 'connected') {
          try {
            const overview = await api.post<BankingOverview>('/banking/sync');
            setBanking(overview);
            setPage(nextSetupPage(overview));
            setMessage('Open Banking connected. Set your reusable deposit limits next.');
          } catch (error) {
            const snapshot = await loadAccount();
            setPage(nextSetupPage(snapshot?.banking ?? null));
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

      if (mandateStatus) {
        const snapshot = await loadAccount();
        const nextPage = nextSetupPage(snapshot?.banking ?? null);
        setPage(nextPage);
        setMessage(
          mandateStatus === 'authorized'
            ? 'Reusable Open Banking deposits are authorised. Choose an amount to stake.'
            : 'Open Banking mandate authorisation did not complete.',
        );
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
      setPage(nextSetupPage(account?.banking ?? null));
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
      setPage(nextSetupPage(result.overview));
      setMessage('Open Banking connected. Set your reusable deposit limits next.');
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

  async function createMandate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form));

    try {
      const result = await api.post<BankingMandateResult>('/banking/mandates', {
        maximumIndividualAmount: Number(data.maximumIndividualAmount),
        dailyLimit: Number(data.dailyLimit),
        validDays: Number(data.validDays || 365),
      });
      setBanking((current) =>
        current
          ? {
              ...current,
              mandates: [
                result.mandate,
                ...(current.mandates ?? []).filter((mandate) => mandate.id !== result.mandate.id),
              ],
            }
          : current,
      );
      if (result.authorizationUri) {
        setMessage('Redirecting to authorise reusable Open Banking deposits...');
        window.location.assign(result.authorizationUri);
        return;
      }
      if (result.mandate.status === 'authorized') setPage('transactions');
      setMessage('Reusable Open Banking deposit permission was created.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create Open Banking mandate');
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
      const depositPath = authorizedMandate ? '/banking/mandate-deposits' : '/banking/deposits';
      const result = await api.post<BankingMoneyMovementResult>(depositPath, {
        amount: Number(selectedStake),
        mandateId: authorizedMandate?.id,
        sourceTransactionId: stakeSourceTransactionId,
      });
      sessionStorage.setItem(PENDING_STAKE_KEY, selectedStake);

      if (result.authorizationUri) {
        setMessage('Redirecting to Open Banking payment authorisation...');
        window.location.assign(result.authorizationUri);
        return;
      }

      if (result.status !== 'succeeded' || !result.newBalance) {
        if (result.status === 'failed') sessionStorage.removeItem(PENDING_STAKE_KEY);
        setMessage(
          result.status === 'failed'
            ? 'The deposit failed, so no money was added to your wallet.'
            : 'The deposit is still processing. Refresh payments in a moment, then continue to bet.',
        );
        await loadAccount();
        return;
      }

      if (result.newBalance) {
        setWallet((current) => current && { ...current, balance: result.newBalance ?? current.balance });
      }
      sessionStorage.removeItem(PENDING_STAKE_KEY);
      setPage('bet');
      setMessage('Stake deposited into your betting wallet. Choose a game to continue.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Deposit failed');
    }
  }

  async function requestWalletPayout(amount: string): Promise<string> {
    const payout = await api.post<BankingMoneyMovementResult>('/banking/payouts', {
      amount: Number(amount),
    });

    if (payout.status === 'succeeded') {
      return `${formatMinor(payout.amount, payout.currency)} was paid back to your current account.`;
    }
    if (payout.status === 'pending') {
      return `${formatMinor(payout.amount, payout.currency)} payout has been requested and is pending.`;
    }
    return `Payout status: ${payout.status}.`;
  }

  async function payoutWallet() {
    setMessage('');
    if (!isPositiveMinor(walletBalance)) {
      setMessage('There is no wallet balance to pay out.');
      return;
    }

    try {
      const payoutMessage = await requestWalletPayout(walletBalance);
      await loadAccount();
      setPage('transactions');
      setMessage(payoutMessage);
    } catch (error) {
      await loadAccount();
      setPage('transactions');
      setMessage(error instanceof Error ? `Payout failed: ${error.message}` : 'Payout failed');
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
        try {
          payoutMessage = ` ${await requestWalletPayout(result.newBalance)}`;
        } catch (payoutError) {
          payoutMessage =
            payoutError instanceof Error
              ? ` Payout failed: ${payoutError.message}. The winnings are still in your wallet.`
              : ' Payout failed. The winnings are still in your wallet.';
        }
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
      ) : page === 'mandate' ? (
        <section className="single-action">
          <form className="stake-panel" onSubmit={(event) => void createMandate(event)}>
            <div>
              <p className="eyebrow">Step 2</p>
              <h2>Authorise deposit limits</h2>
              <p className="muted">
                Set the maximum single deposit and daily deposit limit that can be used when you choose a stake.
              </p>
            </div>
            <label>
              Max individual deposit in pence
              <input name="maximumIndividualAmount" type="number" min="1" step="1" defaultValue="1000" required />
            </label>
            <label>
              Daily deposit limit in pence
              <input name="dailyLimit" type="number" min="1" step="1" defaultValue="5000" required />
            </label>
            <label>
              Valid days
              <input name="validDays" type="number" min="1" max="365" step="1" defaultValue="365" required />
            </label>
            <button type="submit">Authorise deposit limits</button>
          </form>
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
              {isPositiveMinor(walletBalance) && (
                <button type="button" className="secondary" onClick={() => void payoutWallet()}>
                  Pay wallet back
                </button>
              )}
            </div>
          </div>

          <div className="section-heading">
            <div>
              <p className="eyebrow">Step 3</p>
              <h2>Choose how much to stake</h2>
            </div>
            <div className="button-row">
              <button type="button" className="secondary" onClick={() => void syncBankData()}>Sync transactions</button>
              <button type="button" className="secondary" onClick={() => void refreshPendingDeposits()}>Refresh payments</button>
            </div>
          </div>

          {authorizedMandate && (
            <div className="stake-panel">
              <div>
                <p className="eyebrow">Reusable deposits authorised</p>
                <h3>Deposit limits</h3>
                <p className="muted">
                  Individual deposit limit: {formatMinor(authorizedMandate.maximumIndividualAmount, authorizedMandate.currency)}.
                  Daily limit: {formatMinor(authorizedMandate.dailyLimit, authorizedMandate.currency)}.
                </p>
              </div>
            </div>
          )}

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
            <button type="submit" disabled={!isPositiveMinor(selectedStake) || !authorizedMandate}>Proceed to bet</button>
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
            <p className="eyebrow">Step 4</p>
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
