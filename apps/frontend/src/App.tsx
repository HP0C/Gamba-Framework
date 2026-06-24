import { FormEvent, useCallback, useEffect, useState } from 'react';
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

type GameChoice = 'coin_flip' | 'roulette';
type RouletteBetType = 'number' | 'colour';

function formatMinor(value: string, currency = 'GBP'): string {
  const minor = BigInt(value);
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${currency === 'GBP' ? 'GBP ' : `${currency} `}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function absoluteMinor(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [banking, setBanking] = useState<BankingOverview | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [message, setMessage] = useState('');
  const [selectedGame, setSelectedGame] = useState<GameChoice>('coin_flip');
  const [rouletteBetType, setRouletteBetType] = useState<RouletteBetType>('colour');
  const [betStake, setBetStake] = useState('');

  const loadAccount = useCallback(async () => {
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
    } catch {
      setUser(null);
      setWallet(null);
      setBanking(null);
      setBets([]);
    }
  }, []);

  useEffect(() => void loadAccount(), [loadAccount]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const bankingStatus = params.get('banking');
    const paymentStatus = params.get('payment');
    if (!bankingStatus && !paymentStatus) return;

    if (paymentStatus) {
      setMessage(
        paymentStatus === 'succeeded'
          ? 'TrueLayer sandbox payment settled and your wallet was credited.'
          : paymentStatus === 'failed'
            ? 'TrueLayer sandbox payment failed.'
            : paymentStatus === 'error'
              ? 'TrueLayer sandbox payment could not be completed. Check the payment redirect URI in TrueLayer Console.'
              : 'TrueLayer sandbox payment is still pending. Click Refresh payments in a moment.',
      );
      void loadAccount();
    } else {
      setMessage(
        bankingStatus === 'connected'
          ? 'TrueLayer sandbox authorisation finished. Click Sync transactions to load bank data.'
          : 'TrueLayer sandbox authorisation did not complete.',
      );
    }
    window.history.replaceState({}, document.title, window.location.pathname);
  }, [loadAccount]);

  async function authenticate(path: '/auth/register' | '/auth/login', form: HTMLFormElement) {
    setMessage('');
    const data = Object.fromEntries(new FormData(form));
    try {
      await api.post(path, data);
      form.reset();
      await loadAccount();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  async function logout() {
    await api.post('/auth/logout');
    setUser(null);
    setWallet(null);
    setBanking(null);
    setBets([]);
    setBetStake('');
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
      setMessage('Bank connected and synced.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not connect bank');
    }
  }

  async function syncBankData() {
    setMessage('');
    try {
      const overview = await api.post<BankingOverview>('/banking/sync');
      setBanking(overview);
      setMessage('Bank transactions synced.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not sync bank data');
    }
  }

  async function refreshAfterMoneyMovement(result: BankingMoneyMovementResult, label: string) {
    if (result.authorizationUri) {
      setMessage(`${label}: redirecting to TrueLayer sandbox authorisation...`);
      window.location.assign(result.authorizationUri);
      return;
    }
    if (result.newBalance) {
      const newBalance = result.newBalance;
      setWallet((current) => current && { ...current, balance: newBalance });
    }
    setMessage(`${label}: ${formatMinor(result.amount, result.currency)} (${result.status}).`);
    await loadAccount();
  }

  async function createDeposit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await api.post<BankingMoneyMovementResult>('/banking/deposits', {
        amount: Number(data.get('amount')),
      });
      form.reset();
      await refreshAfterMoneyMovement(
        result,
        'TrueLayer sandbox payment created',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Deposit failed');
    }
  }

  async function depositFromTransaction(transaction: BankTransaction) {
    setMessage('');
    try {
      const result = await api.post<BankingMoneyMovementResult>('/banking/deposits', {
        amount: Number(absoluteMinor(transaction.amount)),
        sourceTransactionId: transaction.id,
      });
      await refreshAfterMoneyMovement(
        result,
        'TrueLayer sandbox payment created from transaction amount',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Deposit failed');
    }
  }

  async function refreshPendingDeposits() {
    setMessage('');
    try {
      const overview = await api.post<BankingOverview>('/banking/deposits/refresh');
      setBanking(overview);
      await loadAccount();
      setMessage('Payment statuses refreshed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not refresh payment statuses');
    }
  }

  async function createPayout(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const result = await api.post<BankingMoneyMovementResult>('/banking/payouts', {
        amount: Number(data.get('amount')),
      });
      form.reset();
      await refreshAfterMoneyMovement(
        result,
        'TrueLayer sandbox payout requested',
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Payout failed');
    }
  }

  async function placeBet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      const clientSeed = data.get('clientSeed') || undefined;
      const result =
        selectedGame === 'coin_flip'
          ? await api.post<BetResult>('/bets/coin-flip', {
              stake: Number(data.get('stake')),
              selection: data.get('selection'),
              clientSeed,
            })
          : await api.post<BetResult>('/bets/roulette', {
              stake: Number(data.get('stake')),
              betType: data.get('betType'),
              selection: data.get('selection'),
              clientSeed,
            });
      setWallet((current) => current && { ...current, balance: result.newBalance });
      setMessage(`Result: ${result.result}. Payout: ${formatMinor(result.payout)}.`);
      form.reset();
      setBetStake('');
      setRouletteBetType('colour');
      await loadAccount();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Bet failed');
    }
  }

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Local development demonstration</p>
          <h1>Gamba</h1>
        </div>
        {user && <button onClick={() => void logout()}>Log out</button>}
      </header>

      <p className="warning">Demo credits only. This application is not approved for real-money gambling.</p>
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
      ) : (
        <>
          <section className="account">
            <div><span>Player</span><strong>{user.username}</strong></div>
            <div><span>Wallet balance</span><strong>{wallet ? formatMinor(wallet.balance, wallet.currency) : '...'}</strong></div>
          </section>

          <section className="banking">
            <div className="section-heading">
              <div>
                <p className="eyebrow">TrueLayer sandbox</p>
                <h2>Banking</h2>
              </div>
              <div className="button-row">
                <button type="button" onClick={() => void connectBank()}>
                  Connect TrueLayer sandbox
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void syncBankData()}
                >
                  Sync transactions
                </button>
                <button type="button" className="secondary" onClick={() => void refreshPendingDeposits()}>
                  Refresh payments
                </button>
              </div>
            </div>

            <p className="muted">
              Account data comes from TrueLayer Data sandbox when enabled, otherwise local sandbox sample transactions are shown. Deposits use TrueLayer Payments sandbox pay-ins. Payouts use closed-loop sandbox payouts after a successful deposit.
            </p>

            {banking?.accounts.length ? (
              <div className="banking-grid">
                <div className="bank-card">
                  <h3>Connected accounts</h3>
                  {banking.accounts.map((account) => (
                    <div className="bank-account" key={account.id}>
                      <span>{account.displayName}</span>
                      <strong>{formatMinor(account.currentBalance, account.currency)}</strong>
                    </div>
                  ))}
                </div>

                <form className="mini-form" onSubmit={(event) => void createDeposit(event)}>
                  <h3>TrueLayer sandbox deposit</h3>
                  <label>Amount in pence<input name="amount" type="number" min="1" step="1" required /></label>
                  <button type="submit">Pay with TrueLayer</button>
                  <small>
                    You will be redirected to the TrueLayer sandbox hosted payment page.
                  </small>
                </form>

                <form className="mini-form" onSubmit={(event) => void createPayout(event)}>
                  <h3>TrueLayer sandbox payout</h3>
                  <label>Amount in pence<input name="amount" type="number" min="1" step="1" required /></label>
                  <button type="submit">Payout from wallet</button>
                  <small>
                    Sandbox payouts are closed-loop, so make a successful deposit first.
                  </small>
                </form>
              </div>
            ) : (
              <p>No bank is connected yet.</p>
            )}

            {banking?.transactions.length ? (
              <div className="transactions">
                <h3>Recent bank transactions</h3>
                <ol>
                  {banking.transactions.map((transaction) => {
                    const positiveAmount = absoluteMinor(transaction.amount);
                    return (
                      <li key={transaction.id}>
                        <div>
                          <span>{transaction.merchantName ?? transaction.description}</span>
                          <small>{transaction.category ?? transaction.direction}</small>
                        </div>
                        <strong>{formatMinor(transaction.amount, transaction.currency)}</strong>
                        <div className="button-row">
                          <button type="button" className="secondary" onClick={() => setBetStake(positiveAmount)}>
                            Use as stake
                          </button>
                          <button type="button" onClick={() => void depositFromTransaction(transaction)}>
                            Deposit this amount
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ) : null}

            {banking?.payments.length ? (
              <div className="transactions">
                <h3>Recent wallet deposits</h3>
                <ol>
                  {banking.payments.map((payment) => (
                    <li key={payment.id}>
                      <div>
                        <span>{payment.providerPaymentId}</span>
                        <small>{payment.status}</small>
                      </div>
                      <strong>{formatMinor(payment.amount, payment.currency)}</strong>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </section>

          <section className="play-grid">
            <form onSubmit={(event) => void placeBet(event)}>
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
              <h2>{selectedGame === 'coin_flip' ? 'Coin flip' : 'Roulette'}</h2>
              <label>
                Stake in pence
                <input
                  name="stake"
                  type="number"
                  min="1"
                  step="1"
                  value={betStake}
                  onChange={(event) => setBetStake(event.target.value)}
                  required
                />
              </label>
              {selectedGame === 'coin_flip' ? (
                <label>Selection<select name="selection"><option value="heads">Heads</option><option value="tails">Tails</option></select></label>
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
              <button type="submit">Place bet</button>
              <small>The server generates and resolves every result.</small>
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
        </>
      )}
    </main>
  );
}
