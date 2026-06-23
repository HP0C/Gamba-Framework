import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import { UsersManager } from '../users/users.manager';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(config: ConfigService, private readonly users: UsersManager) {
    super({
      // Placeholder values let the app boot locally. GoogleConfiguredGuard blocks
      // these routes until real credentials are provided.
      clientID: config.get<string>('GOOGLE_CLIENT_ID') || 'not-configured',
      clientSecret: config.get<string>('GOOGLE_CLIENT_SECRET') || 'not-configured',
      callbackURL: config.get<string>('GOOGLE_CALLBACK_URL') || 'http://localhost:3000/api/auth/google/callback',
      scope: ['email', 'profile'],
    });
  }

  async validate(_accessToken: string, _refreshToken: string, profile: Profile) {
    // Passport calls validate after Google accepts the login. Return value becomes
    // req.user in AuthController.googleCallback().
    const email = profile.emails?.[0]?.value;
    if (!email) return false;
    // Production account linking needs more review: verified emails, collision
    // handling, takeover protection, and audit evidence.
    return this.users.upsertGoogle({
      googleId: profile.id,
      email,
      username: `google_${profile.id.slice(0, 20)}`,
    });
  }
}
