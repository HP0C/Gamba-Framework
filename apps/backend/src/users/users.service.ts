import { Injectable, NotFoundException } from '@nestjs/common';
import { UsersManager } from './users.manager';

@Injectable()
export class UsersService {
  constructor(private readonly manager: UsersManager) {}

  async getPublicUser(userId: string) {
    const user = await this.manager.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      createdAt: user.createdAt,
    };
  }
}
