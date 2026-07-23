import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { CRN_ELIGIBILITY_SERVICE } from './crn-eligibility.service';
import type { CrnEligibilityService } from './crn-eligibility.service';

@Controller('crn')
export class CrnController {
  constructor(
    @Inject(CRN_ELIGIBILITY_SERVICE)
    private readonly crnEligibilityService: CrnEligibilityService,
  ) {}

  @Get(':crn/eligibility')
  @Roles('owner')
  checkEligibility(@Param('crn') crn: string) {
    if (
      !crn ||
      crn.length < 5 ||
      crn.length > 20 ||
      !/^[a-zA-Z0-9]+$/.test(crn)
    ) {
      throw new BadRequestException('CRN must be 5-20 alphanumeric characters');
    }
    const result = this.crnEligibilityService.isEligible(crn);
    return { crn, needsSettlement: result.needsSettlement };
  }
}
