import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestUser } from '../auth/request-user.decorator';
import { BetsService } from './bets.service';
import { PlaceCoinFlipDto } from './dto/place-coin-flip.dto';
import { PlaceRouletteDto } from './dto/place-roulette.dto';

@Controller('bets')
@UseGuards(JwtAuthGuard)
export class BetsController {
  constructor(private readonly bets: BetsService) {}

  @Post('coin-flip')
  coinFlip(@RequestUser() user: AuthenticatedUser, @Body() dto: PlaceCoinFlipDto) {
    return this.bets.placeCoinFlip(user.userId, dto);
  }

  @Post('roulette')
  roulette(@RequestUser() user: AuthenticatedUser, @Body() dto: PlaceRouletteDto) {
    return this.bets.placeRoulette(user.userId, dto);
  }

  @Get()
  history(@RequestUser() user: AuthenticatedUser) {
    return this.bets.history(user.userId);
  }
}
