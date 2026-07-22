import {
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { JwtUser } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';

@Controller('api/notifications')
@UseGuards(AuthGuard('keycloak'), RolesGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  async findAll(@CurrentUser() user: JwtUser) {
    const isBackoffice = user.roles.includes('backoffice_employee');
    const notifications = isBackoffice
      ? await this.notificationsService.findForBackoffice()
      : await this.notificationsService.findForOwner(user.sub);
    const unreadCount = notifications.filter((n) => !n.isRead).length;
    return { notifications, unreadCount };
  }

  @Patch(':id/read')
  async markRead(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    const result = await this.notificationsService.markAsRead(id, user.sub);
    if (result === null) {
      throw new NotFoundException('Notification not found');
    }
    if (result === 'FORBIDDEN') {
      throw new ForbiddenException('Cannot mark this notification as read');
    }
    return result;
  }
}
