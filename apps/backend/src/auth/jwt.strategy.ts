import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { TokenPayload } from './auth.types';

// Passport-JWT normally reads Authorization headers. This app mainly uses
// HTTP-only cookies, so this extractor teaches Passport where access_token lives.
const cookieExtractor = (request: Request): string | null =>
  (request.cookies as Record<string, string> | undefined)?.access_token ?? null;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      // Accept cookies for browsers and Bearer tokens for tools such as Postman.
      jwtFromRequest: ExtractJwt.fromExtractors([cookieExtractor, ExtractJwt.fromAuthHeaderAsBearerToken()]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
  }

  validate(payload: TokenPayload) {
    // Only access tokens may pass JwtAuthGuard. Refresh tokens are deliberately
    // rejected here and can only be used by POST /auth/refresh.
    if (payload.type !== 'access') return false;
    // Whatever this returns becomes request.user for protected controllers.
    return { userId: payload.sub, sessionId: payload.sid };
  }
}
