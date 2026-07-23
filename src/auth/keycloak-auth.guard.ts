import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { ConfigService } from '@nestjs/config';
import { JwtUser } from './current-user.decorator';

@Injectable()
export class KeycloakStrategy extends PassportStrategy(Strategy, 'keycloak') {
  constructor(configService: ConfigService) {
    const keycloakUrl = configService.get<string>('KEYCLOAK_URL');
    const realm = configService.get<string>('KEYCLOAK_REALM');

    super({
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`,
      }),
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      algorithms: ['RS256'],
      // ASSUMPTION: KEYCLOAK_ISSUER decouples the token issuer (the external
      // hostname Keycloak advertises in KC_HOSTNAME_URL) from the internal
      // KEYCLOAK_URL used for JWKS + admin calls. Defaults to the internal URL.
      issuer:
        configService.get<string>('KEYCLOAK_ISSUER') ??
        `${keycloakUrl}/realms/${realm}`,
      audience: 'account',
    });
  }

  validate(payload: any): JwtUser {
    return {
      sub: payload.sub as string,
      email: payload.email as string | undefined,
      roles: (payload.realm_access?.roles as string[]) ?? [],
    };
  }
}
