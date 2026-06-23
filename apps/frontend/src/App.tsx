import { FormEvent, useCallback, useEffect, useState } from 'react';
import { API_URL, api } from './api';
import { Bet, BetResult, User, Wallet } from './types';

type GameChoice = 'coin_flip' | 'roulette';
type RouletteBetType = 'number' | 'colour';

function formatMinor(value: string, currency = 'GBP'): string {
  const minor = BigInt(value);
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${currency === 'GBP' ? '£' : `${currency} `}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [message, setMessage] = useState('');
  const [selectedGame, setSelectedGame] = useState<GameChoice>('coin_flip');
  const [rouletteBetType, setRouletteBetType] = useState<RouletteBetType>('colour');

  const loadAccount = useCallback(async () => {
    try {
      const [currentUser, currentWallet, history] = await Promise.all([
        api.get<User>('/auth/me'),
        api.get<Wallet>('/wallet'),
        api.get<Bet[]>('/bets'),
      ]);
      setUser(currentUser);
      setWallet(currentWallet);
      setBets(history);
    } catch {
      setUser(null);
      setWallet(null);
      setBets([]);
    }
  }, []);

  useEffect(() => void loadAccount(), [loadAccount]);

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
    setBets([]);
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
            <div><span>Balance</span><strong>{wallet ? formatMinor(wallet.balance, wallet.currency) : '...'}</strong></div>
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
              <label>Stake in pence<input name="stake" type="number" min="1" step="1" required /></label>
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
