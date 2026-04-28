import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import {
  AllAiProvidersExhaustedError,
  IaService,
} from '../IA/ia.service';
import { TelegramConversation } from '../entities/telegram-conversation.entity';
import { ConversationEncryptionService } from './conversation-encryption.service';

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramUpdate = {
  message?: {
    chat?: {
      id?: string | number;
    };
    text?: string;
  };
};

@Injectable()
export class TelegramService {
  private readonly apiBase = 'https://api.telegram.org';
  private readonly processingChats = new Set<string>();
  private readonly conversationLimit = 4;
  private readonly conversationLimitWindowHours = 24;
  private readonly contextConversationLimit = 10;

  constructor(
    private readonly iaService: IaService,
    private readonly encryptionService: ConversationEncryptionService,
    @InjectRepository(TelegramConversation)
    private readonly conversationsRepository: Repository<TelegramConversation>,
  ) {}

  getStatus() {
    return {
      provider: 'telegram',
      botTokenConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      webhookSecretConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      aiConfigured: Boolean(
        process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY,
      ),
      unlockPinConfigured: Boolean(process.env.BOT_UNLOCK_PIN),
      conversationEncryptionConfigured: Boolean(
        process.env.CONVERSATION_ENCRYPTION_KEY,
      ),
      conversationLimit: this.conversationLimit,
      conversationLimitScope: 'global_rolling_window',
      conversationLimitWindowHours: this.conversationLimitWindowHours,
      contextConversationLimit: this.contextConversationLimit,
    };
  }

  async getWebhookInfo() {
    return this.telegramRequest('getWebhookInfo');
  }

  async sendMessage(chatId: string | number, text: string) {
    if (!chatId || !text) {
      throw new BadRequestException('chatId and text are required.');
    }

    return this.telegramRequest('sendMessage', {
      chat_id: chatId,
      text,
    });
  }

  verifyWebhookSecret(secretToken?: string) {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

    if (expectedSecret && secretToken !== expectedSecret) {
      throw new UnauthorizedException('Invalid Telegram webhook secret.');
    }
  }

  async handleUpdate(update: unknown) {
    const telegramUpdate = update as TelegramUpdate;
    const chatId = telegramUpdate.message?.chat?.id;
    const text = telegramUpdate.message?.text;

    if (!chatId || !text) {
      return {
        ok: true,
        handled: false,
      };
    }

    const chatKey = String(chatId);

    if (this.processingChats.has(chatKey)) {
      await this.sendMessage(
        chatId,
        'Estoy pensando tu mensaje anterior. Dame un momento.',
      );

      return {
        ok: true,
        handled: false,
        reason: 'chat_is_processing',
        chatId,
      };
    }

    this.processingChats.add(chatKey);

    try {
      const windowCount = await this.countConversationsInCurrentWindow();
      const chatUnlockedInWindow =
        await this.isChatUnlockedInCurrentWindow(chatKey);
      const usedUnlockPin = this.isUnlockPin(text);
      const usedExitCommand = this.isExitCommand(text);

      if (chatUnlockedInWindow && usedExitCommand) {
        const exitMessage =
          'Listo. El chat quedo bloqueado de nuevo. Para continuar, envia el PIN.';

        await this.sendMessage(chatId, exitMessage);
        await this.saveConversation(
          chatKey,
          '[SALIR]',
          exitMessage,
          windowCount + 1,
          false,
          true,
        );

        return {
          ok: true,
          handled: true,
          chatId,
          usedExitCommand: true,
        };
      }

      if (
        windowCount >= this.conversationLimit &&
        !chatUnlockedInWindow &&
        !usedUnlockPin
      ) {
        await this.sendMessage(
          chatId,
          'El uso global del bot llego a 4 veces en las ultimas 24 horas. Envia el PIN para continuar.',
        );

        return {
          ok: true,
          handled: false,
          reason: 'global_24h_limit_reached',
          chatId,
        };
      }

      if (windowCount >= this.conversationLimit && usedUnlockPin) {
        const unlockMessage = 'PIN correcto. Ya puedes seguir usando el bot hoy.';

        await this.sendMessage(chatId, unlockMessage);
        await this.saveConversation(
          chatKey,
          '[PIN_CORRECTO]',
          unlockMessage,
          windowCount + 1,
          true,
        );

        return {
          ok: true,
          handled: true,
          chatId,
          usedUnlockPin: true,
        };
      }

      const attemptNumber = windowCount + 1;
      const context = await this.getConversationContext(chatKey);

      await this.sendChatAction(chatId, 'typing');
      const reply = await this.iaService.generateReply(text, context);
      const telegramReply = `${reply}\n\nuso de el bot 4 veces cada 24 horas intento numero ${attemptNumber}`;

      await this.sendMessage(chatId, telegramReply);
      await this.saveConversation(
        chatKey,
        text,
        reply,
        attemptNumber,
        false,
      );

      return {
        ok: true,
        handled: true,
        chatId,
        receivedText: text,
        attemptNumber,
      };
    } catch (error) {
      console.error('AI response failed:', error);

      const userMessage =
        error instanceof AllAiProvidersExhaustedError
          ? this.buildProvidersExhaustedMessage(error)
          : 'Tuve un problema pensando la respuesta. Intenta otra vez en un momento.';

      try {
        await this.sendMessage(chatId, userMessage);
      } catch (sendError) {
        console.error('Failed to notify user about AI failure:', sendError);
      }

      return {
        ok: false,
        handled: true,
        chatId,
      };
    } finally {
      this.processingChats.delete(chatKey);
    }
  }

