import { Injectable, NotFoundException } from '@nestjs/common';
import { WalletManager } from './wallet.manager';

@Injectable()
export class WalletService {
  constructor(private readonly manager: WalletManager) {}

  async getBalance(userId: string) {
    const wallet = await this.manager.findForUser(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return { balance: wallet.balance.toString(), currency: wallet.currency };
  }
}
