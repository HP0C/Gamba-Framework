import { AuthTokens, User } from './types';
import { tokenStore } from './token-store';

export const API_URL = (process.env.EXPO_PUBLIC_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface RequestOptions extends RequestInit {
  appReturnUrl?: string;
}

interface MobileAuthResponse {
  user: User;
  tokens: AuthTokens;
}

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const refreshToken = await tokenStore.getRefreshToken();
    if (!refreshToken || !API_URL) return false;

    const response = await fetch(`${API_URL}/auth/mobile/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!response.ok) {
      accessToken = null;
      await tokenStore.clear();
      return false;
    }

    const body = (await response.json()) as { tokens: AuthTokens };
    accessToken = body.tokens.accessToken;
    await tokenStore.save(body.tokens);
    return true;
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

async function request<T>(path: string, options: RequestOptions = {}, retry = true): Promise<T> {
  if (!API_URL) throw new ApiError('Set EXPO_PUBLIC_API_URL in apps/mobile/.env before starting Expo.', 0);
  accessToken ??= await tokenStore.getAccessToken();

  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (options.appReturnUrl) headers.set('X-App-Return-Url', options.appReturnUrl);

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  if (response.status === 401 && retry && !path.startsWith('/auth/mobile/')) {
    if (await refreshAccessToken()) return request<T>(path, options, false);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    throw new ApiError(message ?? `Request failed (${response.status})`, response.status);
  }
  return response.json() as Promise<T>;
}

async function authenticate(path: '/auth/mobile/login' | '/auth/mobile/register', body: unknown) {
  const result = await request<MobileAuthResponse>(path, { method: 'POST', body: JSON.stringify(body) });
  accessToken = result.tokens.accessToken;
  await tokenStore.save(result.tokens);
  return result.user;
}

export const api = {
  restoreSession: refreshAccessToken,
  login: (login: string, password: string) => authenticate('/auth/mobile/login', { login, password }),
  register: (email: string, username: string, password: string) =>
    authenticate('/auth/mobile/register', { email, username, password }),
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown, options?: Pick<RequestOptions, 'appReturnUrl'>) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...options,
    }),
  async logout() {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      accessToken = null;
      await tokenStore.clear();
    }
  },
};
