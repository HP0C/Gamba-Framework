import * as Linking from 'expo-linking';
import * as Haptics from 'expo-haptics';
import { StatusBar } from 'expo-status-bar';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, { Circle, G, Path, Text as SvgText } from 'react-native-svg';
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
type CoinFace = 'heads' | 'tails';
type CoinAnimationPhase = 'ready' | 'flipping' | 'settled';
type ActivityView = 'transactions' | 'bets';
type RouletteBetType = 'colour' | 'number';
type RouletteColour = 'red' | 'black' | 'green';

interface RoulettePocket {
  number: number;
  colour: RouletteColour;
}

interface Snapshot {
  user: User;
  wallet: Wallet;
  banking: BankingOverview;
  bets: Bet[];
}

const PAYMENT_REFRESH_ATTEMPTS = 6;
const PAYMENT_REFRESH_DELAY_MS = 1_500;
const TRANSACTIONS_BACKGROUND_REFRESH_MS = 30_000;
const COIN_REVEAL_PAUSE_MS = 900;
const ROULETTE_REVEAL_PAUSE_MS = 1_100;
const ROULETTE_WHEEL_SIZE = 276;
const ROULETTE_STEP_DEGREES = 360 / 37;
const ROULETTE_WHEEL_RADIUS = ROULETTE_WHEEL_SIZE / 2 - 8;
const ROULETTE_HUB_RADIUS = 42;
const ROULETTE_LABEL_RADIUS = ROULETTE_WHEEL_RADIUS * 0.78;
const ROULETTE_RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const EUROPEAN_ROULETTE_WHEEL = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18,
  29, 7, 28, 12, 35, 3, 26,
].map((number) => ({ number, colour: rouletteColourForNumber(number) }));

