import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TokenPayload } from './auth.types';

@Injectable()
export class AuthManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  hashPassword(password: string): Promise<string> {
    // Argon2id is a slow password hashing algorithm. Store only this hash, never
    // the user's plain password.
    return argon2.hash(password, { type: argon2.argon2id });
  }

  verifyPassword(hash: string, password: string): Promise<boolean> {
    // Argon2 verifies by hashing the submitted password and comparing safely.
    return argon2.verify(hash, password);
  }

  async createSession(userId: string, context: { ipAddress?: string; userAgent?: string }) {
    // One database Session represents one browser/device login. The JWT includes
    // the session id so we can later revoke or rotate that specific login.
    const sessionId = randomUUID();
    const accessTtl = Number(this.config.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    const refreshTtl = Number(this.config.get('JWT_REFRESH_TTL_SECONDS') ?? 604800);
    // Access tokens are short-lived and used for ordinary protected API requests.
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, type: 'access' } satisfies TokenPayload,
      { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: accessTtl },
    );
    // Refresh tokens last longer and are used only to create a replacement session.
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, type: 'refresh' } satisfies TokenPayload,
      { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: refreshTtl },
    );
    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId,
        // Store a hash of the refresh token so a database leak does not hand out
        // ready-to-use browser tokens.
        refreshTokenHash: await argon2.hash(refreshToken, { type: argon2.argon2id }),
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
    });
    return { accessToken, refreshToken, accessTtl, refreshTtl };
  }

  async rotateSession(refreshToken: string, context: { ipAddress?: string; userAgent?: string }) {
    let payload: TokenPayload;
    try {
      // First prove the token was signed by this backend and has not expired.
      payload = await this.jwt.verifyAsync<TokenPayload>(refreshToken, {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid refresh token');
    const session = await this.prisma.session.findUnique({ where: { id: payload.sid } });
    // Then prove the token belongs to an active stored session and matches the
    // hashed refresh token saved when the session was created.
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      !(await argon2.verify(session.refreshTokenHash, refreshToken))
    ) {
      throw new UnauthorizedException('Refresh session is no longer valid');
    }
    // Revoke the old session before issuing a new one. This is refresh rotation.
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.createSession(session.userId, context);
  }

  revokeSession(sessionId: string): Promise<unknown> {
    // updateMany makes logout harmless if the session was already revoked.
    return this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
