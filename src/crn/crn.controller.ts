import {
  BadRequestException,
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CrnEligibilityService } from './crn-eligibility.service';

@Controller('api/crn')
@UseGuards(AuthGuard('keycloak'), RolesGuard)
export class CrnController {
  constructor(private readonly crnEligibilityService: CrnEligibilityService) {}

  @Get(':crn/eligibility')
  @Roles('owner')
  checkEligibility(@Param('crn') crn: string) {
    if (!crn || crn.length < 5 || crn.length > 20 || !/^[a-zA-Z0-9]+$/.test(crn)) {
      throw new BadRequestException('CRN must be 5-20 alphanumeric characters');
    }
    const result = this.crnEligibilityService.isEligible(crn);
    return { crn, needsSettlement: result.needsSettlement };
  }
}
