import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEvent {
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuditManager {
  constructor(private readonly prisma: PrismaService) {}

  create(event: AuditEvent, client: Prisma.TransactionClient | PrismaClient = this.prisma) {
    return client.auditLog.create({ data: event });
  }
}