function hasBankingConnection(banking: BankingOverview | null | undefined): boolean {
  return Boolean(
    banking?.accounts.length ||
      banking?.transactions.length ||
      banking?.connections.some((connection) => connection.status === 'active'),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatMinor(value: string, currency = 'GBP'): string {
  const minor = BigInt(value || '0');
  const sign = minor < 0n ? '-' : '';
  const absolute = minor < 0n ? -minor : minor;
  const symbol = currency === 'GBP' ? '\u00a3' : `${currency} `;
  return `${sign}${symbol}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function formatMinorForPoundsInput(value: string): string {
  const absolute = BigInt(absoluteMinor(value || '0'));
  return `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

function normalisePoundsInput(value: string): string {
  const cleaned = value.replace(/[\u00a3,\s]/g, '').replace(/[^0-9.]/g, '');
  const [whole = '', ...decimalParts] = cleaned.split('.');
  if (!decimalParts.length) return whole;
  return `${whole || '0'}.${decimalParts.join('').slice(0, 2)}`;
}

function poundsInputToMinor(value: string): string {
  const normalised = normalisePoundsInput(value);
  if (!normalised || normalised === '0.') return '';
  const [pounds = '0', pence = ''] = normalised.split('.');
  return (BigInt(pounds || '0') * 100n + BigInt(pence.padEnd(2, '0') || '0')).toString();
}

function rouletteColourForNumber(number: number): RouletteColour {
  if (number === 0) return 'green';
  return ROULETTE_RED_NUMBERS.has(number) ? 'red' : 'black';
}

function parseRouletteResult(result: string | null): RoulettePocket | null {
  if (!result) return null;
  const [numberPart, colourPart] = result.split(':');
  const number = Number(numberPart);
  if (!Number.isInteger(number) || number < 0 || number > 36) return null;
  const colour = colourPart === 'red' || colourPart === 'black' || colourPart === 'green' ? colourPart : rouletteColourForNumber(number);
  return { number, colour };
}

function roulettePocketFill(colour: RouletteColour): string {
  if (colour === 'red') return '#d83a4b';
  if (colour === 'green') return '#189b67';
  return '#1f1a2d';
}

function polarToCartesian(radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180;
  const centre = ROULETTE_WHEEL_SIZE / 2;
  return {
    x: centre + radius * Math.cos(angleInRadians),
    y: centre + radius * Math.sin(angleInRadians),
  };
}

function describeRouletteSlice(index: number): string {
  const centre = ROULETTE_WHEEL_SIZE / 2;
  const sliceCentreAngle = -90 + index * ROULETTE_STEP_DEGREES;
  const start = polarToCartesian(ROULETTE_WHEEL_RADIUS, sliceCentreAngle - ROULETTE_STEP_DEGREES / 2);
  const end = polarToCartesian(ROULETTE_WHEEL_RADIUS, sliceCentreAngle + ROULETTE_STEP_DEGREES / 2);

  return [
    `M ${centre} ${centre}`,
    `L ${start.x} ${start.y}`,
    `A ${ROULETTE_WHEEL_RADIUS} ${ROULETTE_WHEEL_RADIUS} 0 0 1 ${end.x} ${end.y}`,
    'Z',
  ].join(' ');
}

function rouletteLabelPosition(index: number) {
  return polarToCartesian(ROULETTE_LABEL_RADIUS, -90 + index * ROULETTE_STEP_DEGREES);
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
  const { width: windowWidth } = useWindowDimensions();
  const [user, setUser] = useState<User | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [banking, setBanking] = useState<BankingOverview | null>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [screen, setScreen] = useState<Screen>('connect');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshingTransactions, setRefreshingTransactions] = useState(false);
  const [message, setMessage] = useState('');
  const messageOpacity = useRef(new Animated.Value(0)).current;
  const coinSpin = useRef(new Animated.Value(0)).current;
  const coinLift = useRef(new Animated.Value(0)).current;
  const coinScale = useRef(new Animated.Value(1)).current;
  const rouletteSpin = useRef(new Animated.Value(0)).current;
  const gamePagerRef = useRef<ScrollView | null>(null);

  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  const [stake, setStake] = useState('');
  const [stakeInput, setStakeInput] = useState('');
  const [stakeTransactionId, setStakeTransactionId] = useState<string>();
  const [stakeEditorOpen, setStakeEditorOpen] = useState(false);
  const [game, setGame] = useState<Game>('coin_flip');
  const [activityView, setActivityView] = useState<ActivityView>('transactions');
  const [coinSelection, setCoinSelection] = useState<'heads' | 'tails'>('heads');
  const [coinAnimationFace, setCoinAnimationFace] = useState<CoinFace | null>(null);
  const [coinAnimationPhase, setCoinAnimationPhase] = useState<CoinAnimationPhase>('ready');
  const [rouletteResult, setRouletteResult] = useState<RoulettePocket | null>(null);
  const [rouletteIsSpinning, setRouletteIsSpinning] = useState(false);
  const [rouletteBetType, setRouletteBetType] = useState<RouletteBetType>('colour');
  const [rouletteSelection, setRouletteSelection] = useState('red');
  const [clientSeed, setClientSeed] = useState('');

  const currentAccount = banking?.accounts[0];
  const walletBalance = wallet?.balance ?? '0';
  const selectedStakeTransaction = stakeTransactionId
    ? banking?.transactions.find((transaction) => transaction.id === stakeTransactionId)
    : undefined;
  const gamePanelWidth = Math.max(windowWidth - 72, 280);

  const loadAccount = useCallback(async (options: { refreshBanking?: boolean; refreshPayments?: boolean } = {}): Promise<Snapshot> => {
    const [currentUser, initialBanking] = await Promise.all([
      api.get<User>('/auth/me'),
      api.get<BankingOverview>('/banking'),
    ]);
    let currentBanking = initialBanking;

    if (hasBankingConnection(currentBanking)) {
      if (options.refreshPayments) {
        currentBanking = await api
          .post<BankingOverview>('/banking/deposits/refresh')
          .catch(() => currentBanking);
      }
      if (options.refreshBanking) {
        currentBanking = await api.post<BankingOverview>('/banking/sync').catch(() => currentBanking);
      }
    }

    const [currentWallet, currentBets] = await Promise.all([api.get<Wallet>('/wallet'), api.get<Bet[]>('/bets')]);
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
          const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
          setScreen(hasBankingConnection(snapshot.banking) ? 'transactions' : 'connect');
        }
      } catch {
        await api.logout().catch(() => undefined);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadAccount]);

  useEffect(() => {
    if (!user?.id || screen !== 'transactions') return;
    let cancelled = false;

    async function refreshTransactionsPage() {
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true }).catch(() => undefined);
      if (!cancelled && snapshot && isPositiveMinor(stake) && isPositiveMinor(snapshot.wallet.balance)) {
        setScreen('bet');
        setMessage('Payment settled. Choose your game.');
      }
    }

    void refreshTransactionsPage();
    const interval = setInterval(() => void refreshTransactionsPage(), TRANSACTIONS_BACKGROUND_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [loadAccount, screen, user?.id]);

  useEffect(() => {
    if (!message) return;

    messageOpacity.setValue(0);
    Animated.timing(messageOpacity, {
      toValue: 1,
      duration: 180,
      useNativeDriver: true,
    }).start();

    const timeout = setTimeout(() => {
      Animated.timing(messageOpacity, {
        toValue: 0,
        duration: 450,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMessage('');
      });
    }, 4_500);

    return () => {
      clearTimeout(timeout);
      messageOpacity.stopAnimation();
    };
  }, [message, messageOpacity]);

  useEffect(() => {
    if (screen !== 'bet') return;
    gamePagerRef.current?.scrollTo({ x: game === 'roulette' ? gamePanelWidth : 0, animated: false });
  }, [game, gamePanelWidth, screen]);

  useEffect(() => {
    if (screen !== 'transactions') setStakeEditorOpen(false);
  }, [screen]);

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
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
      setPassword('');
      setScreen(hasBankingConnection(snapshot.banking) ? 'transactions' : 'connect');
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
      setStakeInput('');
      setStakeTransactionId(undefined);
      setStakeEditorOpen(false);
      setScreen('connect');
    });
  }

  function closeMessage() {
    Animated.timing(messageOpacity, {
      toValue: 0,
      duration: 180,
      useNativeDriver: true,
    }).start(() => setMessage(''));
  }

  function selectGameFromSwipe(pageIndex: number) {
    const nextGame: Game = pageIndex === 1 ? 'roulette' : 'coin_flip';
    if (nextGame === game) return;

    setGame(nextGame);
    if (nextGame === 'coin_flip') {
      resetRouletteAnimation();
    } else {
      resetCoinAnimation();
    }
    void Haptics.selectionAsync().catch(() => undefined);
  }

  function resetCoinAnimation() {
    coinSpin.stopAnimation();
    coinLift.stopAnimation();
    coinScale.stopAnimation();
    coinSpin.setValue(0);
    coinLift.setValue(0);
    coinScale.setValue(1);
    setCoinAnimationFace(null);
    setCoinAnimationPhase('ready');
  }

  function resetRouletteAnimation() {
    rouletteSpin.stopAnimation();
    rouletteSpin.setValue(0);
    setRouletteResult(null);
    setRouletteIsSpinning(false);
  }

  async function playCoinFlipAnimation(outcome: string | null, won: boolean) {
    const outcomeFace: CoinFace = outcome === 'tails' ? 'tails' : 'heads';
    setCoinAnimationFace(null);
    setCoinAnimationPhase('flipping');
    coinSpin.setValue(0);
    coinLift.setValue(0);
    coinScale.setValue(1);

    await new Promise<void>((resolve) => {
      Animated.parallel([
        Animated.timing(coinSpin, {
          toValue: outcomeFace === 'heads' ? 7 : 7.5,
          duration: 1_850,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.sequence([
          Animated.timing(coinLift, {
            toValue: 1,
            duration: 520,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(coinLift, {
            toValue: 0,
            duration: 1_050,
            easing: Easing.bezier(0.2, 0.9, 0.25, 1),
            useNativeDriver: true,
          }),
        ]),
        Animated.sequence([
          Animated.timing(coinScale, {
            toValue: 1.08,
            duration: 520,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(coinScale, {
            toValue: 0.96,
            duration: 760,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      ]).start(() => {
        coinSpin.setValue(0);
        setCoinAnimationFace(outcomeFace);
        setCoinAnimationPhase('settled');
        void Haptics.notificationAsync(
          won ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
        ).catch(() => undefined);
        Animated.sequence([
          Animated.spring(coinScale, {
            toValue: 1.12,
            damping: 9,
            stiffness: 180,
            mass: 0.7,
            useNativeDriver: true,
          }),
          Animated.spring(coinScale, {
            toValue: 1,
            damping: 10,
            stiffness: 160,
            mass: 0.7,
            useNativeDriver: true,
          }),
        ]).start(() => resolve());
      });
    });

    await sleep(COIN_REVEAL_PAUSE_MS);
  }

  async function playRouletteAnimation(outcome: string | null, won: boolean) {
    const resolvedOutcome = parseRouletteResult(outcome);
    if (!resolvedOutcome) return;

    const winningIndex = EUROPEAN_ROULETTE_WHEEL.findIndex((pocket) => pocket.number === resolvedOutcome.number);
    const finalRotation = 1_440 - winningIndex * ROULETTE_STEP_DEGREES;

    setRouletteResult(null);
    setRouletteIsSpinning(true);
    rouletteSpin.setValue(0);

    await new Promise<void>((resolve) => {
      Animated.timing(rouletteSpin, {
        toValue: finalRotation,
        duration: 2_700,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => {
        setRouletteResult(resolvedOutcome);
        setRouletteIsSpinning(false);
        void Haptics.notificationAsync(
          won ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
        ).catch(() => undefined);
        resolve();
      });
    });

    await sleep(ROULETTE_REVEAL_PAUSE_MS);
  }

  async function waitForSettledDeposit(): Promise<Snapshot | undefined> {
    for (let attempt = 0; attempt < PAYMENT_REFRESH_ATTEMPTS; attempt += 1) {
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
      if (isPositiveMinor(snapshot.wallet.balance)) return snapshot;
      if (attempt < PAYMENT_REFRESH_ATTEMPTS - 1) await sleep(PAYMENT_REFRESH_DELAY_MS);
    }
    return undefined;
  }

  function connectBank() {
    void run(async () => {
      const returnUrl = Linking.createURL('banking-return');
      const result = await api.post<BankingConnectResult>('/banking/connect', undefined, {
        appReturnUrl: returnUrl,
      });
      setBanking(result.overview);
      let browserClosedEarly = false;
      if (result.authorizationUri) {
        const browserResult = await WebBrowser.openAuthSessionAsync(result.authorizationUri, returnUrl);
        if (browserResult.type !== 'success') {
          browserClosedEarly = true;
        }
      }
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
      if (!hasBankingConnection(snapshot.banking)) {
        setMessage(
          browserClosedEarly
            ? 'Open Banking authorisation did not return to the app, and no connection was confirmed yet.'
            : 'Open Banking connection was not confirmed yet.',
        );
        return;
      }
      setScreen('transactions');
      setMessage('Open Banking connected. Choose an amount to stake.');
    });
  }

  function chooseTransaction(transaction: BankTransaction) {
    void Haptics.selectionAsync().catch(() => undefined);
    const selectedStake = absoluteMinor(transaction.amount);
    setStake(selectedStake);
    setStakeInput(formatMinorForPoundsInput(selectedStake));
    setStakeTransactionId(transaction.id);
    setStakeEditorOpen(true);
    setMessage('');
  }

  function clearSelectedStake() {
    setStake('');
    setStakeInput('');
    setStakeTransactionId(undefined);
    setStakeEditorOpen(false);
  }

  function depositStake() {
    void run(async () => {
      if (!isPositiveMinor(stake)) throw new Error('Choose a positive stake amount.');
      setStakeEditorOpen(false);
      const returnUrl = Linking.createURL('banking-return');
      const result = await api.post<BankingMoneyMovementResult>(
        '/banking/deposits',
        { amount: Number(stake), sourceTransactionId: stakeTransactionId },
        { appReturnUrl: returnUrl },
      );

      if (result.authorizationUri) {
        const browserResult = await WebBrowser.openAuthSessionAsync(result.authorizationUri, returnUrl);
        if (browserResult.type !== 'success') {
          const snapshot = await waitForSettledDeposit();
          if (snapshot && isPositiveMinor(snapshot.wallet.balance)) {
            resetCoinAnimation();
            resetRouletteAnimation();
            setScreen('bet');
            setMessage('Payment confirmed. Choose your game.');
            return;
          }
          setScreen('transactions');
          setMessage('Payment authorisation did not return to the app, and the deposit is still processing.');
          return;
        }
      }

      const snapshot = await waitForSettledDeposit();
      if (!snapshot || !isPositiveMinor(snapshot.wallet.balance)) {
        setScreen('transactions');
        setMessage('The payment is still processing. The app will keep checking automatically.');
        return;
      }
      setScreen('bet');
      resetCoinAnimation();
      resetRouletteAnimation();
      setMessage('Stake deposited. Choose your game.');
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
        await playCoinFlipAnimation(result.result, isPositiveMinor(result.payout));
      } else {
        result = await api.post<BetResult>('/bets/roulette', {
          stake: Number(walletBalance),
          betType: rouletteBetType,
          selection: rouletteSelection,
          clientSeed: clientSeed.trim() || undefined,
        });
        await playRouletteAnimation(result.result, isPositiveMinor(result.payout));
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
      setStakeInput('');
      setStakeTransactionId(undefined);
      setStakeEditorOpen(false);
      setClientSeed('');
      await loadAccount({ refreshBanking: true, refreshPayments: true });
      setScreen('transactions');
      setMessage(`Result: ${result.result}. Game payout: ${formatMinor(result.payout)}.${payoutMessage}`);
    });
  }

  function returnToTransactions() {
    setScreen('transactions');
    void loadAccount({ refreshBanking: true, refreshPayments: true });
  }

  async function refreshTransactions() {
    setRefreshingTransactions(true);
    try {
      const snapshot = await loadAccount({ refreshBanking: true, refreshPayments: true });
      if (isPositiveMinor(stake) && isPositiveMinor(snapshot.wallet.balance)) {
        setScreen('bet');
        setMessage('Payment settled. Choose your game.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not refresh transactions.');
    } finally {
      setRefreshingTransactions(false);
    }
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#6c4cff" />
        <Text style={styles.muted}>Restoring your session...</Text>
      </SafeAreaView>
    );
  }

  const headerContent = (
    <View style={styles.header}>
      <View>
        <Text style={styles.eyebrow}>OPEN BANKING BETTING</Text>
        <Text style={styles.logo}>Gamba</Text>
      </View>
      {user ? <ActionButton title="Log out" secondary onPress={logout} disabled={busy} /> : null}
    </View>
  );

  const feedbackContent = (
    <>
      {message ? (
        <Animated.View style={[styles.messageOverlay, { opacity: messageOpacity }]}>
          <View style={styles.messageCard}>
            <Text style={styles.message}>{message}</Text>
            <Pressable accessibilityLabel="Close message" onPress={closeMessage} style={styles.messageClose}>
              <Text style={styles.messageCloseText}>x</Text>
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
      {busy &&
      !(
        screen === 'bet' &&
        ((game === 'coin_flip' && coinAnimationPhase === 'flipping') || (game === 'roulette' && rouletteIsSpinning))
      ) ? (
        <ActivityIndicator style={styles.busy} color="#6c4cff" />
      ) : null}
    </>
  );

  const coinDisplayFace = coinAnimationFace ?? coinSelection;
  const coinMark = coinAnimationPhase === 'flipping' ? '?' : coinDisplayFace === 'heads' ? 'H' : 'T';
  const coinFaceLabel = coinAnimationPhase === 'flipping' ? 'Flipping' : coinDisplayFace === 'heads' ? 'Heads' : 'Tails';
  const coinCaption =
    coinAnimationPhase === 'flipping'
      ? 'Revealing the server result...'
      : coinAnimationPhase === 'settled'
        ? `${coinFaceLabel} landed`
        : 'The result will be revealed after the server settles the bet.';
  const coinRotation = coinSpin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const coinTranslateY = coinLift.interpolate({ inputRange: [0, 1], outputRange: [0, -32] });
  const rouletteResultText = rouletteResult
    ? `Result: ${rouletteResult.number} ${rouletteResult.colour}`
    : rouletteIsSpinning
      ? 'Spinning to the server result...'
      : 'Tap any pocket to bet that number.';
  const rouletteRotation = rouletteSpin.interpolate({ inputRange: [-2_000, 2_000], outputRange: ['-2000deg', '2000deg'] });

  const stakeEditorContent = (
    <Modal
      animationType="fade"
      transparent
      visible={stakeEditorOpen && Boolean(selectedStakeTransaction)}
      onRequestClose={() => setStakeEditorOpen(false)}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.stakeModalBackdrop}
      >
        <View style={styles.stakeModalCard}>
          <View style={styles.stakeModalHeader}>
            <View>
              <Text style={styles.stakeModalKicker}>Selected transaction</Text>
              <Text style={styles.stakeModalTitle}>Adjust your stake</Text>
            </View>
            <Pressable
              accessibilityLabel="Close stake editor"
              onPress={() => setStakeEditorOpen(false)}
              style={styles.stakeModalClose}
            >
              <Text style={styles.stakeModalCloseText}>x</Text>
            </Pressable>
          </View>

          {selectedStakeTransaction ? (
            <>
              <View style={styles.selectedStakeCard}>
                <View style={styles.transactionCopy}>
                  <Text style={styles.transactionName}>
                    {selectedStakeTransaction.merchantName ?? selectedStakeTransaction.description}
                  </Text>
                  <Text style={styles.muted}>{selectedStakeTransaction.category ?? selectedStakeTransaction.direction}</Text>
                </View>
                <Text style={styles.transactionAmount}>
                  {formatMinor(selectedStakeTransaction.amount, selectedStakeTransaction.currency)}
                </Text>
              </View>
              <Text style={styles.muted}>
                This amount is copied from the transaction. Change it here if you want to stake a different amount.
              </Text>
              <View style={styles.moneyInputShell}>
                <Text style={styles.moneyInputPrefix}>{'\u00a3'}</Text>
                <TextInput
                  keyboardType="decimal-pad"
                  onChangeText={(value) => {
                    const normalisedValue = normalisePoundsInput(value);
                    setStakeInput(normalisedValue);
                    setStake(poundsInputToMinor(normalisedValue));
                  }}
                  placeholder="10.00"
                  style={styles.moneyInput}
                  value={stakeInput}
                />
              </View>
              <ActionButton title="Deposit and continue" onPress={depositStake} disabled={busy || !isPositiveMinor(stake)} />
              <ActionButton
                title="Choose another transaction"
                secondary
                onPress={clearSelectedStake}
                disabled={busy}
              />
            </>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );

  const transactionsContent = (
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

      <View style={styles.stakePromptCard}>
        <Text style={styles.title}>Choose your stake</Text>
        <Text style={styles.muted}>
          Tap one of your current account transactions below. The app will copy that amount, then let you adjust it before
          depositing.
        </Text>
        {selectedStakeTransaction ? (
          <View style={styles.selectedStakePrompt}>
            <View style={styles.transactionCopy}>
              <Text style={styles.transactionName}>
                {selectedStakeTransaction.merchantName ?? selectedStakeTransaction.description}
              </Text>
              <Text style={styles.muted}>Selected stake: {formatMinor(stake || '0', selectedStakeTransaction.currency)}</Text>
            </View>
            <View style={styles.selectedStakeActions}>
              <Pressable onPress={() => setStakeEditorOpen(true)} style={styles.stakeInlineButton}>
                <Text style={styles.transactionCta}>Adjust</Text>
              </Pressable>
              <Pressable
                disabled={busy || !isPositiveMinor(stake)}
                onPress={depositStake}
                style={[styles.stakeInlineButton, styles.stakeInlineButtonPrimary, (busy || !isPositiveMinor(stake)) && styles.buttonDisabled]}
              >
                <Text style={styles.stakeInlineButtonPrimaryText}>Deposit</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>

      <View style={styles.activityTabs}>
        <Pressable
          onPress={() => setActivityView('transactions')}
          style={[styles.activityTab, activityView === 'transactions' && styles.activityTabSelected]}
        >
          <Text style={[styles.activityTabText, activityView === 'transactions' && styles.activityTabTextSelected]}>
            Recent transactions
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setActivityView('bets')}
          style={[styles.activityTab, activityView === 'bets' && styles.activityTabSelected]}
        >
          <Text style={[styles.activityTabText, activityView === 'bets' && styles.activityTabTextSelected]}>Recent bets</Text>
        </Pressable>
      </View>
      <ScrollView
        style={styles.transactionsScroller}
        contentContainerStyle={styles.transactionsListContent}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            colors={['#9ca3af']}
            refreshing={refreshingTransactions}
            tintColor="#9ca3af"
            onRefresh={() => void refreshTransactions()}
          />
        }
      >
        {activityView === 'transactions' && banking?.transactions.length ? (
          banking.transactions.map((transaction) => (
            <Pressable
              key={transaction.id}
              onPress={() => chooseTransaction(transaction)}
              style={[styles.transaction, stakeTransactionId === transaction.id && styles.transactionSelected]}
            >
              <View style={styles.transactionCopy}>
                <Text style={styles.transactionName}>{transaction.merchantName ?? transaction.description}</Text>
                <Text style={styles.muted}>{transaction.category ?? transaction.direction}</Text>
              </View>
              <View style={styles.transactionRight}>
                <Text style={styles.transactionAmount}>{formatMinor(transaction.amount, transaction.currency)}</Text>
                <Text style={styles.transactionCta}>
                  {stakeTransactionId === transaction.id ? 'Adjust stake' : 'Use as stake'}
                </Text>
              </View>
            </Pressable>
          ))
        ) : activityView === 'bets' && bets.length ? (
          bets.map((bet) => (
            <View key={bet.id} style={styles.betRow}>
              <Text style={styles.transactionName}>
                {bet.gameType}: {bet.selection} to {bet.result}
              </Text>
              <Text style={styles.muted}>Stake {formatMinor(bet.stake)} / payout {formatMinor(bet.payout)}</Text>
            </View>
          ))
        ) : activityView === 'bets' ? (
          <Text style={styles.empty}>No bets yet.</Text>
        ) : (
          <Text style={styles.empty}>No transactions yet. The app refreshes your current account automatically.</Text>
        )}
      </ScrollView>
    </>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      {stakeEditorContent}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {user && screen === 'transactions' ? (
          <View style={styles.transactionPage}>
            {headerContent}
            {feedbackContent}
            {transactionsContent}
          </View>
        ) : (
          <ScrollView contentContainerStyle={[styles.page, user && screen === 'bet' && styles.betPage]} keyboardShouldPersistTaps="handled">
            {headerContent}
            {feedbackContent}

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
                <Text style={styles.help}>
                  Google sign-in remains available on the web client but needs a separate native OAuth exchange before it should
                  be enabled here.
                </Text>
              </View>
            ) : screen === 'connect' ? (
              <View style={styles.card}>
                <Text style={styles.step}>STEP 1</Text>
                <Text style={styles.title}>Connect your current account</Text>
                <Text style={styles.muted}>Open the TrueLayer sandbox, authorise access, and return directly to this app.</Text>
                <ActionButton title="Connect Open Banking" onPress={connectBank} disabled={busy} />
              </View>
            ) : screen === 'transactions' ? (
              transactionsContent
            ) : (
              <>
                <View style={[styles.card, styles.betCard]}>
                  <Text style={styles.balanceHero}>{formatMinor(walletBalance, wallet?.currency)}</Text>

                  <Text style={styles.gameSwipeHint}>Swipe to choose game</Text>
                  <ScrollView
                    ref={gamePagerRef}
                    horizontal
                    pagingEnabled
                    snapToInterval={gamePanelWidth}
                    decelerationRate="fast"
                    showsHorizontalScrollIndicator={false}
                    style={styles.gamePager}
                    keyboardShouldPersistTaps="handled"
                    onMomentumScrollEnd={(event) => {
                      const pageIndex = Math.round(event.nativeEvent.contentOffset.x / gamePanelWidth);
                      selectGameFromSwipe(pageIndex);
                    }}
                  >
                    <View style={[styles.gamePanel, { width: gamePanelWidth }]}>
                      <View style={styles.coinStage}>
                        <Animated.View
                          style={[
                            styles.coin,
                            {
                              transform: [
                                { perspective: 800 },
                                { translateY: coinTranslateY },
                                { rotateY: coinRotation },
                                { scale: coinScale },
                              ],
                            },
                          ]}
                        >
                          <View style={styles.coinInnerRing}>
                            <Text style={styles.coinMark}>{coinMark}</Text>
                            <Text style={styles.coinFaceLabel}>{coinFaceLabel}</Text>
                          </View>
                        </Animated.View>
                        <Text style={styles.coinCaption}>{coinCaption}</Text>
                      </View>

                      <View style={styles.choiceRow}>
                        <ChoiceButton selected={coinSelection === 'heads'} label="Heads" onPress={() => setCoinSelection('heads')} />
                        <ChoiceButton selected={coinSelection === 'tails'} label="Tails" onPress={() => setCoinSelection('tails')} />
                      </View>
                    </View>

                    <View style={[styles.gamePanel, { width: gamePanelWidth }]}>
                      <View style={styles.rouletteStage}>
                        <Text style={styles.rouletteTitle}>{rouletteResultText}</Text>
                        <View style={styles.rouletteWheelFrame}>
                          <View style={styles.roulettePointer} />
                          <Animated.View
                            style={[
                              styles.rouletteWheel,
                              {
                                transform: [{ rotate: rouletteRotation }],
                              },
                            ]}
                          >
                            <Svg width={ROULETTE_WHEEL_SIZE} height={ROULETTE_WHEEL_SIZE} viewBox={`0 0 ${ROULETTE_WHEEL_SIZE} ${ROULETTE_WHEEL_SIZE}`}>
                              <Circle
                                cx={ROULETTE_WHEEL_SIZE / 2}
                                cy={ROULETTE_WHEEL_SIZE / 2}
                                r={ROULETTE_WHEEL_RADIUS}
                                fill="#17132d"
                              />
                              {EUROPEAN_ROULETTE_WHEEL.map((pocket, pocketIndex) => {
                                const isResult = rouletteResult?.number === pocket.number;
                                const isSelected = rouletteBetType === 'number' && rouletteSelection === String(pocket.number);
                                const label = rouletteLabelPosition(pocketIndex);

                                return (
                                  <G
                                    key={pocket.number}
                                    onPress={() => {
                                      setRouletteBetType('number');
                                      setRouletteSelection(String(pocket.number));
                                      resetRouletteAnimation();
                                    }}
                                  >
                                    <Path
                                      d={describeRouletteSlice(pocketIndex)}
                                      fill={roulettePocketFill(pocket.colour)}
                                      stroke={isResult ? '#f6c65b' : isSelected ? '#6c4cff' : 'rgba(255,255,255,0.26)'}
                                      strokeWidth={isResult ? 3 : isSelected ? 2 : 1}
                                    />
                                    <SvgText
                                      x={label.x}
                                      y={label.y}
                                      fill="#ffffff"
                                      fontSize="10"
                                      fontWeight="900"
                                      textAnchor="middle"
                                      alignmentBaseline="middle"
                                    >
                                      {pocket.number}
                                    </SvgText>
                                  </G>
                                );
                              })}
                              <Circle
                                cx={ROULETTE_WHEEL_SIZE / 2}
                                cy={ROULETTE_WHEEL_SIZE / 2}
                                r={ROULETTE_WHEEL_RADIUS}
                                fill="transparent"
                                stroke="#ffffff"
                                strokeWidth="8"
                              />
                              <Circle
                                cx={ROULETTE_WHEEL_SIZE / 2}
                                cy={ROULETTE_WHEEL_SIZE / 2}
                                r={ROULETTE_HUB_RADIUS}
                                fill="#f6c65b"
                                stroke="#ffe8a8"
                                strokeWidth="4"
                              />
                              <SvgText
                                x={ROULETTE_WHEEL_SIZE / 2}
                                y={ROULETTE_WHEEL_SIZE / 2 + 2}
                                fill="#4a358f"
                                fontSize="28"
                                fontWeight="900"
                                textAnchor="middle"
                                alignmentBaseline="middle"
                              >
                                G
                              </SvgText>
                            </Svg>
                          </Animated.View>
                        </View>
                        <View style={styles.rouletteLegend}>
                          <Text style={[styles.rouletteLegendItem, styles.rouletteLegendRed]}>Red</Text>
                          <Text style={[styles.rouletteLegendItem, styles.rouletteLegendBlack]}>Black</Text>
                          <Text style={[styles.rouletteLegendItem, styles.rouletteLegendGreen]}>0 Green</Text>
                        </View>
                      </View>

                      <View style={styles.choiceRow}>
                        <ChoiceButton
                          selected={rouletteBetType === 'colour'}
                          label="Colour"
                          onPress={() => {
                            setRouletteBetType('colour');
                            setRouletteSelection('red');
                            resetRouletteAnimation();
                          }}
                        />
                        <ChoiceButton
                          selected={rouletteBetType === 'number'}
                          label="Number"
                          onPress={() => {
                            setRouletteBetType('number');
                            setRouletteSelection('0');
                            resetRouletteAnimation();
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
                              onPress={() => {
                                setRouletteSelection(colour);
                                resetRouletteAnimation();
                              }}
                            />
                          ))}
                        </View>
                      ) : (
                        <TextInput
                          keyboardType="number-pad"
                          onChangeText={(value) => {
                            setRouletteSelection(value);
                            resetRouletteAnimation();
                          }}
                          placeholder="Number from 0 to 36"
                          style={styles.input}
                          value={rouletteSelection}
                        />
                      )}
                    </View>
                  </ScrollView>

                  <View style={styles.gameDots}>
                    <View style={[styles.gameDot, game === 'coin_flip' && styles.gameDotSelected]} />
                    <View style={[styles.gameDot, game === 'roulette' && styles.gameDotSelected]} />
                  </View>

                  <ActionButton title="Place bet" onPress={placeBet} disabled={busy || !isPositiveMinor(walletBalance)} />
                </View>
              </>
            )}
          </ScrollView>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#f5f3ff' },
  loadingScreen: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, backgroundColor: '#f5f3ff' },
  page: { padding: 20, paddingBottom: 64, gap: 16 },
  betPage: { flexGrow: 1, paddingBottom: 20 },
  transactionPage: { flex: 1, padding: 20, paddingBottom: 24, gap: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  eyebrow: { color: '#6c4cff', fontSize: 11, fontWeight: '800', letterSpacing: 1.5 },
  logo: { color: '#17132d', fontSize: 34, fontWeight: '900' },
  card: { backgroundColor: '#ffffff', borderRadius: 24, padding: 20, gap: 14, shadowColor: '#24184f', shadowOpacity: 0.08, shadowRadius: 18, elevation: 3 },
  betCard: { flexGrow: 1, gap: 12, padding: 16 },
  step: { color: '#6c4cff', fontSize: 12, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: '#17132d', fontSize: 25, fontWeight: '800' },
  muted: { color: '#746f86', fontSize: 14, lineHeight: 20 },
  help: { color: '#8a8499', fontSize: 12, lineHeight: 17, textAlign: 'center' },
  messageOverlay: { position: 'absolute', top: 86, left: 20, right: 20, zIndex: 20, elevation: 20 },
  messageCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#e8e2ff',
    borderRadius: 14,
    paddingLeft: 14,
    paddingVertical: 12,
    paddingRight: 8,
    shadowColor: '#24184f',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    elevation: 5,
  },
  message: { flex: 1, color: '#35285f', lineHeight: 20, paddingRight: 8 },
  messageClose: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  messageCloseText: { color: '#4a358f', fontSize: 16, fontWeight: '900', lineHeight: 18 },
  busy: { marginVertical: 4 },
  input: { minHeight: 50, borderWidth: 1, borderColor: '#ddd7ef', borderRadius: 14, paddingHorizontal: 14, color: '#17132d', backgroundColor: '#fbfaff', fontSize: 16 },
  moneyInputShell: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#ddd7ef',
    borderRadius: 14,
    paddingHorizontal: 14,
    backgroundColor: '#fbfaff',
  },
  moneyInputPrefix: { color: '#17132d', fontSize: 16, fontWeight: '800', paddingRight: 8 },
  moneyInput: { flex: 1, color: '#17132d', fontSize: 16, paddingVertical: 0 },
  button: { minHeight: 48, paddingHorizontal: 16, borderRadius: 14, backgroundColor: '#6c4cff', alignItems: 'center', justifyContent: 'center' },
  buttonSecondary: { backgroundColor: '#eeeafd' },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { transform: [{ scale: 0.98 }] },
  buttonText: { color: '#ffffff', fontWeight: '800', textAlign: 'center' },
  buttonSecondaryText: { color: '#4a358f' },
  summaryRow: { flexDirection: 'row', gap: 12 },
  summaryCard: { flex: 1, minHeight: 72, backgroundColor: '#17132d', borderRadius: 20, padding: 14, justifyContent: 'center', gap: 6 },
  summaryLabel: { color: '#aaa2c4', fontSize: 12 },
  summaryValue: { color: '#ffffff', fontSize: 19, fontWeight: '800' },
  stakePromptCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 20,
    gap: 12,
    borderWidth: 2,
    borderColor: '#d9d0ff',
    shadowColor: '#24184f',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    elevation: 3,
  },
  selectedStakePrompt: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#f1edff',
    borderWidth: 1,
    borderColor: '#cfc3ff',
  },
  selectedStakeActions: { alignItems: 'flex-end', gap: 8 },
  stakeInlineButton: {
    minWidth: 78,
    minHeight: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    backgroundColor: '#eeeafd',
  },
  stakeInlineButtonPrimary: { backgroundColor: '#6c4cff' },
  stakeInlineButtonPrimaryText: { color: '#ffffff', fontSize: 12, fontWeight: '900' },
  stakeModalBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    padding: 16,
    backgroundColor: 'rgba(23,19,45,0.42)',
  },
  stakeModalCard: {
    backgroundColor: '#ffffff',
    borderRadius: 24,
    padding: 20,
    gap: 14,
    shadowColor: '#24184f',
    shadowOpacity: 0.18,
    shadowRadius: 24,
    elevation: 12,
  },
  stakeModalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 },
  stakeModalKicker: { color: '#6c4cff', fontSize: 11, fontWeight: '900', letterSpacing: 1 },
  stakeModalTitle: { color: '#17132d', fontSize: 24, fontWeight: '900' },
  stakeModalClose: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eeeafd',
  },
  stakeModalCloseText: { color: '#4a358f', fontSize: 18, fontWeight: '900', lineHeight: 20 },
  selectedStakeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: '#f6f2ff',
  },
  sectionTitle: { color: '#17132d', fontSize: 20, fontWeight: '800', marginTop: 8 },
  activityTabs: { flexDirection: 'row', gap: 8 },
  activityTab: {
    flex: 1,
    minHeight: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#eeeafd',
    paddingHorizontal: 10,
  },
  activityTabSelected: { backgroundColor: '#6c4cff' },
  activityTabText: { color: '#4a358f', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  activityTabTextSelected: { color: '#ffffff' },
  transactionsScroller: { flex: 1 },
  transactionsListContent: { flexGrow: 1, gap: 8, paddingBottom: 48 },
  transaction: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', padding: 16, borderRadius: 16, borderWidth: 2, borderColor: 'transparent' },
  transactionSelected: { borderColor: '#6c4cff', backgroundColor: '#f1edff' },
  transactionCopy: { flex: 1, paddingRight: 12 },
  transactionName: { color: '#211b35', fontSize: 15, fontWeight: '700' },
  transactionRight: { alignItems: 'flex-end', gap: 4 },
  transactionAmount: { color: '#211b35', fontWeight: '800' },
  transactionCta: { color: '#6c4cff', fontSize: 12, fontWeight: '900' },
  empty: { color: '#746f86', backgroundColor: '#ffffff', padding: 20, borderRadius: 16 },
  balanceHero: { color: '#17132d', fontSize: 32, fontWeight: '900', marginBottom: 4 },
  gameSwipeHint: { color: '#6d6289', fontSize: 13, fontWeight: '800', textAlign: 'center', marginTop: -2 },
  gamePager: { alignSelf: 'stretch', flexGrow: 0 },
  gamePanel: { gap: 12 },
  gameDots: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  gameDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#d6cef7' },
  gameDotSelected: { width: 22, backgroundColor: '#6c4cff' },
  coinStage: {
    flexGrow: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    minHeight: 390,
    paddingVertical: 22,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e2dcff',
    borderRadius: 18,
    backgroundColor: '#f6f2ff',
    overflow: 'hidden',
  },
  coin: {
    width: 226,
    height: 226,
    borderRadius: 113,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f6c65b',
    borderWidth: 4,
    borderColor: '#ffe8a8',
    shadowColor: '#6c4cff',
    shadowOpacity: 0.24,
    shadowRadius: 18,
    elevation: 8,
  },
  coinInnerRing: {
    width: 172,
    height: 172,
    borderRadius: 86,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff2c7',
    backgroundColor: '#ffd66e',
  },
  coinMark: { color: '#4a358f', fontSize: 84, fontWeight: '900', lineHeight: 88 },
  coinFaceLabel: { color: '#6f5013', fontSize: 15, fontWeight: '900', letterSpacing: 1 },
  coinCaption: { color: '#6d6289', fontSize: 13, fontWeight: '700', textAlign: 'center', paddingHorizontal: 16 },
  rouletteStage: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2dcff',
    borderRadius: 18,
    backgroundColor: '#f6f2ff',
  },
  rouletteTitle: { color: '#4a358f', fontSize: 13, fontWeight: '800', textAlign: 'center' },
  rouletteWheelFrame: {
    width: ROULETTE_WHEEL_SIZE,
    height: ROULETTE_WHEEL_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roulettePointer: {
    position: 'absolute',
    top: -2,
    zIndex: 5,
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderTopWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#6c4cff',
  },
  rouletteWheel: {
    width: ROULETTE_WHEEL_SIZE,
    height: ROULETTE_WHEEL_SIZE,
    borderRadius: ROULETTE_WHEEL_SIZE / 2,
    backgroundColor: '#17132d',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#6c4cff',
    shadowOpacity: 0.2,
    shadowRadius: 18,
    elevation: 8,
  },
  rouletteLegend: { flexDirection: 'row', justifyContent: 'center', gap: 8, flexWrap: 'wrap' },
  rouletteLegendItem: { fontSize: 12, fontWeight: '900' },
  rouletteLegendRed: { color: '#d83a4b' },
  rouletteLegendBlack: { color: '#1f1a2d' },
  rouletteLegendGreen: { color: '#189b67' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { flexGrow: 1, minWidth: 82, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 12, backgroundColor: '#eeeafd', alignItems: 'center' },
  choiceSelected: { backgroundColor: '#6c4cff' },
  choiceText: { color: '#4a358f', fontWeight: '700' },
  choiceTextSelected: { color: '#ffffff' },
  betRow: { backgroundColor: '#ffffff', borderRadius: 16, padding: 16, gap: 5 },
});
