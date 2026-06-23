import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletController } from './wallet.controller';
import { WalletManager } from './wallet.manager';
import { WalletService } from './wallet.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [WalletManager, WalletService],
  exports: [WalletManager, WalletService],
})
export class WalletModule {}
