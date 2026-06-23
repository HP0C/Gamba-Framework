import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class GoogleConfiguredGuard {
  constructor(private readonly config: ConfigService) {}

  canActivate(): true {
    if (!this.config.get('GOOGLE_CLIENT_ID') || !this.config.get('GOOGLE_CLIENT_SECRET')) {
      throw new ServiceUnavailableException('Google OAuth is not configured');
    }
    return true;
  }
}

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {}
