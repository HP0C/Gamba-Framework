import { Global, Module } from '@nestjs/common';
import { AuditManager } from './audit.manager';
import { AuditService } from './audit.service';

@Global()
@Module({ providers: [AuditManager, AuditService], exports: [AuditManager, AuditService] })
export class AuditModule {}
