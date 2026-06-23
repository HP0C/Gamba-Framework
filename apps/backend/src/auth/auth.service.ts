import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { UsersManager } from '../users/users.manager';
import { AuthManager } from './auth.manager';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly authManager: AuthManager,
    private readonly usersManager: UsersManager,
    private readonly audit: AuditService,
  ) {}

  async register(dto: RegisterDto, context: RequestContext) {
    // Registration is a use case: hash the password, create the user/wallet data,
    // create a session, then audit the event.
    const passwordHash = await this.authManager.hashPassword(dto.password);
    const user = await this.usersManager.createLocal({ ...dto, passwordHash });
    const tokens = await this.authManager.createSession(user.id, context);
    await this.audit.record({ userId: user.id, action: 'AUTH_REGISTER', entityType: 'USER', entityId: user.id });
    return { user, tokens };
  }

  async login(dto: LoginDto, context: RequestContext) {
    // The user may log in with username or email. We compare the submitted password
    // against the stored Argon2 hash; the original password is never stored.
    const user = await this.usersManager.findByLogin(dto.login);
    if (!user?.passwordHash || !(await this.authManager.verifyPassword(user.passwordHash, dto.password))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    if (user.status !== 'ACTIVE') throw new UnauthorizedException('Account is not active');
    const tokens = await this.authManager.createSession(user.id, context);
    await this.audit.record({ userId: user.id, action: 'AUTH_LOGIN', entityType: 'SESSION' });
    return { user, tokens };
  }

  issueGoogleSession(userId: string, context: RequestContext) {
    // GoogleStrategy has already matched or created the local user. From this point
    // onward, Google users receive the same local JWT/session treatment.
    return this.authManager.createSession(userId, context);
  }

  refresh(token: string, context: RequestContext) {
    return this.authManager.rotateSession(token, context);
  }

  logout(sessionId: string) {
    return this.authManager.revokeSession(sessionId);
  }
}
