import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApprovalsModule } from './approvals/approvals.module.js';
import { LoginModule } from './auth/login.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ObservabilityModule } from './observability/observability.module.js';
import { validateEnv } from './env.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoginModule,
    ChatModule,
    ApprovalsModule,
    ObservabilityModule,
  ],
})
export class AppModule {}
