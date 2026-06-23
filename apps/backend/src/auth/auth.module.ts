import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthManager } from './auth.manager';
import { AuthService } from './auth.service';
import { GoogleAuthGuard, GoogleConfiguredGuard } from './google-auth.guard';
import { GoogleStrategy } from './google.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [UsersModule, PassportModule, JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthManager, AuthService, JwtStrategy, JwtAuthGuard, GoogleStrategy, GoogleAuthGuard, GoogleConfiguredGuard],
  exports: [JwtAuthGuard],
})
export class AuthModule {}
