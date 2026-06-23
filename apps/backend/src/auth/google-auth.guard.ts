import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleConfiguredGuard {
  constructor(private readonly config: ConfigService) {}

  canActivate(): true {
    // Make unfinished OAuth setup obvious instead of silently redirecting with
    // dummy credentials.
    if (!this.config.get('GOOGLE_CLIENT_ID') || !this.config.get('GOOGLE_CLIENT_SECRET')) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }
    return true;
  }
}

@Injectable()
// This guard starts or completes the Google OAuth Passport flow depending on
// whether the request is /auth/google or /auth/google/callback.
export class GoogleAuthGuard extends AuthGuard('google') {}
