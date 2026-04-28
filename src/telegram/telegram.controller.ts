import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { waitUntil } from '@vercel/functions';
import { Roles } from '../decorators/roles.decorator';
import { Role } from '../enum/RoleUser.enum';
import { AuthGuard } from '../guards/auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { SendTelegramMessageDto } from './dto/send-telegram-message.dto';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(private readonly telegramService: TelegramService) {}

  @Get('status')
  getStatus() {
    return this.telegramService.getStatus();
  }

  @Get('webhook-info')
  @Roles(Role.Admin)
  @UseGuards(AuthGuard, RolesGuard)
  getWebhookInfo() {
    return this.telegramService.getWebhookInfo();
  }

  @Post('send-message')
  @Roles(Role.Admin)
  @UseGuards(AuthGuard, RolesGuard)
  sendMessage(@Body() body: SendTelegramMessageDto) {
    return this.telegramService.sendMessage(body.chatId, body.text);
  }

  @Post('webhook')
  @HttpCode(200)
  handleWebhook(
    @Headers('x-telegram-bot-api-secret-token') secretToken: string,
    @Body() update: unknown,
  ) {
    this.telegramService.verifyWebhookSecret(secretToken);

    const work = this.telegramService.handleUpdate(update).catch((error) => {
      this.logger.error(
        `Telegram update processing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    waitUntil(work);

    return { ok: true };
  }
}
