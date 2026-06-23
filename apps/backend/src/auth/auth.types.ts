export interface TokenPayload {
  // JWT standard subject. Here it is always the User.id.
  sub: string;
  // Session id. Lets us revoke one browser/device without deleting the user.
  sid: string;
  // Keeps access tokens and refresh tokens from being accepted in the wrong place.
  type: 'access' | 'refresh';
}

export interface AuthenticatedUser {
  // This is the trusted identity controllers should use after JwtAuthGuard runs.
  userId: string;
  sessionId: string;
}

export interface GoogleProfileUser {
  // Local user id returned by UsersManager.upsertGoogle().
  id: string;
  email: string;
  username: string;
}
