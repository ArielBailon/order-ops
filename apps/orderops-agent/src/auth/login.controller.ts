import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { type Credentials, credentialsSchema, ZodValidationPipe } from '@app/auth';
import { type LoginResponse, LoginService } from './login.service.js';

@Controller('auth')
export class LoginController {
  constructor(private readonly login: LoginService) {}

  @Post('login')
  @HttpCode(200)
  signIn(
    @Body(new ZodValidationPipe(credentialsSchema)) credentials: Credentials,
  ): Promise<LoginResponse> {
    return this.login.login(credentials);
  }
}
