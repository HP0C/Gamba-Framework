import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletManager {
  constructor(private readonly prisma: PrismaService) {}

  findForUser(userId: string) {
    return this.prisma.wallet.findUnique({
      where: { userId_currency: { userId, currency: 'GBP' } },
    });
  }
}
