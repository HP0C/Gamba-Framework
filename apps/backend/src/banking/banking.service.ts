import { Injectable } from '@nestjs/common';
import { BankingManager } from './banking.manager';
import { CreateBankingDepositDto } from './dto/create-banking-deposit.dto';
import { CreateBankingMandateDto } from './dto/create-banking-mandate.dto';
import { CreateBankingPayoutDto } from './dto/create-banking-payout.dto';
import { CreateMandateDepositDto } from './dto/create-mandate-deposit.dto';

@Injectable()
export class BankingService {
  constructor(private readonly manager: BankingManager) {}

  overview(userId: string) {
    return this.manager.overview(userId);
  }

  connectBank(userId: string) {
    return this.manager.connectBank(userId);
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

  createDeposit(userId: string, dto: CreateBankingDepositDto) {
    return this.manager.createDeposit(userId, dto);
  }

  createMandate(userId: string, dto: CreateBankingMandateDto) {
    return this.manager.createMandate(userId, dto);
  }

  completeTrueLayerMandateCallback(input: { error?: string; providerMandateId?: string }) {
    return this.manager.completeTrueLayerMandateCallback(input);
  }

  createMandateDeposit(userId: string, dto: CreateMandateDepositDto) {
    return this.manager.createMandateDeposit(userId, dto);
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
