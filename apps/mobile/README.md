# Gamba Mobile

This Expo/React Native app uses the existing NestJS API. It is a native client, not a WebView. Password authentication uses dedicated mobile endpoints and stores the access and refresh JWTs with Expo SecureStore. TrueLayer pages open in the system authentication browser and return through the `gamba://banking-return` deep link.

## What You Need

- Node.js 20 or newer. Check with `node --version`.
- Docker Desktop for the backend and PostgreSQL.
- Expo Go on an Android or iOS phone for quick UI/API testing.
- Android Studio if you want an Android emulator or a native development build on Windows.

The computer and physical phone must normally be on the same Wi-Fi network. A phone cannot reach your computer through `localhost` because `localhost` on the phone means the phone itself.

## 1. Configure The API URL

From the repository root:

```powershell
Copy-Item apps/mobile/.env.example apps/mobile/.env
```

Edit `apps/mobile/.env` and choose one URL:

```env
# Physical phone on the same Wi-Fi (replace this with your computer's IPv4 address)
EXPO_PUBLIC_API_URL=http://192.168.1.100:3000/api

# Android Studio emulator
EXPO_PUBLIC_API_URL=http://10.0.2.2:3000/api

# Public/deployed backend, recommended for complete TrueLayer testing
EXPO_PUBLIC_API_URL=https://gamba-framework.onrender.com/api
```

Run `ipconfig` in PowerShell and look for the active Wi-Fi adapter's `IPv4 Address` to find the LAN address. Do not put secrets in `EXPO_PUBLIC_` variables because Expo embeds them in the app bundle.

## 2. Start The Backend

```powershell
docker compose up -d --build postgres backend
docker compose logs -f backend
```

The final backend log should say that the Nest application successfully started. Test network access from the phone by opening this in the phone browser, replacing the IP:

```text
http://192.168.1.100:3000/api/auth/me
```

A `401 Unauthorized` response is expected before login. A timeout or connection error means the phone cannot reach the backend; check the IP address, Wi-Fi network, Docker, and Windows Firewall.

## 3. Install And Start Expo

Use Node 20 or newer on the host machine, then run:

```powershell
npm install
npm run mobile:start
```

The Expo terminal displays a QR code:

- Android: scan it from Expo Go.
- iPhone: scan it with the Camera app and open Expo Go.
- Android emulator: press `a` in the Expo terminal.
- If LAN discovery fails, stop Expo and run `npm run start -w @gamba/mobile -- --tunnel`.

After changing `apps/mobile/.env`, perform a full reload in Expo Go.

## 4. First Test

Test in this order so a failure is easier to locate:

1. Register a new account with a unique email, username, and a password of at least 12 characters.
2. Close and reopen Expo Go. The SecureStore refresh token should restore the session.
3. Log out and log in again.
4. Connect Open Banking.
5. Sync and select a previous transaction, or enter a custom amount in pence.
6. Complete the TrueLayer payment and confirm that the app returns to the bet screen.
7. Place a coin flip and then a roulette bet.
8. Confirm that a win triggers the payout request and returns to transactions.
9. Check `Wallet`, `WalletTransaction`, `BankingPayment`, `BankingPayout`, and `Bet` in Prisma Studio.

Open Prisma Studio with:

```powershell
docker compose --profile tools up -d studio
```

Then visit <http://localhost:5555> on the computer.

## TrueLayer Redirect Testing

Expo Go is suitable for UI, password authentication, API, and basic deep-link testing. Its `exp://...` callback address changes with the development server, so it is not a stable authorization callback.

For the simplest complete TrueLayer test, use the deployed Render backend:

1. Deploy the backend changes.
2. Set `EXPO_PUBLIC_API_URL` to the Render API URL.
3. Set this Render environment variable while testing Expo Go:

```env
MOBILE_APP_ALLOWED_SCHEMES=gamba,exp,exps
```

4. Keep the TrueLayer Console redirect URIs pointing to the public Render backend callbacks, not directly to Expo:

```text
https://gamba-framework.onrender.com/api/banking/truelayer/callback
https://gamba-framework.onrender.com/api/banking/truelayer/payment-callback
```

The flow is TrueLayer -> Render callback -> app deep link. The mobile app supplies its return URL in an authenticated request, and the backend accepts only schemes listed in `MOBILE_APP_ALLOWED_SCHEMES`.

For a stable `gamba://` callback, create an Android development build:

```powershell
cd apps/mobile
npx expo run:android
```

This requires Android Studio and an emulator/device. On Windows, a local iOS build is not possible; use Expo Go for early iOS testing or an EAS cloud build later. Once Expo Go testing is finished, production should use the narrower setting:

```env
MOBILE_APP_ALLOWED_SCHEMES=gamba
```

## Automated Checks

From the repository root:

```powershell
npm run mobile:typecheck
docker build -f apps/mobile/Dockerfile -t gambaserver-mobile-check .
docker compose build backend frontend
npm test -w @gamba/backend
```

The mobile Docker build type-checks the app and makes an Android JavaScript bundle. It does not produce a signed APK or App Store build.

## Current Native Limitation

Google sign-in is deliberately not exposed in the mobile UI yet. The current Google callback creates browser cookies, while the native app uses bearer tokens in SecureStore. A proper mobile Google OAuth flow needs a short-lived authorization-code exchange; putting JWTs in a deep-link URL would expose them and should not be used as a shortcut.
