import { Injectable, NotFoundException } from '@nestjs/common';
import { minorUnits } from '../common/serialize';
import { WalletManager } from './wallet.manager';

@Injectable()
export class WalletService {
  constructor(private readonly manager: WalletManager) {}

  async getBalance(userId: string) {
    const wallet = await this.manager.findForUser(userId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return { balance: minorUnits(wallet.balance), currency: wallet.currency };
  }
}
