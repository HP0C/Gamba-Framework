import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateProviderConnectionInput,
  CreateProviderDepositInput,
  CreateProviderPayoutInput,
  ProviderBankAccount,
  ProviderBankTransaction,
  ProviderConnection,
  ProviderDepositResult,
  ProviderPayoutResult,
  TrueLayerProvider,
} from './truelayer-provider.interface';

@Injectable()
export class LiveTrueLayerProvider implements TrueLayerProvider {
  readonly mode = 'live' as const;

  constructor(private readonly config: ConfigService) {}

  async createConnection(_input: CreateProviderConnectionInput): Promise<ProviderConnection> {
    return this.notImplemented();
  }

  async listAccounts(_providerConnectionId: string): Promise<ProviderBankAccount[]> {
    return this.notImplemented();
  }

  async listTransactions(
    _providerConnectionId: string,
    _providerAccountId: string,
  ): Promise<ProviderBankTransaction[]> {
    return this.notImplemented();
  }

  async createDeposit(_input: CreateProviderDepositInput): Promise<ProviderDepositResult> {
    return this.notImplemented();
  }

  async getDeposit(_providerPaymentId: string): Promise<ProviderDepositResult> {
    return this.notImplemented();
  }

  async createPayout(_input: CreateProviderPayoutInput): Promise<ProviderPayoutResult> {
    return this.notImplemented();
  }

  private notImplemented(): never {
    void this.config.get<string>('TRUELAYER_CLIENT_ID');
    throw new ServiceUnavailableException(
      'Live TrueLayer mode is not implemented. Use TRUELAYER_MODE=sandbox until live API auth, request signing, webhooks, and reconciliation are built.',
    );
  }
}
