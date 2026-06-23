import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GamesModule } from '../games/games.module';
import { BetsController } from './bets.controller';
import { BetsManager } from './bets.manager';
import { BetsService } from './bets.service';

@Module({
  imports: [AuthModule, GamesModule],
  controllers: [BetsController],
  providers: [BetsManager, BetsService],
})
export class BetsModule {}
