import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
// Use this guard on routes that require a logged-in user. It runs JwtStrategy
// before the controller method is allowed to execute.
export class JwtAuthGuard extends AuthGuard('jwt') {}
