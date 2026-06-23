import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../common/authenticated-user';
import { RequestUser } from '../common/request-user.decorator';
import { WalletService } from './wallet.service';

@Controller('wallet')
@UseGuards(JwtAuthGuard)
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  getBalance(@RequestUser() user: AuthenticatedUser) {
    return this.wallet.getBalance(user.userId);
  }
}
