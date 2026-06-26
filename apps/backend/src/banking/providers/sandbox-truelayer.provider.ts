import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BankingConnectionStatus, BankingMandateStatus, BankingPaymentStatus } from '@prisma/client';
import { createPrivateKey, randomUUID } from 'crypto';
import { HttpMethod, sign } from 'truelayer-signing';
import {
  CreateProviderConnectionInput,
  CreateProviderDepositInput,
  CreateProviderMandateInput,
  CreateProviderMandatePaymentInput,
  CreateProviderPayoutInput,
  ProviderBankAccount,
  ProviderBankTransaction,
  ProviderConnection,
  ProviderDepositResult,
  ProviderExternalPayoutBeneficiary,
  ProviderMandateResult,
  ProviderPayoutResult,
  TrueLayerProvider,
} from './truelayer-provider.interface';

type JsonRecord = Record<string, unknown>;
type PayoutTarget =
  | { type: 'payment_source'; userId: string; paymentSourceId: string }
  | { type: 'external_account'; beneficiary: ProviderExternalPayoutBeneficiary };

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

interface DataConnectionResponse {
  id: string;
  status: string;
  user?: { id?: string };
  hosted_page?: { uri?: string };
}

interface AccountsResponse {
  items?: Array<{
    id?: string;
    account_type?: string;
    currency?: string;
    account_holder_names?: string[];
    account_identifiers?: unknown[];
  }>;
}

interface TransactionRequestResponse {
  id: string;
  status: 'pending' | 'completed' | 'failed';
  failure_reason?: string;
  result?: {
    items?: Array<{
      transaction_id?: string;
      timestamp?: string;
      description?: string;
      transaction_category?: string;
      currency?: string;
      amount_in_minor?: number | string;
      status?: string;
      merchant_name?: string;
    }>;
  };
}

interface PaymentResponse {
  id?: string;
  amount_in_minor?: number;
  currency?: string;
  resource_token?: string;
  status?: string;
  user?: { id?: string };
  payment_source?: { id?: string };
  created_at?: string;
}

interface PaymentSourcesResponse {
  items?: Array<{
    id?: string;
    account_holder_name?: string;
    account_identifiers?: unknown[];
  }>;
}

interface MandateResponse {
  id?: string;
  status?: string;
  resource_token?: string;
  user?: { id?: string };
  created_at?: string;
}

interface PayoutResponse {
  id?: string;
  status?: string;
  merchant_account_id?: string;
  amount_in_minor?: number;
  currency?: string;
  failure_reason?: unknown;
}

@Injectable()
export class SandboxTrueLayerProvider implements TrueLayerProvider {
  readonly mode = 'sandbox' as const;

  private cachedTokens = new Map<string, { accessToken: string; expiresAtMs: number }>();

  constructor(private readonly config: ConfigService) {}

  async createConnection(input: CreateProviderConnectionInput): Promise<ProviderConnection> {
    let token: string;
    try {
      token = await this.dataAccessToken();
    } catch (error) {
      if (!this.isInvalidScopeError(error)) throw error;
      return this.localDataConnection(input, error);
    }

    const providerId = this.config.get<string>('TRUELAYER_DATA_PROVIDER_ID', 'uk-cs-mock');
    const returnUri = this.config.get<string>(
      'TRUELAYER_REDIRECT_URI',
      'http://localhost:3000/api/banking/truelayer/callback',
    );

    const response = await this.requestJson<DataConnectionResponse>('/v3/data-connections', {
      method: 'POST',
      token,
      body: {
        scopes: ['accounts', 'transactions'],
        provider_selection: providerId
          ? { type: 'preselected', provider_id: providerId }
          : {
              type: 'user_selected',
              filter: { countries: ['GB'], customer_segments: ['retail'] },
            },
        hosted_page: {
          type: 'authorization_flow',
          return_uri: returnUri,
        },
        user: {
          id: input.userId,
          name: input.username,
          email: input.email,
        },
        user_consent: {
          type: 'authorization_flow_captured',
        },
        data_access_type: 'recurring',
        metadata: {
          local_user_id: input.userId,
        },
      },
    });

    if (!response.id || !response.hosted_page?.uri) {
      throw new BadGatewayException('TrueLayer sandbox did not return a connection id and hosted page URI');
    }

    return {
      providerConnectionId: response.id,
      status: BankingConnectionStatus.AUTHORIZATION_REQUIRED,
      authorizationUri: response.hosted_page.uri,
      consentExpiresAt: this.defaultConsentExpiry(),
      metadata: {
        mode: 'sandbox',
        providerId,
        truelayerUserId: response.user?.id,
        trueLayerStatus: response.status,
        authorizationUri: response.hosted_page.uri,
      },
    };
  }

