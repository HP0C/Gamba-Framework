import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestUser } from '../auth/request-user.decorator';
import { BankingService } from './banking.service';
import { CreateBankingDepositDto } from './dto/create-banking-deposit.dto';
import { CreateBankingMandateDto } from './dto/create-banking-mandate.dto';
import { CreateBankingPayoutDto } from './dto/create-banking-payout.dto';
import { CreateMandateDepositDto } from './dto/create-mandate-deposit.dto';

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
  connectBank(@RequestUser() user: AuthenticatedUser) {
    return this.banking.connectBank(user.userId);
  }

  @Get('truelayer/callback')
  async trueLayerCallback(
    @Query('error') error: string | undefined,
    @Query('connection_id') snakeConnectionId: string | undefined,
    @Query('connectionId') camelConnectionId: string | undefined,
    @Res() res: Response,
  ) {
    const redirect = new URL(this.config.getOrThrow<string>('FRONTEND_URL'));
    const providerConnectionId = snakeConnectionId ?? camelConnectionId;

    if (!providerConnectionId) {
      redirect.searchParams.set('banking', 'error');
      return res.redirect(redirect.toString());
    }

    try {
      await this.banking.completeTrueLayerConnectionCallback({
        error,
        providerConnectionId,
      });
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
    const redirect = new URL(this.config.getOrThrow<string>('FRONTEND_URL'));
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
      redirect.searchParams.set('payment', result.status);
    } catch {
      redirect.searchParams.set('payment', 'error');
    }
    return res.redirect(redirect.toString());
  }

  @Get('truelayer/mandate-callback')
  async trueLayerMandateCallback(
    @Query('error') error: string | undefined,
    @Query('mandate_id') snakeProviderMandateId: string | undefined,
    @Query('mandateId') camelProviderMandateId: string | undefined,
    @Query('payment_mandate_id') snakePaymentMandateId: string | undefined,
    @Query('paymentMandateId') camelPaymentMandateId: string | undefined,
    @Res() res: Response,
  ) {
    const redirect = new URL(this.config.getOrThrow<string>('FRONTEND_URL'));
    const providerMandateId =
      snakeProviderMandateId ?? camelProviderMandateId ?? snakePaymentMandateId ?? camelPaymentMandateId;

    if (!providerMandateId) {
      redirect.searchParams.set('mandate', 'error');
      return res.redirect(redirect.toString());
    }

    try {
      const result = await this.banking.completeTrueLayerMandateCallback({
        error,
        providerMandateId,
      });
      redirect.searchParams.set('mandate', result.status);
    } catch {
      redirect.searchParams.set('mandate', 'error');
    }
    return res.redirect(redirect.toString());
  }

  @UseGuards(JwtAuthGuard)
  @Post('sync')
  syncBankData(@RequestUser() user: AuthenticatedUser) {
    return this.banking.syncBankData(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('mandates')
  createMandate(@RequestUser() user: AuthenticatedUser, @Body() dto: CreateBankingMandateDto) {
    return this.banking.createMandate(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('mandate-deposits')
  createMandateDeposit(@RequestUser() user: AuthenticatedUser, @Body() dto: CreateMandateDepositDto) {
    return this.banking.createMandateDeposit(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('deposits')
  createDeposit(@RequestUser() user: AuthenticatedUser, @Body() dto: CreateBankingDepositDto) {
    return this.banking.createDeposit(user.userId, dto);
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
}
