import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuthenticatedUser } from '../common/authenticated-user';
import { RequestUser } from '../common/request-user.decorator';
import { BetsService } from './bets.service';
import { PlaceCoinFlipDto } from './dto/place-coin-flip.dto';

@Controller('bets')
@UseGuards(JwtAuthGuard)
export class BetsController {
  constructor(private readonly bets: BetsService) {}

  @Post('coin-flip')
  coinFlip(@RequestUser() user: AuthenticatedUser, @Body() dto: PlaceCoinFlipDto) {
    return this.bets.placeCoinFlip(user.userId, dto);
  }

  @Get()
  history(@RequestUser() user: AuthenticatedUser) {
    return this.bets.history(user.userId);
  }
}
