import { CrnEligibilityService } from './crn-eligibility.service';

describe('CrnEligibilityService', () => {
  let service: CrnEligibilityService;

  const createService = (settledCrns: string) => {
    const config = { get: jest.fn().mockReturnValue(settledCrns) };
    return new CrnEligibilityService(config as any);
  };

  it('returns needsSettlement=true for a CRN not in the settled list', () => {
    service = createService('CRN001,CRN002');
    expect(service.isEligible('CRN999')).toEqual({ needsSettlement: true });
  });

  it('returns needsSettlement=false for a CRN in the settled list', () => {
    service = createService('CRN001,CRN002');
    expect(service.isEligible('CRN001')).toEqual({ needsSettlement: false });
  });

  it('is case-insensitive', () => {
    service = createService('CRN001');
    expect(service.isEligible('crn001')).toEqual({ needsSettlement: false });
    expect(service.isEligible('Crn001')).toEqual({ needsSettlement: false });
  });

  it('returns needsSettlement=true for all CRNs when settled list is empty', () => {
    service = createService('');
    expect(service.isEligible('ANYTHING')).toEqual({ needsSettlement: true });
  });
});