  async listAccounts(providerConnectionId: string): Promise<ProviderBankAccount[]> {
    if (this.isLocalDataConnection(providerConnectionId)) {
      return this.localAccounts(providerConnectionId);
    }

    const response = await this.requestJson<AccountsResponse>('/v3/connected-accounts', {
      method: 'GET',
      token: await this.dataAccessToken(),
      connectionId: providerConnectionId,
    });

    return (response.items ?? []).map((account) => {
      const providerAccountId = this.requiredString(account.id, 'account.id');
      const displayName =
        account.account_holder_names?.[0] ??
        `${account.currency ?? 'GBP'} ${account.account_type ?? 'bank'} account`;

      return {
        providerAccountId,
        displayName,
        accountType: account.account_type ?? 'unknown',
        currency: account.currency ?? 'GBP',
        // Data v3 account listing does not include a balance value. Keep this as
        // zero rather than inventing money; transactions remain the useful data here.
        currentBalance: 0n,
        raw: this.toRecord(account),
      };
    });
  }

  async listTransactions(
    providerConnectionId: string,
    providerAccountId: string,
  ): Promise<ProviderBankTransaction[]> {
    if (this.isLocalDataConnection(providerConnectionId)) {
      return this.localTransactions(providerConnectionId, providerAccountId);
    }

    const token = await this.dataAccessToken();
    const request = await this.requestJson<TransactionRequestResponse>(
      `/v3/connected-accounts/${encodeURIComponent(providerAccountId)}/transactions/requests`,
      {
        method: 'POST',
        token,
        connectionId: providerConnectionId,
        body: {
          from: this.daysAgo(365),
          to: this.daysAgo(0),
          page_size: 50,
        },
      },
    );

    const completed = await this.pollTransactionsRequest(providerConnectionId, providerAccountId, request.id);
    return (completed.result?.items ?? []).map((transaction) => {
      const amount = BigInt(transaction.amount_in_minor ?? 0);
      const description = transaction.description ?? transaction.merchant_name ?? 'TrueLayer transaction';

      return {
        providerTransactionId: this.requiredString(transaction.transaction_id, 'transaction.transaction_id'),
        amount,
        currency: transaction.currency ?? 'GBP',
        direction: amount < 0n ? 'OUTBOUND' : 'INBOUND',
        description,
        merchantName: transaction.merchant_name,
        category: transaction.transaction_category,
        transactionAt: new Date(transaction.timestamp ?? Date.now()),
        raw: this.toRecord(transaction),
      };
    });
  }

  async createMandate(input: CreateProviderMandateInput): Promise<ProviderMandateResult> {
    const path = '/v3/mandates';
    const response = await this.signedRequestJson<MandateResponse>(path, {
      method: HttpMethod.Post,
      body: this.createMandateBody(input),
      idempotencyKey: input.idempotencyKey,
      tokenScope: this.mandateTokenScope(),
    });
    const providerMandateId = this.requiredString(response.id, 'mandate.id');
    const resourceToken = this.requiredString(response.resource_token, 'mandate.resource_token');

    return {
      providerMandateId,
      providerUserId: response.user?.id,
      status: this.mapMandateStatus(response.status),
      authorizationUri: this.hostedMandateUri(providerMandateId, resourceToken),
      raw: {
        provider: 'truelayer',
        mode: 'sandbox',
        trueLayerStatus: response.status,
        response: this.toRecord(response),
      },
    };
  }

