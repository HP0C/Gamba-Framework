import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BankingController } from './banking.controller';
import { BankingManager } from './banking.manager';
import { BankingService } from './banking.service';
import { LiveTrueLayerProvider } from './providers/live-truelayer.provider';
import { SandboxTrueLayerProvider } from './providers/sandbox-truelayer.provider';
import { TRUE_LAYER_PROVIDER } from './providers/truelayer-provider.interface';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [BankingController],
  providers: [
    BankingService,
    BankingManager,
    SandboxTrueLayerProvider,
    LiveTrueLayerProvider,
    {
      provide: TRUE_LAYER_PROVIDER,
      inject: [ConfigService, SandboxTrueLayerProvider, LiveTrueLayerProvider],
      useFactory: (
        config: ConfigService,
        sandboxProvider: SandboxTrueLayerProvider,
        liveProvider: LiveTrueLayerProvider,
      ) => {
        const mode = config.get<string>('TRUELAYER_MODE', 'sandbox');
        if (mode === 'live') return liveProvider;
        if (mode === 'sandbox') return sandboxProvider;
        throw new Error(`Unsupported TRUELAYER_MODE "${mode}". Use "sandbox" or "live".`);
      },
    },
  ],
})
export class BankingModule {}
