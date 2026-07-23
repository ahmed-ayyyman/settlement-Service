import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { KeycloakStrategy } from './keycloak-auth.guard';

@Module({
  imports: [
    HttpModule,
    PassportModule.register({ defaultStrategy: 'keycloak' }),
    ConfigModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, KeycloakStrategy],
  exports: [KeycloakStrategy, PassportModule],
})
export class AuthModule {}
