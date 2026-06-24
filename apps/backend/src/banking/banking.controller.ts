import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
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
  connectBank(@RequestUser() user: AuthenticatedUser) {
    return this.banking.connectBank(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('mock/connect')
  connectMockBank(@RequestUser() user: AuthenticatedUser) {
    return this.banking.connectMockBank(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('truelayer/callback')
  async trueLayerCallback(
    @RequestUser() user: AuthenticatedUser,
    @Query('error') error: string | undefined,
    @Query('connection_id') snakeConnectionId: string | undefined,
    @Query('connectionId') camelConnectionId: string | undefined,
    @Res() res: Response,
  ) {
    await this.banking.completeTrueLayerConnection(user.userId, {
      error,
      providerConnectionId: snakeConnectionId ?? camelConnectionId,
    });
    const redirect = new URL(this.config.getOrThrow<string>('FRONTEND_URL'));
    redirect.searchParams.set('banking', error ? 'error' : 'connected');
    return res.redirect(redirect.toString());
  }

  @UseGuards(JwtAuthGuard)
  @Get('truelayer/payment-callback')
  async trueLayerPaymentCallback(
    @RequestUser() user: AuthenticatedUser,
    @Query('error') error: string | undefined,
    @Query('bankingPaymentId') paymentId: string | undefined,
    @Query('payment_id') snakeProviderPaymentId: string | undefined,
    @Query('paymentId') camelProviderPaymentId: string | undefined,
    @Res() res: Response,
  ) {
    const redirect = new URL(this.config.getOrThrow<string>('FRONTEND_URL'));
    if (error && !paymentId && !snakeProviderPaymentId && !camelProviderPaymentId) {
      redirect.searchParams.set('payment', 'error');
      return res.redirect(redirect.toString());
    }

    const result = await this.banking.completeTrueLayerPayment(user.userId, {
      error,
      paymentId,
      providerPaymentId: snakeProviderPaymentId ?? camelProviderPaymentId,
    });
    redirect.searchParams.set('payment', result.status);
    return res.redirect(redirect.toString());
  }

  @UseGuards(JwtAuthGuard)
  @Post('sync')
  syncBankData(@RequestUser() user: AuthenticatedUser) {
    return this.banking.syncBankData(user.userId);
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
