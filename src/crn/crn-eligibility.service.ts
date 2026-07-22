import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CrnEligibilityService {
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

  isEligible(crn: string): { needsSettlement: boolean } {
    return { needsSettlement: !this.settledCrns.has(crn.toUpperCase()) };
  }
}
