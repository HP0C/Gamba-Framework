import { ConflictException, Injectable } from '@nestjs/common';
import { AccountProvider, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateLocalUserInput {
  email: string;
  username: string;
  passwordHash: string;
}

@Injectable()
export class UsersManager {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  findById(id: string) {
    return this.prisma.user.findUnique({ where: { id } });
  }

  findByLogin(login: string) {
    return this.prisma.user.findFirst({
      where: { OR: [{ email: login.toLowerCase() }, { username: login }] },
    });
  }

  async createLocal(input: CreateLocalUserInput) {
    const initialBalance = BigInt(this.config.get<string>('DEFAULT_WALLET_BALANCE', '0'));
    try {
      return await this.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: input.email.toLowerCase(),
            username: input.username,
            passwordHash: input.passwordHash,
            accounts: {
              create: { provider: AccountProvider.LOCAL, providerAccountId: input.email.toLowerCase() },
            },
          },
        });
        const wallet = await tx.wallet.create({
          data: { userId: user.id, balance: initialBalance, currency: 'GBP' },
        });
        if (initialBalance > 0n) {
          await tx.walletTransaction.create({
            data: {
              walletId: wallet.id,
              type: 'INITIAL_CREDIT',
              amount: initialBalance,
              balanceBefore: 0n,
              balanceAfter: initialBalance,
              referenceType: 'USER',
              referenceId: user.id,
            },
          });
        }
        return user;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Email or username is already registered');
      }
      throw error;
    }
  }

  async upsertGoogle(profile: { googleId: string; email: string; username: string }) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ googleId: profile.googleId }, { email: profile.email.toLowerCase() }] },
    });
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleId: profile.googleId,
          accounts: {
            connectOrCreate: {
              where: {
                provider_providerAccountId: {
                  provider: AccountProvider.GOOGLE,
                  providerAccountId: profile.googleId,
                },
              },
              create: { provider: AccountProvider.GOOGLE, providerAccountId: profile.googleId },
            },
          },
        },
      });
    }

    return this.prisma.user.create({
      data: {
        email: profile.email.toLowerCase(),
        username: profile.username,
        googleId: profile.googleId,
        accounts: { create: { provider: AccountProvider.GOOGLE, providerAccountId: profile.googleId } },
        wallets: { create: { currency: 'GBP', balance: 0n } },
      },
    });
  }
}
