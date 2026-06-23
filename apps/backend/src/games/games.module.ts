import { Module } from '@nestjs/common';
import { GamesManager } from './games.manager';
import { GamesService } from './games.service';

@Module({ providers: [GamesManager, GamesService], exports: [GamesManager, GamesService] })
export class GamesModule {}