  async getMandate(providerMandateId: string): Promise<ProviderMandateResult> {
    const response = await this.signedRequestJson<MandateResponse>(
      `/v3/mandates/${encodeURIComponent(providerMandateId)}`,
      { method: HttpMethod.Get, tokenScope: this.mandateTokenScope() },
    );

    return {
      providerMandateId: this.requiredString(response.id, 'mandate.id'),
      providerUserId: response.user?.id,
      status: this.mapMandateStatus(response.status),
      raw: {
        provider: 'truelayer',
        mode: 'sandbox',
        trueLayerStatus: response.status,
        response: this.toRecord(response),
      },
    };
  }

  async createMandatePayment(input: CreateProviderMandatePaymentInput): Promise<ProviderDepositResult> {
    const response = await this.signedRequestJson<PaymentResponse>('/v3/payments', {
      method: HttpMethod.Post,
      body: this.createMandatePaymentBody(input),
      idempotencyKey: input.idempotencyKey,
      tokenScope: this.mandateTokenScope(),
    });

    return {
      providerPaymentId: this.requiredString(response.id, 'payment.id'),
      paymentSourceId: this.paymentSourceId(response),
      status: this.mapPaymentStatus(response.status),
      raw: {
        provider: 'truelayer',
        mode: 'sandbox',
        trueLayerStatus: response.status,
        providerMandateId: input.providerMandateId,
        source_transaction_id: input.sourceTransactionId ?? null,
        response: this.toRecord(response),
      },
    };
  }

  async createDeposit(input: CreateProviderDepositInput): Promise<ProviderDepositResult> {
    const path = '/v3/payments';
    const body = this.createPaymentBody(input);
    const response = await this.signedRequestJson<PaymentResponse>(path, {
      method: HttpMethod.Post,
      body,
      idempotencyKey: input.idempotencyKey,
    });
    const providerPaymentId = this.requiredString(response.id, 'payment.id');
    const resourceToken = this.requiredString(response.resource_token, 'payment.resource_token');

    return {
      providerPaymentId,
      paymentSourceId: this.paymentSourceId(response),
      status: this.mapPaymentStatus(response.status),
      authorizationUri: this.hostedPaymentUri(providerPaymentId, resourceToken),
      raw: {
        provider: 'truelayer',
        mode: 'sandbox',
        trueLayerStatus: response.status,
        source_transaction_id: input.sourceTransactionId ?? null,
        response: this.toRecord(response),
      },
    };
  }

  async getDeposit(providerPaymentId: string): Promise<ProviderDepositResult> {
    const response = await this.signedRequestJson<PaymentResponse>(
      `/v3/payments/${encodeURIComponent(providerPaymentId)}`,
      { method: HttpMethod.Get },
    );

    return {
      providerPaymentId: this.requiredString(response.id, 'payment.id'),
      paymentSourceId: this.paymentSourceId(response),
      status: this.mapPaymentStatus(response.status),
      raw: {
        provider: 'truelayer',
        mode: 'sandbox',
        trueLayerStatus: response.status,
        response: this.toRecord(response),
      },
    };
  }

  async createPayout(input: CreateProviderPayoutInput): Promise<ProviderPayoutResult> {
    const payoutTarget = await this.resolvePayoutTarget(input);
    if (!payoutTarget) {
      throw new ServiceUnavailableException(
        'A successful TrueLayer payment source or synced bank account details are required before a sandbox payout can be made.',
      );
    }

    const path = '/v3/payouts';
    const body = this.createPayoutBody(input, payoutTarget);
    const response = await this.signedRequestJson<PayoutResponse>(path, {
      method: HttpMethod.Post,
      body,
      idempotencyKey: input.idempotencyKey,
    });

    return {
      providerPayoutId: this.requiredString(response.id, 'payout.id'),
      status: this.mapPayoutStatus(response.status),
      raw: {
        provider: 'truelayer',
        mode: 'sandbox',
        trueLayerStatus: response.status,
        payoutType: payoutTarget.type,
        paymentSourceId: payoutTarget.type === 'payment_source' ? payoutTarget.paymentSourceId : undefined,
        trueLayerUserId: payoutTarget.type === 'payment_source' ? payoutTarget.userId : undefined,
        response: this.toRecord(response),
      },
    };
  }

