import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { LoginController } from './login.controller.js';
import { LoginService } from './login.service.js';

@Module({
  imports: [AuthModule],
  controllers: [LoginController],
  providers: [LoginService],
})
export class LoginModule {}
