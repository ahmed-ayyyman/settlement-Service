import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const CRN_ELIGIBILITY_SERVICE = Symbol('CrnEligibilityService');

export interface CrnEligibilityResult {
  needsSettlement: boolean;
}

export interface CrnEligibilityService {
  isEligible(crn: string): CrnEligibilityResult;
}

@Injectable()
export class StubCrnEligibilityService implements CrnEligibilityService {
  private readonly settledCrns: Set<string>;

  constructor(configService: ConfigService) {
    const raw = configService.get<string>('SETTLED_CRNS', '');
    this.settledCrns = new Set(
      raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );
  }

  isEligible(crn: string): CrnEligibilityResult {
    return { needsSettlement: !this.settledCrns.has(crn.toUpperCase()) };
  }
}