  private async pollTransactionsRequest(
    providerConnectionId: string,
    providerAccountId: string,
    requestId: string,
  ): Promise<TransactionRequestResponse> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await this.requestJson<TransactionRequestResponse>(
        `/v3/connected-accounts/${encodeURIComponent(providerAccountId)}/transactions/requests/${encodeURIComponent(requestId)}`,
        {
          method: 'GET',
          token: await this.dataAccessToken(),
          connectionId: providerConnectionId,
        },
      );

      if (response.status === 'completed') return response;
      if (response.status === 'failed') {
        throw new BadGatewayException(`TrueLayer sandbox transaction request failed: ${response.failure_reason}`);
      }
      await this.sleep(1_000);
    }

    throw new BadGatewayException('TrueLayer sandbox transaction request was still pending after polling');
  }

  private async dataAccessToken(): Promise<string> {
    return this.accessToken('data');
  }

  private async paymentsAccessToken(scope = 'payments'): Promise<string> {
    return this.accessToken(scope);
  }

  private async accessToken(scope: string): Promise<string> {
    const cached = this.cachedTokens.get(scope);
    if (cached && cached.expiresAtMs > Date.now() + 60_000) return cached.accessToken;

    const clientId = this.requiredConfig('TRUELAYER_CLIENT_ID');
    const clientSecret = this.requiredConfig('TRUELAYER_CLIENT_SECRET');
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });

    const response = await fetch(this.authUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = await this.parseResponse<TokenResponse>(response);
    this.cachedTokens.set(scope, {
      accessToken: payload.access_token,
      expiresAtMs: Date.now() + payload.expires_in * 1_000,
    });
    return payload.access_token;
  }

  private async requestJson<T>(
    path: string,
    options: {
      method: 'GET' | 'POST';
      token: string;
      connectionId?: string;
      body?: JsonRecord;
    },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.token}`,
      Accept: 'application/json',
    };
    if (options.connectionId) headers['Connection-Id'] = options.connectionId;
    if (options.body) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.apiBaseUrl()}${path}`, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    return this.parseResponse<T>(response);
  }

  private async signedRequestJson<T>(
    path: string,
    options: {
      method: HttpMethod.Get | HttpMethod.Post;
      body?: JsonRecord;
      idempotencyKey?: string;
      tokenScope?: string;
    },
  ): Promise<T> {
    const body = options.body ? JSON.stringify(options.body) : '';
    const signedHeaders: Record<string, string> = {};
    if (options.idempotencyKey) signedHeaders['Idempotency-Key'] = options.idempotencyKey;

    const signature = this.signRequest(path, options.method, signedHeaders, body);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.paymentsAccessToken(options.tokenScope)}`,
      Accept: 'application/json',
      'Tl-Signature': signature,
      ...signedHeaders,
    };
    if (options.body) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.apiBaseUrl()}${path}`, {
      method: options.method,
      headers,
      body: options.body ? body : undefined,
    });

    return this.parseResponse<T>(response);
  }

  private async parseResponse<T>(response: Response): Promise<T> {
    const text = await response.text();
    const payload = text ? (JSON.parse(text) as T) : ({} as T);
    if (!response.ok) {
      throw new BadGatewayException(`TrueLayer sandbox request failed with ${response.status}: ${text.slice(0, 500)}`);
    }
    return payload;
  }

  private authUrl(): string {
    return this.config.get<string>('TRUELAYER_AUTH_URL', 'https://auth.truelayer-sandbox.com/connect/token');
  }

  private apiBaseUrl(): string {
    return this.config.get<string>('TRUELAYER_API_BASE_URL', 'https://api.truelayer-sandbox.com');
  }

  private createPaymentBody(input: CreateProviderDepositInput): JsonRecord {
    const providerId = this.config.get<string>('TRUELAYER_PAYMENT_PROVIDER_ID', 'mock-payments-gb-redirect');
    const providerSelection = providerId
      ? {
          type: 'preselected',
          provider_id: providerId,
          scheme_selection: { type: 'instant_preferred', allow_remitter_fee: false },
        }
      : {
          type: 'user_selected',
          filter: { countries: ['GB'], customer_segments: ['retail'] },
          scheme_selection: { type: 'instant_preferred', allow_remitter_fee: false },
        };

    return {
      amount_in_minor: this.minorAmount(input.amount),
      currency: input.currency,
      payment_method: {
        type: 'bank_transfer',
        provider_selection: providerSelection,
        beneficiary: {
          type: 'merchant_account',
          merchant_account_id: this.requiredConfig('TRUELAYER_MERCHANT_ACCOUNT_ID'),
        },
        hosted_page: {
          country_code: 'GB',
          return_uri: this.paymentReturnUri(),
          language_code: 'en',
        },
      },
      user: {
        id: input.userId,
        name: input.username,
        email: input.email,
      },
      metadata: {
        local_user_id: input.userId,
        local_payment_id: input.localPaymentId,
        source_transaction_id: input.sourceTransactionId ?? '',
      },
    };
  }

  private createMandateBody(input: CreateProviderMandateInput): JsonRecord {
    const providerId = this.config.get<string>('TRUELAYER_MANDATE_PROVIDER_ID', 'ob-natwest-vrp-sandbox');
    const providerSelection = providerId
      ? {
          type: 'preselected',
          provider_id: providerId,
          scheme_selection: { type: 'instant_preferred', allow_remitter_fee: false },
        }
      : {
          type: 'user_selected',
          filter: { countries: ['GB'], customer_segments: ['retail'] },
          scheme_selection: { type: 'instant_preferred', allow_remitter_fee: false },
        };

    return {
      user: {
        id: input.userId,
        name: input.username,
        email: input.email,
      },
      mandate: {
        type: this.config.get<string>('TRUELAYER_MANDATE_TYPE', 'sweeping'),
        provider_selection: providerSelection,
        beneficiary: {
          type: 'merchant_account',
          merchant_account_id: this.requiredConfig('TRUELAYER_MERCHANT_ACCOUNT_ID'),
        },
      },
      currency: input.currency,
      constraints: {
        valid_from: input.validFrom.toISOString(),
        valid_to: input.validTo.toISOString(),
        maximum_individual_amount: this.minorAmount(input.maximumIndividualAmount),
        periodic_limits: {
          day: {
            maximum_amount: this.minorAmount(input.dailyLimit),
            period_alignment: 'calendar',
          },
        },
      },
      metadata: {
        local_user_id: input.userId,
      },
    };
  }

  private createMandatePaymentBody(input: CreateProviderMandatePaymentInput): JsonRecord {
    return {
      amount_in_minor: this.minorAmount(input.amount),
      currency: input.currency,
      reference: `Gamba-${input.idempotencyKey.slice(0, 8)}`,
      payment_method: {
        type: 'mandate',
        mandate_id: input.providerMandateId,
      },
      metadata: {
        local_user_id: input.userId,
        local_payment_id: input.localPaymentId,
        source_transaction_id: input.sourceTransactionId ?? '',
      },
    };
  }

  private async resolvePayoutTarget(input: CreateProviderPayoutInput): Promise<PayoutTarget | undefined> {
    const preferredUserId = input.providerUserId ?? input.userId;
    if (input.paymentSourceId) {
      return {
        type: 'payment_source',
        userId: preferredUserId,
        paymentSourceId: input.paymentSourceId,
      };
    }

    const paymentSourceTarget = await this.lookupPayoutTargetFromMerchantAccount(input);
    if (paymentSourceTarget) return paymentSourceTarget;

    if (input.externalBeneficiary) {
      return {
        type: 'external_account',
        beneficiary: input.externalBeneficiary,
      };
    }

    return undefined;
  }

  private async lookupPayoutTargetFromMerchantAccount(
    input: CreateProviderPayoutInput,
  ): Promise<PayoutTarget | undefined> {
    const candidateUserIds = Array.from(
      new Set([input.providerUserId, input.userId].filter((userId): userId is string => Boolean(userId))),
    );

    for (const candidateUserId of candidateUserIds) {
      let paymentSourceId: string | undefined;
      try {
        paymentSourceId = await this.lookupPaymentSourceId(candidateUserId);
      } catch {
        paymentSourceId = undefined;
      }
      if (paymentSourceId) {
        return {
          type: 'payment_source',
          userId: candidateUserId,
          paymentSourceId,
        };
      }
    }

    return undefined;
  }

  private async lookupPaymentSourceId(userId: string): Promise<string | undefined> {
    const merchantAccountId = this.requiredConfig('TRUELAYER_MERCHANT_ACCOUNT_ID');
    const path = `/v3/merchant-accounts/${encodeURIComponent(
      merchantAccountId,
    )}/payment-sources?${new URLSearchParams({ user_id: userId }).toString()}`;
    const response = await this.signedRequestJson<PaymentSourcesResponse>(path, {
      method: HttpMethod.Get,
      idempotencyKey: randomUUID(),
    });

    return response.items?.find((source) => typeof source.id === 'string')?.id;
  }

  private createPayoutBody(input: CreateProviderPayoutInput, payoutTarget: PayoutTarget): JsonRecord {
    return {
      merchant_account_id: this.requiredConfig('TRUELAYER_MERCHANT_ACCOUNT_ID'),
      amount_in_minor: this.minorAmount(input.amount),
      currency: input.currency,
      beneficiary:
        payoutTarget.type === 'payment_source'
          ? this.closedLoopPayoutBeneficiary(input, payoutTarget)
          : this.externalPayoutBeneficiary(input, payoutTarget.beneficiary),
      scheme_selection: {
        type: 'instant_preferred',
      },
      metadata: {
        local_user_id: input.userId,
      },
    };
  }

  private closedLoopPayoutBeneficiary(
    input: CreateProviderPayoutInput,
    payoutTarget: Extract<PayoutTarget, { type: 'payment_source' }>,
  ): JsonRecord {
    return {
      type: 'payment_source',
      user_id: payoutTarget.userId,
      payment_source_id: payoutTarget.paymentSourceId,
      reference: `Gamba-${input.idempotencyKey.slice(0, 8)}`,
    };
  }

  private externalPayoutBeneficiary(
    input: CreateProviderPayoutInput,
    beneficiary: ProviderExternalPayoutBeneficiary,
  ): JsonRecord {
    return {
      type: 'external_account',
      account_holder_name: beneficiary.accountHolderName,
      account_identifier: beneficiary.accountIdentifier,
      reference: `Gamba-${input.idempotencyKey.slice(0, 8)}`,
      address: {
        address_line1: this.config.get<string>('TRUELAYER_SANDBOX_PAYOUT_ADDRESS_LINE1', '40 Finsbury Square'),
        state: this.config.get<string>('TRUELAYER_SANDBOX_PAYOUT_STATE', 'London'),
        city: this.config.get<string>('TRUELAYER_SANDBOX_PAYOUT_CITY', 'London'),
        country_code: this.config.get<string>('TRUELAYER_SANDBOX_PAYOUT_COUNTRY_CODE', 'GB'),
        zip: this.config.get<string>('TRUELAYER_SANDBOX_PAYOUT_ZIP', 'EC2A 1AE'),
      },
      date_of_birth: this.config.get<string>('TRUELAYER_SANDBOX_PAYOUT_DATE_OF_BIRTH', '1990-01-31'),
    };
  }

  private hostedPaymentUri(providerPaymentId: string, resourceToken: string): string {
    const url = new URL(
      this.config.get<string>('TRUELAYER_PAYMENT_HPP_BASE_URL', 'https://app.truelayer-sandbox.com/payments'),
    );
    url.searchParams.set('payment_id', providerPaymentId);
    url.searchParams.set('resource_token', resourceToken);
    url.searchParams.set('return_uri', this.paymentReturnUri());
    return url.toString();
  }

  private hostedMandateUri(providerMandateId: string, resourceToken: string): string {
    const configuredBase = this.config.get<string>(
      'TRUELAYER_MANDATE_HPP_BASE_URL',
      'https://payment.truelayer-sandbox.com/mandates',
    );
    const baseUrl = configuredBase.split('#')[0].split('?')[0].replace(/\/+$/, '');
    const params = new URLSearchParams({
      mandate_id: providerMandateId,
      resource_token: resourceToken,
      return_uri: this.mandateReturnUri(),
    });
    return `${baseUrl}#${params.toString()}`;
  }

  private paymentReturnUri(): string {
    return this.config.get<string>(
      'TRUELAYER_PAYMENT_RETURN_URI',
      'http://localhost:3000/api/banking/truelayer/payment-callback',
    );
  }

  private mandateReturnUri(): string {
    return this.config.get<string>(
      'TRUELAYER_MANDATE_RETURN_URI',
      'http://localhost:3000/api/banking/truelayer/mandate-callback',
    );
  }

  private mandateTokenScope(): string {
    return this.config.get<string>('TRUELAYER_MANDATE_TOKEN_SCOPE', 'payments recurring_payments:sweeping');
  }

  private mapPaymentStatus(status: string | undefined): BankingPaymentStatus {
    if (status === 'failed') return BankingPaymentStatus.FAILED;
    if (status === 'settled') return BankingPaymentStatus.SUCCEEDED;
    return BankingPaymentStatus.PENDING;
  }

  private mapMandateStatus(status: string | undefined): BankingMandateStatus {
    if (status === 'authorized') return BankingMandateStatus.AUTHORIZED;
    if (status === 'authorizing') return BankingMandateStatus.AUTHORIZING;
    if (status === 'revoked') return BankingMandateStatus.REVOKED;
    if (status === 'authorization_required' || status === 'authorisation_required') {
      return BankingMandateStatus.AUTHORIZATION_REQUIRED;
    }
    if (status === 'failed' || status === 'rejected' || status === 'cancelled') return BankingMandateStatus.FAILED;
    return BankingMandateStatus.AUTHORIZATION_REQUIRED;
  }

  private mapPayoutStatus(status: string | undefined): BankingPaymentStatus {
    if (status === 'failed') return BankingPaymentStatus.FAILED;
    if (status === 'executed') return BankingPaymentStatus.SUCCEEDED;
    return BankingPaymentStatus.PENDING;
  }

  private paymentSourceId(response: PaymentResponse): string | undefined {
    return typeof response.payment_source?.id === 'string' ? response.payment_source.id : undefined;
  }

  private minorAmount(amount: bigint): number {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BadGatewayException('Amount is too large to send safely to TrueLayer sandbox');
    }
    return Number(amount);
  }

  private privateKeyPem(): string {
    const configured = this.requiredConfig('TRUELAYER_PRIVATE_KEY').trim();
    const unquoted =
      (configured.startsWith('"') && configured.endsWith('"')) ||
      (configured.startsWith("'") && configured.endsWith("'"))
        ? configured.slice(1, -1)
        : configured;
    const pem = unquoted.replace(/\\n/g, '\n').trim();

    try {
      createPrivateKey(pem);
    } catch {
      throw new ServiceUnavailableException(
        'TrueLayer signing is not configured correctly. TRUELAYER_PRIVATE_KEY must be the unencrypted private key PEM, including the full BEGIN/END PRIVATE KEY lines with five hyphens. Do not paste the public key, certificate, or a shortened key.',
      );
    }

    return pem;
  }

  private signRequest(
    path: string,
    method: HttpMethod.Get | HttpMethod.Post,
    headers: Record<string, string>,
    body: string,
  ): string {
    try {
      return sign({
        kid: this.requiredConfig('TRUELAYER_CERTIFICATE_ID'),
        privateKeyPem: this.privateKeyPem(),
        method,
        path,
        headers,
        body,
      });
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException(
        'TrueLayer request signing failed. Check TRUELAYER_PRIVATE_KEY is a valid private key and TRUELAYER_CERTIFICATE_ID is the matching key id from TrueLayer Console.',
      );
    }
  }

  private localDataConnection(input: CreateProviderConnectionInput, error: unknown): ProviderConnection {
    return {
      providerConnectionId: `sandbox-local-data-${input.userId}`,
      status: BankingConnectionStatus.ACTIVE,
      consentExpiresAt: this.defaultConsentExpiry(),
      metadata: {
        mode: 'sandbox-local-data-fallback',
        provider: 'TrueLayer Sandbox Local Data Fallback',
        reason:
          'TrueLayer returned invalid_scope for the Data API token. Enable Data API access in Console to use hosted account-data consent.',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }

  private isLocalDataConnection(providerConnectionId: string): boolean {
    return providerConnectionId.startsWith('sandbox-local-data-');
  }

  private localAccounts(providerConnectionId: string): ProviderBankAccount[] {
    return [
      {
        providerAccountId: `${providerConnectionId}-current-gbp`,
        displayName: 'JOHN SANDBRIDGE',
        accountType: 'transaction',
        currency: 'GBP',
        currentBalance: 124_350n,
        raw: {
          provider: 'truelayer',
          mode: 'sandbox-local-data-fallback',
          account_holder_names: ['JOHN SANDBRIDGE'],
          account_identifiers: [
            {
              type: 'sort_code_account_number',
              sort_code: '040668',
              account_number: '00000871',
            },
            {
              type: 'iban',
              iban: 'GB75CLRB04066800000871',
            },
          ],
        },
      },
    ];
  }

  private localTransactions(providerConnectionId: string, providerAccountId: string): ProviderBankTransaction[] {
    const prefix = `${providerConnectionId}:${providerAccountId}`;
    return [
      {
        providerTransactionId: `${prefix}:coffee-1000`,
        amount: -1_000n,
        currency: 'GBP',
        direction: 'OUTBOUND',
        description: 'Coffee shop',
        merchantName: 'Sandbox Coffee',
        category: 'eating_out',
        transactionAt: new Date('2026-06-21T09:15:00.000Z'),
        raw: { transaction_id: `${prefix}:coffee-1000`, amount_in_minor: -1_000 },
      },
      {
        providerTransactionId: `${prefix}:groceries-4325`,
        amount: -4_325n,
        currency: 'GBP',
        direction: 'OUTBOUND',
        description: 'Weekly groceries',
        merchantName: 'Sandbox Market',
        category: 'groceries',
        transactionAt: new Date('2026-06-20T17:40:00.000Z'),
        raw: { transaction_id: `${prefix}:groceries-4325`, amount_in_minor: -4_325 },
      },
      {
        providerTransactionId: `${prefix}:salary-250000`,
        amount: 250_000n,
        currency: 'GBP',
        direction: 'INBOUND',
        description: 'Salary payment',
        merchantName: 'Sandbox Employer',
        category: 'income',
        transactionAt: new Date('2026-06-18T08:00:00.000Z'),
        raw: { transaction_id: `${prefix}:salary-250000`, amount_in_minor: 250_000 },
      },
    ];
  }

  private isInvalidScopeError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('invalid_scope');
  }

  private requiredConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value) throw new ServiceUnavailableException(`${key} is required for TRUELAYER_MODE=sandbox`);
    return value;
  }

  private requiredString(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BadGatewayException(`TrueLayer sandbox response is missing ${field}`);
    }
    return value;
  }

  private toRecord(value: unknown): JsonRecord {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
  }

  private daysAgo(days: number): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  }

  private defaultConsentExpiry(): Date {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 90);
    return date;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
