import { Body, Controller, Get, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';
import { AuthenticatedUser, GoogleProfileUser } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { MobileRefreshDto } from './dto/mobile-refresh.dto';
import { RegisterDto } from './dto/register.dto';
import { GoogleAuthGuard, GoogleConfiguredGuard } from './google-auth.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RequestUser } from './request-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Post('register')
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // The controller only handles HTTP details: read the request, call the service,
    // set cookies, and return a public response. Account creation rules live below.
    const result = await this.auth.register(dto, this.context(req));
    this.setCookies(res, result.tokens);
    return { user: this.publicUser(result.user) };
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // A successful login creates a new server-side session and sends the browser
    // signed tokens in HTTP-only cookies.
    const result = await this.auth.login(dto, this.context(req));
    this.setCookies(res, result.tokens);
    return { user: this.publicUser(result.user) };
  }

  @Post('mobile/register')
  async mobileRegister(@Body() dto: RegisterDto, @Req() req: Request) {
    const result = await this.auth.register(dto, this.context(req));
    return { user: this.publicUser(result.user), tokens: result.tokens };
  }

  @Post('mobile/login')
  async mobileLogin(@Body() dto: LoginDto, @Req() req: Request) {
    const result = await this.auth.login(dto, this.context(req));
    return { user: this.publicUser(result.user), tokens: result.tokens };
  }

  @Post('mobile/refresh')
  async mobileRefresh(@Body() dto: MobileRefreshDto, @Req() req: Request) {
    const tokens = await this.auth.refresh(dto.refreshToken, this.context(req));
    return { tokens };
  }

  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Refresh uses the longer-lived refresh_token cookie to rotate into a new
    // session. Rotation helps limit damage if an old refresh token is exposed.
    const token = (req.cookies as Record<string, string> | undefined)?.refresh_token ?? '';
    const tokens = await this.auth.refresh(token, this.context(req));
    this.setCookies(res, tokens);
    return { refreshed: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  async logout(@RequestUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) {
    // JwtAuthGuard has already verified the access token and attached request.user.
    // @RequestUser() gives us that trusted user/session identity.
    await this.auth.logout(user.sessionId);
    res.clearCookie('access_token', this.cookieOptions());
    res.clearCookie('refresh_token', this.cookieOptions());
    return { loggedOut: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@RequestUser() user: AuthenticatedUser) {
    // The frontend never sends a userId here. The backend gets it from the signed
    // JWT so one user cannot ask for another user's profile by changing JSON.
    return this.users.getPublicUser(user.userId);
  }

  @UseGuards(GoogleConfiguredGuard, GoogleAuthGuard)
  @Get('google')
  // Passport handles this route by redirecting the browser to Google's login page.
  google(): void {}

  @UseGuards(GoogleConfiguredGuard, GoogleAuthGuard)
  @Get('google/callback')
  async googleCallback(@Req() req: Request & { user: GoogleProfileUser }, @Res() res: Response) {
    // After Google redirects back, Passport validates the Google profile and places
    // the matching local user on req.user.
    const tokens = await this.auth.issueGoogleSession(req.user.id, this.context(req));
    this.setCookies(res, tokens);
    res.redirect(this.config.getOrThrow<string>('FRONTEND_URL'));
  }

  private context(req: Request) {
    // Store simple request context with sessions/audit logs for future security
    // investigation and fraud monitoring.
    return { ipAddress: req.ip, userAgent: req.get('user-agent') };
  }

  private cookieOptions() {
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? '';
    const isLocalFrontend =
      frontendUrl.startsWith('http://localhost') || frontendUrl.startsWith('http://127.0.0.1');
    const useCrossSiteCookies = !isLocalFrontend;

    return {
      // httpOnly means frontend JavaScript cannot read the token values directly.
      httpOnly: true,
      // Localhost development uses plain HTTP; deployed frontend/backend URLs use HTTPS.
      secure: useCrossSiteCookies,
      // Vercel and Render are different sites. Production API cookies therefore
      // need SameSite=None so the browser includes them on frontend -> backend
      // fetch requests. Localhost can stay Lax because it often runs over HTTP.
      sameSite: (useCrossSiteCookies ? 'none' : 'lax') as 'none' | 'lax',
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
    // Never return passwordHash, token hashes, or internal compliance/risk fields.
    return { id: user.id, email: user.email, username: user.username };
  }
}
