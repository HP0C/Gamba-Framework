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
    return argon2.hash(password, { type: argon2.argon2id });
  }

  verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }

  async createSession(userId: string, context: { ipAddress?: string; userAgent?: string }) {
    const sessionId = randomUUID();
    const accessTtl = Number(this.config.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    const refreshTtl = Number(this.config.get('JWT_REFRESH_TTL_SECONDS') ?? 604800);
    const accessToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, type: 'access' } satisfies TokenPayload,
      { secret: this.config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: accessTtl },
    );
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, sid: sessionId, type: 'refresh' } satisfies TokenPayload,
      { secret: this.config.getOrThrow('JWT_REFRESH_SECRET'), expiresIn: refreshTtl },
    );
    await this.prisma.session.create({
      data: {
        id: sessionId,
        userId,
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
      payload = await this.jwt.verifyAsync<TokenPayload>(refreshToken, {
        secret: this.config.getOrThrow('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.type !== 'refresh') throw new UnauthorizedException('Invalid refresh token');
    const session = await this.prisma.session.findUnique({ where: { id: payload.sid } });
    if (
      !session ||
      session.userId !== payload.sub ||
      session.revokedAt ||
      session.expiresAt <= new Date() ||
      !(await argon2.verify(session.refreshTokenHash, refreshToken))
    ) {
      throw new UnauthorizedException('Refresh session is no longer valid');
    }
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.createSession(session.userId, context);
  }

  revokeSession(sessionId: string): Promise<unknown> {
    return this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
