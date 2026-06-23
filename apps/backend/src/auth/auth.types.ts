export interface TokenPayload {
  sub: string;
  sid: string;
  type: 'access' | 'refresh';
}

export interface GoogleProfileUser {
  id: string;
  email: string;
  username: string;
}
