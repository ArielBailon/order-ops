import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoginModule } from './auth/login.module.js';
import { ChatModule } from './chat/chat.module.js';
import { validateEnv } from './env.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    LoginModule,
    ChatModule,
  ],
})
export class AppModule {}
