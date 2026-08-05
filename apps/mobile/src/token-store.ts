import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { AuthTokens } from './types';

const ACCESS_TOKEN_KEY = 'gamba.accessToken';
const REFRESH_TOKEN_KEY = 'gamba.refreshToken';

async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.localStorage?.getItem(key) ?? null;
  return SecureStore.getItemAsync(key);
}

async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function removeItem(key: string): Promise<void> {
  if (Platform.OS === 'web') {
    globalThis.localStorage?.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export const tokenStore = {
  getAccessToken: () => getItem(ACCESS_TOKEN_KEY),
  getRefreshToken: () => getItem(REFRESH_TOKEN_KEY),
  async save(tokens: AuthTokens) {
    await Promise.all([
      setItem(ACCESS_TOKEN_KEY, tokens.accessToken),
      setItem(REFRESH_TOKEN_KEY, tokens.refreshToken),
    ]);
  },
  async clear() {
    await Promise.all([removeItem(ACCESS_TOKEN_KEY), removeItem(REFRESH_TOKEN_KEY)]);
  },
};
