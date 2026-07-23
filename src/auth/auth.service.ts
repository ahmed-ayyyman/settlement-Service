import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { RegisterDto } from './dto/input/register.dto';
import { RegisterResponseDto } from './dto/output/register-response.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly keycloakUrl: string;
  private readonly realm: string;
  private readonly clientId: string;
  private readonly clientSecret: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
  ) {
    this.keycloakUrl = configService.get<string>('KEYCLOAK_URL')!;
    this.realm = configService.get<string>('KEYCLOAK_REALM')!;
    this.clientId = configService.get<string>('KEYCLOAK_CLIENT_ID')!;
    this.clientSecret = configService.get<string>('KEYCLOAK_CLIENT_SECRET')!;
  }

  async register(dto: RegisterDto): Promise<RegisterResponseDto> {
    const token = await this.getAdminToken();
    const userId = await this.createKeycloakUser(token, dto);
    await this.assignRole(token, userId, 'owner');
    return { id: userId, email: dto.email };
  }

  private async getAdminToken(): Promise<string> {
    const { data } = await firstValueFrom(
      this.httpService.post(
        `${this.keycloakUrl}/realms/${this.realm}/protocol/openid-connect/token`,
        new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          grant_type: 'client_credentials',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      ),
    );
    return data.access_token;
  }

  private async createKeycloakUser(
    token: string,
    dto: RegisterDto,
  ): Promise<string> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.keycloakUrl}/admin/realms/${this.realm}/users`,
          {
            email: dto.email,
            username: dto.email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            enabled: true,
            credentials: [
              {
                type: 'password',
                value: dto.password,
                temporary: false,
              },
            ],
          },
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          },
        ),
      );
      const userId = this.extractUserIdFromLocation(response.headers?.location);
      if (userId) {
        return userId;
      }
      return this.findUserByEmail(token, dto.email);
    } catch (err: any) {
      if (err.response?.status === 409) {
        throw new BadRequestException('Email already registered');
      }
      this.logger.error(
        'Keycloak user creation failed',
        err.response?.data || err.message,
      );
      throw new InternalServerErrorException(
        'Failed to create user in Keycloak',
      );
    }
  }

  private async findUserByEmail(token: string, email: string): Promise<string> {
    const { data: users } = await firstValueFrom(
      this.httpService.get(
        `${this.keycloakUrl}/admin/realms/${this.realm}/users?email=${encodeURIComponent(email)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    if (users && users.length > 0) {
      return users[0].id;
    }
    throw new InternalServerErrorException(
      'User created but could not be retrieved',
    );
  }

  private async assignRole(
    token: string,
    userId: string,
    roleName: string,
  ): Promise<void> {
    const { data: role } = await firstValueFrom(
      this.httpService.get(
        `${this.keycloakUrl}/admin/realms/${this.realm}/roles/${roleName}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
    await firstValueFrom(
      this.httpService.post(
        `${this.keycloakUrl}/admin/realms/${this.realm}/users/${userId}/role-mappings/realm`,
        [role],
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      ),
    );
  }

  private extractUserIdFromLocation(location: string): string | null {
    if (!location) return null;
    const parts = location.split('/');
    return parts[parts.length - 1] || null;
  }
}
