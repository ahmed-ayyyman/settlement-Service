import { Module } from '@nestjs/common';
import { CrnController } from './crn.controller';
import {
  CRN_ELIGIBILITY_SERVICE,
  StubCrnEligibilityService,
} from './crn-eligibility.service';

@Module({
  controllers: [CrnController],
  providers: [
    {
      provide: CRN_ELIGIBILITY_SERVICE,
      useClass: StubCrnEligibilityService,
    },
  ],
  exports: [CRN_ELIGIBILITY_SERVICE],
})
export class CrnModule {}
