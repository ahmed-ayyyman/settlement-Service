import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller('health')
@Public()
export class HealthController {
  @Get()
  check() {
    return { status: 'ok' };
  }
}
