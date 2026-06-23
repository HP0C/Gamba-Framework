import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BetsModule } from './bets/bets.module';
import { GamesModule } from './games/games.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuditModule,
    UsersModule,
    AuthModule,
    WalletModule,
    GamesModule,
    BetsModule,
  ],
})
export class AppModule {}