  private buildProvidersExhaustedMessage(
    error: AllAiProvidersExhaustedError,
  ): string {
    const lines = [
      '⚠️ Las dos IAs estan caidas o sin cupo ahora mismo. No puedo responder en este momento.',
      'Intenta de nuevo en unos minutos. Si el problema sigue, avisa al administrador.',
    ];

    if (error.geminiError) {
      lines.push(`• Gemini: ${this.shortenForUser(error.geminiError)}`);
    }
    if (error.nvidiaError) {
      lines.push(`• NVIDIA: ${this.shortenForUser(error.nvidiaError)}`);
    }

    return lines.join('\n');
  }

  private shortenForUser(detail: string): string {
    const max = 140;
    const cleaned = detail.replace(/\s+/g, ' ').trim();
    return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
  }

  private async sendChatAction(chatId: string | number, action: string) {
    return this.telegramRequest('sendChatAction', {
      chat_id: chatId,
      action,
    });
  }

  private async countConversationsInCurrentWindow() {
    const { windowStart, windowEnd } = this.getCurrentLimitWindow();

    return this.conversationsRepository.count({
      where: {
        createdAt: Between(windowStart, windowEnd),
      },
    });
  }

  private async isChatUnlockedInCurrentWindow(chatId: string) {
    const { windowStart, windowEnd } = this.getCurrentLimitWindow();

    const latestUnlockControl = await this.conversationsRepository.findOne({
      where: [
        {
          chatId,
          usedUnlockPin: true,
          createdAt: Between(windowStart, windowEnd),
        },
        {
          chatId,
          usedExitCommand: true,
          createdAt: Between(windowStart, windowEnd),
        },
      ],
      order: {
        createdAt: 'DESC',
      },
    });

    return Boolean(latestUnlockControl?.usedUnlockPin);
  }

  private async getConversationContext(chatId: string) {
    const conversations = await this.conversationsRepository.find({
      where: { chatId },
      order: { createdAt: 'DESC' },
      take: this.contextConversationLimit,
    });

    return conversations.reverse().map((conversation) => ({
      userMessage: this.encryptionService.decrypt(conversation.userMessage),
      botMessage: this.encryptionService.decrypt(conversation.botMessage),
    }));
  }

  private async saveConversation(
    chatId: string,
    userMessage: string,
    botMessage: string,
    attemptNumber: number,
    usedUnlockPin: boolean,
    usedExitCommand = false,
  ) {
    const conversation = this.conversationsRepository.create({
      chatId,
      userMessage: this.encryptionService.encrypt(userMessage),
      botMessage: this.encryptionService.encrypt(botMessage),
      attemptNumber,
      usedUnlockPin,
      usedExitCommand,
    });

    await this.conversationsRepository.save(conversation);
  }

  private getCurrentLimitWindow() {
    const windowEnd = new Date();
    const windowStart = new Date(
      windowEnd.getTime() -
        this.conversationLimitWindowHours * 60 * 60 * 1000,
    );

    return { windowStart, windowEnd };
  }

  private isUnlockPin(message: string) {
    const unlockPin = process.env.BOT_UNLOCK_PIN;

    return Boolean(unlockPin && message.trim() === unlockPin);
  }

  private isExitCommand(message: string) {
    return message.trim().toLowerCase() === 'salir';
  }

  private async telegramRequest<T = unknown>(method: string, payload?: object) {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new InternalServerErrorException(
        'Missing TELEGRAM_BOT_TOKEN environment variable.',
      );
    }

    const response = await fetch(`${this.apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    });

    const data = (await response.json()) as TelegramApiResponse<T>;

    if (!response.ok || !data.ok) {
      throw new BadRequestException({
        message: 'Telegram API request failed.',
        method,
        status: response.status,
        description: data.description,
      });
    }

    return data.result;
  }
}
