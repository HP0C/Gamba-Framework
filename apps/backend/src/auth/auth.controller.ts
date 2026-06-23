import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../common/authenticated-user';
import { RequestUser } from '../common/request-user.decorator';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { GoogleProfileUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { GoogleAuthGuard, GoogleConfiguredGuard } from './google-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.register(dto, this.context(req));
    this.setCookies(res, result.tokens);
    return { user: this.publicUser(result.user) };
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, this.context(req));
    this.setCookies(res, result.tokens);
    return { user: this.publicUser(result.user) };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string> | undefined)?.refresh_token ?? '';
    const tokens = await this.auth.refresh(token, this.context(req));
    this.setCookies(res, tokens);
    return { refreshed: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@RequestUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(user.sessionId);
    res.clearCookie('access_token', this.cookieOptions());
    res.clearCookie('refresh_token', this.cookieOptions());
    return { loggedOut: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@RequestUser() user: AuthenticatedUser) {
    return this.users.getPublicUser(user.userId);
  }

  @UseGuards(GoogleConfiguredGuard, GoogleAuthGuard)
  @Get('google')
  google(): void {}

  @UseGuards(GoogleConfiguredGuard, GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@Req() req: Request & { user: GoogleProfileUser }, @Res() res: Response) {
    const tokens = await this.auth.issueGoogleSession(req.user.id, this.context(req));
    this.setCookies(res, tokens);
    res.redirect(this.config.getOrThrow<string>('FRONTEND_URL'));
  }

  private context(req: Request) {
    return { ipAddress: req.ip, userAgent: req.get('user-agent') };
  }

  private cookieOptions() {
    return {
      httpOnly: true,
      secure: this.config.get('NODE_ENV') === 'production',
      sameSite: 'lax' as const,
      path: '/',
    };
  }

  private setCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string; accessTtl: number; refreshTtl: number },
  ): void {
    res.cookie('access_token', tokens.accessToken, { ...this.cookieOptions(), maxAge: tokens.accessTtl * 1000 });
    res.cookie('refresh_token', tokens.refreshToken, { ...this.cookieOptions(), maxAge: tokens.refreshTtl * 1000 });
  }

  private publicUser(user: { id: string; email: string; username: string }) {
    return { id: user.id, email: user.email, username: user.username };
  }
}
