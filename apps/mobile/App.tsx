import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { api } from './src/api';
import {
  BankTransaction,
  BankingConnectResult,
  BankingMoneyMovementResult,
  BankingOverview,
  Bet,
  BetResult,
  User,
  Wallet,
} from './src/types';

type Screen = 'connect' | 'transactions' | 'bet';
type AuthMode = 'login' | 'register';
type Game = 'coin_flip' | 'roulette';
type RouletteBetType = 'colour' | 'number';

interface Snapshot {
  user: User;
  wallet: Wallet;
  banking: BankingOverview;
  bets: Bet[];
}

function formatMinor(value: string, currency = 'GBP'): string {
  const minor = BigInt(value || '0');
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  return `${sign}${currency} ${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
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

function ActionButton({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.buttonSecondaryText]}>{title}</Text>
    </Pressable>
  );
}

function ChoiceButton({ selected, label, onPress }: { selected: boolean; label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected && styles.choiceSelected]}>
      <Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [banking, setBanking] = useState<BankingOverview | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [screen, setScreen] = useState<Screen>('connect');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  const [stake, setStake] = useState('');
  const [stakeTransactionId, setStakeTransactionId] = useState<string>();
  const [game, setGame] = useState<Game>('coin_flip');
  const [coinSelection, setCoinSelection] = useState<'heads' | 'tails'>('heads');
  const [rouletteBetType, setRouletteBetType] = useState<RouletteBetType>('colour');
  const [rouletteSelection, setRouletteSelection] = useState('red');
  const [clientSeed, setClientSeed] = useState('');

  const currentAccount = banking?.accounts[0];
  const walletBalance = wallet?.balance ?? '0';

  const loadAccount = useCallback(async (): Promise<Snapshot> => {
    const [currentUser, currentWallet, currentBanking, currentBets] = await Promise.all([
      api.get<User>('/auth/me'),
      api.get<Wallet>('/wallet'),
      api.get<BankingOverview>('/banking'),
      api.get<Bet[]>('/bets'),
    ]);
    setUser(currentUser);
    setWallet(currentWallet);
    setBanking(currentBanking);
    setBets(currentBets);
    return { user: currentUser, wallet: currentWallet, banking: currentBanking, bets: currentBets };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (await api.restoreSession()) {
          const snapshot = await loadAccount();
          const hasConnection = Boolean(
            snapshot.banking.accounts.length ||
              snapshot.banking.connections.some((connection) => connection.status === 'active'),
          );
          setScreen(hasConnection ? 'transactions' : 'connect');
        }
      } catch {
        await api.logout().catch(() => undefined);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAccount]);

  async function run(task: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await task();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  function submitAuth() {
    void run(async () => {
      if (authMode === 'register') {
        await api.register(email.trim(), username.trim(), password);
      } else {
        await api.login(login.trim(), password);
      }
      const snapshot = await loadAccount();
      const hasConnection = Boolean(
        snapshot.banking.accounts.length ||
          snapshot.banking.connections.some((connection) => connection.status === 'active'),
      );
      setPassword('');
      setScreen(hasConnection ? 'transactions' : 'connect');
    });
  }

  function logout() {
    void run(async () => {
      await api.logout();
      setUser(null);
      setWallet(null);
      setBanking(null);
      setBets([]);
      setStake('');
      setScreen('connect');
    });
  }

  function connectBank() {
    void run(async () => {
      const returnUrl = Linking.createURL('banking-return');
      const result = await api.post<BankingConnectResult>('/banking/connect', undefined, {
        appReturnUrl: returnUrl,
      });
      setBanking(result.overview);
      if (result.authorizationUri) {
        const browserResult = await WebBrowser.openAuthSessionAsync(result.authorizationUri, returnUrl);
        if (browserResult.type !== 'success') {
          setMessage('Open Banking authorisation was closed before it completed.');
          return;
        }
      }
      const overview = await api.post<BankingOverview>('/banking/sync');
      setBanking(overview);
      setScreen('transactions');
      setMessage('Open Banking connected. Choose an amount to stake.');
    });
  }

  function syncBanking() {
    void run(async () => {
      const overview = await api.post<BankingOverview>('/banking/sync');
      setBanking(overview);
      setMessage('Transactions refreshed.');
    });
  }

  function chooseTransaction(transaction: BankTransaction) {
    setStake(absoluteMinor(transaction.amount));
    setStakeTransactionId(transaction.id);
    setMessage('');
  }

  function depositStake() {
    void run(async () => {
      if (!isPositiveMinor(stake)) throw new Error('Choose a positive stake amount.');
      const returnUrl = Linking.createURL('banking-return');
      const result = await api.post<BankingMoneyMovementResult>(
        '/banking/deposits',
        { amount: Number(stake), sourceTransactionId: stakeTransactionId },
        { appReturnUrl: returnUrl },
      );

      if (result.authorizationUri) {
        const browserResult = await WebBrowser.openAuthSessionAsync(result.authorizationUri, returnUrl);
        if (browserResult.type !== 'success') {
          setMessage('Payment authorisation was closed before it completed.');
          return;
        }
      }

      await api.post('/banking/deposits/refresh');
      const snapshot = await loadAccount();
      if (!isPositiveMinor(snapshot.wallet.balance)) {
        setMessage('The payment is still pending. Use Refresh payments and try again shortly.');
        return;
      }
      setScreen('bet');
      setMessage('Stake deposited. Choose your game.');
    });
  }

  function refreshPayments() {
    void run(async () => {
      await api.post('/banking/deposits/refresh');
      const snapshot = await loadAccount();
      if (isPositiveMinor(snapshot.wallet.balance)) setScreen('bet');
      setMessage('Payment statuses refreshed.');
    });
  }

  function placeBet() {
    void run(async () => {
      if (!isPositiveMinor(walletBalance)) throw new Error('There is no money in the betting wallet.');

      let result: BetResult;
      if (game === 'coin_flip') {
        result = await api.post<BetResult>('/bets/coin-flip', {
          stake: Number(walletBalance),
          selection: coinSelection,
          clientSeed: clientSeed.trim() || undefined,
        });
      } else {
        result = await api.post<BetResult>('/bets/roulette', {
          stake: Number(walletBalance),
          betType: rouletteBetType,
          selection: rouletteSelection,
          clientSeed: clientSeed.trim() || undefined,
        });
      }

      let payoutMessage = '';
      if (isPositiveMinor(result.newBalance)) {
        try {
          const payout = await api.post<BankingMoneyMovementResult>('/banking/payouts', {
            amount: Number(result.newBalance),
          });
          payoutMessage = ` ${formatMinor(payout.amount, payout.currency)} was sent back to your account.`;
        } catch (error) {
          payoutMessage = ` Automatic payout failed: ${error instanceof Error ? error.message : 'unknown error'}.`;
        }
      }

      setStake('');
      setStakeTransactionId(undefined);
      setClientSeed('');
      await loadAccount();
      setScreen('transactions');
      setMessage(`Result: ${result.result}. Game payout: ${formatMinor(result.payout)}.${payoutMessage}`);
    });
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#6c4cff" />
        <Text style={styles.muted}>Restoring your session...</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View>
              <Text style={styles.eyebrow}>OPEN BANKING BETTING</Text>
              <Text style={styles.logo}>Gamba</Text>
            </View>
            {user ? <ActionButton title="Log out" secondary onPress={logout} disabled={busy} /> : null}
          </View>

          {message ? <Text style={styles.message}>{message}</Text> : null}
          {busy ? <ActivityIndicator style={styles.busy} color="#6c4cff" /> : null}

          {!user ? (
            <View style={styles.card}>
              <Text style={styles.step}>WELCOME</Text>
              <Text style={styles.title}>{authMode === 'login' ? 'Sign in' : 'Create account'}</Text>
              {authMode === 'register' ? (
                <>
                  <TextInput
                    autoCapitalize="none"
                    keyboardType="email-address"
                    onChangeText={setEmail}
                    placeholder="Email"
                    style={styles.input}
                    value={email}
                  />
                  <TextInput
                    autoCapitalize="none"
                    onChangeText={setUsername}
                    placeholder="Username"
                    style={styles.input}
                    value={username}
                  />
                </>
              ) : (
                <TextInput
                  autoCapitalize="none"
                  onChangeText={setLogin}
                  placeholder="Email or username"
                  style={styles.input}
                  value={login}
                />
              )}
              <TextInput
                onChangeText={setPassword}
                placeholder="Password"
                secureTextEntry
                style={styles.input}
                value={password}
              />
              <ActionButton
                title={authMode === 'login' ? 'Log in' : 'Register'}
                onPress={submitAuth}
                disabled={busy || !password || (authMode === 'login' ? !login : !email || !username)}
              />
              <ActionButton
                title={authMode === 'login' ? 'Create an account' : 'Back to login'}
                secondary
                onPress={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                disabled={busy}
              />
              <Text style={styles.help}>Google sign-in remains available on the web client but needs a separate native OAuth exchange before it should be enabled here.</Text>
            </View>
          ) : screen === 'connect' ? (
            <View style={styles.card}>
              <Text style={styles.step}>STEP 1</Text>
              <Text style={styles.title}>Connect your current account</Text>
              <Text style={styles.muted}>Open the TrueLayer sandbox, authorise access, and return directly to this app.</Text>
              <ActionButton title="Connect Open Banking" onPress={connectBank} disabled={busy} />
            </View>
          ) : screen === 'transactions' ? (
            <>
              <View style={styles.summaryRow}>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Current account</Text>
                  <Text style={styles.summaryValue}>
                    {currentAccount ? formatMinor(currentAccount.currentBalance, currentAccount.currency) : 'Not synced'}
                  </Text>
                </View>
                <View style={styles.summaryCard}>
                  <Text style={styles.summaryLabel}>Betting wallet</Text>
                  <Text style={styles.summaryValue}>{formatMinor(walletBalance, wallet?.currency)}</Text>
                </View>
              </View>

              <View style={styles.card}>
                <Text style={styles.step}>STEP 2</Text>
                <Text style={styles.title}>Choose your stake</Text>
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={(value) => {
                    setStake(value);
                    setStakeTransactionId(undefined);
                  }}
                  placeholder="Amount in pence, for example 1000"
                  style={styles.input}
                  value={stake}
                />
                <ActionButton title="Deposit and continue" onPress={depositStake} disabled={busy || !isPositiveMinor(stake)} />
                <View style={styles.inlineActions}>
                  <ActionButton title="Sync transactions" secondary onPress={syncBanking} disabled={busy} />
                  <ActionButton title="Refresh payments" secondary onPress={refreshPayments} disabled={busy} />
                </View>
              </View>

              <Text style={styles.sectionTitle}>Recent transactions</Text>
              {banking?.transactions.length ? (
                banking.transactions.map((transaction) => (
                  <Pressable
                    key={transaction.id}
                    onPress={() => chooseTransaction(transaction)}
                    style={[
                      styles.transaction,
                      stakeTransactionId === transaction.id && styles.transactionSelected,
                    ]}
                  >
                    <View style={styles.transactionCopy}>
                      <Text style={styles.transactionName}>{transaction.merchantName ?? transaction.description}</Text>
                      <Text style={styles.muted}>{transaction.category ?? transaction.direction}</Text>
                    </View>
                    <Text style={styles.transactionAmount}>{formatMinor(transaction.amount, transaction.currency)}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.empty}>No transactions yet. Tap Sync transactions.</Text>
              )}
            </>
          ) : (
            <>
              <View style={styles.card}>
                <Text style={styles.step}>STEP 3</Text>
                <Text style={styles.title}>Place your bet</Text>
                <Text style={styles.balanceHero}>{formatMinor(walletBalance, wallet?.currency)}</Text>

                <View style={styles.choiceRow}>
                  <ChoiceButton selected={game === 'coin_flip'} label="Coin flip" onPress={() => setGame('coin_flip')} />
                  <ChoiceButton selected={game === 'roulette'} label="Roulette" onPress={() => setGame('roulette')} />
                </View>

                {game === 'coin_flip' ? (
                  <View style={styles.choiceRow}>
                    <ChoiceButton selected={coinSelection === 'heads'} label="Heads" onPress={() => setCoinSelection('heads')} />
                    <ChoiceButton selected={coinSelection === 'tails'} label="Tails" onPress={() => setCoinSelection('tails')} />
                  </View>
                ) : (
                  <>
                    <View style={styles.choiceRow}>
                      <ChoiceButton
                        selected={rouletteBetType === 'colour'}
                        label="Colour"
                        onPress={() => {
                          setRouletteBetType('colour');
                          setRouletteSelection('red');
                        }}
                      />
                      <ChoiceButton
                        selected={rouletteBetType === 'number'}
                        label="Number"
                        onPress={() => {
                          setRouletteBetType('number');
                          setRouletteSelection('0');
                        }}
                      />
                    </View>
                    {rouletteBetType === 'colour' ? (
                      <View style={styles.choiceRow}>
                        {['red', 'black', 'green'].map((colour) => (
                          <ChoiceButton
                            key={colour}
                            selected={rouletteSelection === colour}
                            label={colour[0].toUpperCase() + colour.slice(1)}
                            onPress={() => setRouletteSelection(colour)}
                          />
                        ))}
                      </View>
                    ) : (
                      <TextInput
                        keyboardType="number-pad"
                        onChangeText={setRouletteSelection}
                        placeholder="Number from 0 to 36"
                        style={styles.input}
                        value={rouletteSelection}
                      />
                    )}
                  </>
                )}

                <TextInput
                  autoCapitalize="none"
                  onChangeText={setClientSeed}
                  placeholder="Optional client seed"
                  style={styles.input}
                  value={clientSeed}
                />
                <ActionButton title="Place bet" onPress={placeBet} disabled={busy || !isPositiveMinor(walletBalance)} />
                <ActionButton title="Back to transactions" secondary onPress={() => setScreen('transactions')} disabled={busy} />
              </View>

              <Text style={styles.sectionTitle}>Recent bets</Text>
              {bets.length ? (
                bets.map((bet) => (
                  <View key={bet.id} style={styles.betRow}>
                    <Text style={styles.transactionName}>{bet.gameType}: {bet.selection} to {bet.result}</Text>
                    <Text style={styles.muted}>Stake {formatMinor(bet.stake)} / payout {formatMinor(bet.payout)}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.empty}>No bets yet.</Text>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#f5f3ff' },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: '#f5f3ff' },
  page: { padding: 20, paddingBottom: 64, gap: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  eyebrow: { color: '#6c4cff', fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  logo: { color: '#17132d', fontSize: 34, fontWeight: '900' },
  card: { backgroundColor: '#ffffff', borderRadius: 24, padding: 20, gap: 14, shadowColor: '#24184f', shadowOpacity: 0.08, shadowRadius: 18, elevation: 3 },
  step: { color: '#6c4cff', fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: '#17132d', fontSize: 25, fontWeight: '800' },
  muted: { color: '#746f86', fontSize: 14, lineHeight: 20 },
  help: { color: '#8a8499', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  message: { color: '#35285f', backgroundColor: '#e8e2ff', padding: 14, borderRadius: 14, lineHeight: 20 },
  busy: { marginVertical: 4 },
  input: { minHeight: 50, borderWidth: 1, borderColor: '#ddd7ef', borderRadius: 14, paddingHorizontal: 14, color: '#17132d', backgroundColor: '#fbfaff', fontSize: 16 },
  button: { minHeight: 48, paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#6c4cff', alignItems: 'center', justifyContent: 'center' },
  buttonSecondary: { backgroundColor: '#eeeafd' },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { transform: [{ scale: 0.98 }] },
  buttonText: { color: '#ffffff', fontWeight: '800', textAlign: 'center' },
  buttonSecondaryText: { color: '#4a358f' },
  summaryRow: { flexDirection: 'row', gap: 12 },
  summaryCard: { flex: 1, minHeight: 105, backgroundColor: '#17132d', borderRadius: 20, padding: 16, justifyContent: 'space-between' },
  summaryLabel: { color: '#aaa2c4', fontSize: 12 },
  summaryValue: { color: '#ffffff', fontSize: 19, fontWeight: '800' },
  inlineActions: { gap: 10 },
  sectionTitle: { color: '#17132d', fontSize: 20, fontWeight: '800', marginTop: 8 },
  transaction: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', padding: 16, borderRadius: 16, borderWidth: 2, borderColor: 'transparent' },
  transactionSelected: { borderColor: '#6c4cff', backgroundColor: '#f1edff' },
  transactionCopy: { flex: 1, paddingRight: 12 },
  transactionName: { color: '#211b35', fontSize: 15, fontWeight: '700' },
  transactionAmount: { color: '#211b35', fontWeight: '800' },
  empty: { color: '#746f86', backgroundColor: '#ffffff', padding: 20, borderRadius: 16 },
  balanceHero: { color: '#17132d', fontSize: 32, fontWeight: '900', marginBottom: 4 },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { flexGrow: 1, minWidth: 82, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#eeeafd', alignItems: 'center' },
  choiceSelected: { backgroundColor: '#6c4cff' },
  choiceText: { color: '#4a358f', fontWeight: '700' },
  choiceTextSelected: { color: '#ffffff' },
  betRow: { backgroundColor: '#ffffff', borderRadius: 16, padding: 16, gap: 5 },
});
