import { Injectable } from '@nestjs/common';
import { BankingManager } from './banking.manager';
import { CreateBankingDepositDto } from './dto/create-banking-deposit.dto';
import { CreateBankingPayoutDto } from './dto/create-banking-payout.dto';

@Injectable()
export class BankingService {
  constructor(private readonly manager: BankingManager) {}

  overview(userId: string) {
    return this.manager.overview(userId);
  }

  connectBank(userId: string, appReturnUrl?: string) {
    return this.manager.connectBank(userId, appReturnUrl);
  }

  completeTrueLayerConnection(userId: string, input: { error?: string; providerConnectionId?: string }) {
    return this.manager.completeTrueLayerConnection(userId, input);
  }

  completeTrueLayerConnectionCallback(input: { error?: string; providerConnectionId?: string }) {
    return this.manager.completeTrueLayerConnectionCallback(input);
  }

  syncBankData(userId: string) {
    return this.manager.syncBankData(userId);
  }

  createDeposit(userId: string, dto: CreateBankingDepositDto, appReturnUrl?: string) {
    return this.manager.createDeposit(userId, dto, appReturnUrl);
  }

  completeTrueLayerPayment(userId: string, input: { error?: string; paymentId?: string; providerPaymentId?: string }) {
    return this.manager.completeTrueLayerPayment(userId, input);
  }

  completeTrueLayerPaymentCallback(input: { error?: string; paymentId?: string; providerPaymentId?: string }) {
    return this.manager.completeTrueLayerPaymentCallback(input);
  }

  refreshPendingDeposits(userId: string) {
    return this.manager.refreshPendingDeposits(userId);
  }

  createPayout(userId: string, dto: CreateBankingPayoutDto) {
    return this.manager.createPayout(userId, dto);
  }
}
