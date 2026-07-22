import { Module } from '@nestjs/common';
import { CrnController } from './crn.controller';
import { CrnEligibilityService } from './crn-eligibility.service';

@Module({
  controllers: [CrnController],
  providers: [CrnEligibilityService],
  exports: [CrnEligibilityService],
})
export class CrnModule {}
