import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BetsController } from './bets.controller';
import { BetsManager } from './bets.manager';
import { BetsService } from './bets.service';

@Module({
  imports: [AuthModule],
  controllers: [BetsController],
  providers: [BetsManager, BetsService],
})
export class BetsModule {}
