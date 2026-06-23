import { Injectable } from '@nestjs/common';
import { AuditEvent, AuditManager } from './audit.manager';

@Injectable()
export class AuditService {
  constructor(private readonly manager: AuditManager) {}

  record(event: AuditEvent): Promise<unknown> {
    return this.manager.create(event);
  }
}
