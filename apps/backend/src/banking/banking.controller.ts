import { BadRequestException, Body, Controller, Get, Headers, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestUser } from '../auth/request-user.decorator';
import { BankingService } from './banking.service';
import { CreateBankingDepositDto } from './dto/create-banking-deposit.dto';
import { CreateBankingPayoutDto } from './dto/create-banking-payout.dto';

@Controller('banking')
export class BankingController {
  constructor(
    private readonly banking: BankingService,
    private readonly config: ConfigService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  overview(@RequestUser() user: AuthenticatedUser) {
    return this.banking.overview(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('connect')
  connectBank(@RequestUser() user: AuthenticatedUser, @Headers('x-app-return-url') appReturnUrl?: string) {
    return this.banking.connectBank(user.userId, this.validAppReturnUrl(appReturnUrl));
  }

  @Get('truelayer/callback')
  async trueLayerCallback(
    @Query('error') error: string | undefined,
    @Query('connection_id') snakeConnectionId: string | undefined,
    @Query('connectionId') camelConnectionId: string | undefined,
    @Res() res: Response,
  ) {
    const fallbackUrl = this.config.getOrThrow<string>('FRONTEND_URL').split(',')[0].trim();
    let redirect = new URL(fallbackUrl);
    const providerConnectionId = snakeConnectionId ?? camelConnectionId;

    if (!providerConnectionId) {
      redirect.searchParams.set('banking', 'error');
      return res.redirect(redirect.toString());
    }

    try {
      const result = await this.banking.completeTrueLayerConnectionCallback({
        error,
        providerConnectionId,
      });
      if (result.appReturnUrl) redirect = new URL(result.appReturnUrl);
      redirect.searchParams.set('banking', error ? 'error' : 'connected');
    } catch {
      redirect.searchParams.set('banking', 'error');
    }
    return res.redirect(redirect.toString());
  }

  @Get('truelayer/payment-callback')
  async trueLayerPaymentCallback(
    @Query('error') error: string | undefined,
    @Query('bankingPaymentId') paymentId: string | undefined,
    @Query('payment_id') snakeProviderPaymentId: string | undefined,
    @Query('paymentId') camelProviderPaymentId: string | undefined,
    @Res() res: Response,
  ) {
    const fallbackUrl = this.config.getOrThrow<string>('FRONTEND_URL').split(',')[0].trim();
    let redirect = new URL(fallbackUrl);
    const providerPaymentId = snakeProviderPaymentId ?? camelProviderPaymentId;

    if (!paymentId && !providerPaymentId) {
      redirect.searchParams.set('payment', 'error');
      return res.redirect(redirect.toString());
    }

    try {
      const result = await this.banking.completeTrueLayerPaymentCallback({
        error,
        paymentId,
        providerPaymentId,
      });
      if (result.appReturnUrl) redirect = new URL(result.appReturnUrl);
      redirect.searchParams.set('payment', result.status);
    } catch {
      redirect.searchParams.set('payment', 'error');
    }
    return res.redirect(redirect.toString());
  }

  @UseGuards(JwtAuthGuard)
  @Post('sync')
  syncBankData(@RequestUser() user: AuthenticatedUser) {
    return this.banking.syncBankData(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('deposits')
  createDeposit(
    @RequestUser() user: AuthenticatedUser,
    @Body() dto: CreateBankingDepositDto,
    @Headers('x-app-return-url') appReturnUrl?: string,
  ) {
    return this.banking.createDeposit(user.userId, dto, this.validAppReturnUrl(appReturnUrl));
  }

  @UseGuards(JwtAuthGuard)
  @Post('deposits/refresh')
  refreshPendingDeposits(@RequestUser() user: AuthenticatedUser) {
    return this.banking.refreshPendingDeposits(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('payouts')
  createPayout(@RequestUser() user: AuthenticatedUser, @Body() dto: CreateBankingPayoutDto) {
    return this.banking.createPayout(user.userId, dto);
  }

  private validAppReturnUrl(value?: string): string | undefined {
    if (!value) return undefined;

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new BadRequestException('Invalid mobile app return URL');
    }

    const allowedSchemes = this.config
      .get<string>('MOBILE_APP_ALLOWED_SCHEMES', 'gamba')
      .split(',')
      .map((scheme) => scheme.trim().replace(/:$/, ''))
      .filter(Boolean);
    if (!allowedSchemes.includes(parsed.protocol.replace(/:$/, ''))) {
      throw new BadRequestException('Mobile app return URL scheme is not allowed');
    }
    return parsed.toString();
  }
}
