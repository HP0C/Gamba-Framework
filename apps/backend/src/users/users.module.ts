import { Module } from '@nestjs/common';
import { UsersManager } from './users.manager';
import { UsersService } from './users.service';

@Module({ providers: [UsersManager, UsersService], exports: [UsersManager, UsersService] })
export class UsersModule {}
