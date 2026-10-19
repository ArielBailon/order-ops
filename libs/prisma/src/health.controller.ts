import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

export const READY_TIMEOUT_MS = 3000;

/** Unauthenticated probes for the container healthchecks; they reveal no detail. */
@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), READY_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.prisma.$queryRaw`SELECT 1`, timeout]);
    } catch (error) {
      const { name, message } = error as Error;
      this.logger.warn(`not ready: ${name}: ${message.trim().split('\n').pop()}`);
      throw new ServiceUnavailableException({ status: 'unavailable' });
    } finally {
      clearTimeout(timer);
    }
    return { status: 'ok' };
  }
}
