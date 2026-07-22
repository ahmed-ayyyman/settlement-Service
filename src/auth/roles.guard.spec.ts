import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);
  });

  const mockContext = (userRoles: string[]) => ({
    switchToHttp: () => ({
      getRequest: () => ({
        user: { sub: 'test-user', roles: userRoles },
      }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  });

  it('allows access when no roles are required', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const ctx = mockContext(['owner']) as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows access when user has the required role', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['owner']);
    const ctx = mockContext(['owner']) as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('denies access when user lacks the required role', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['backoffice_employee']);
    const ctx = mockContext(['owner']) as any;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('denies access when user is not authenticated', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['owner']);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({ user: null }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows access when user has one of multiple required roles', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue(['owner', 'backoffice_employee']);
    const ctx = mockContext(['owner']) as any;
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
