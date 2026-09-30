import {
  Body,
  Controller,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { type Credentials, credentialsSchema, ZodValidationPipe } from '@app/auth';
import {
  CustomersServiceUnavailableError,
  InvalidCredentialsError,
  type LoginResponse,
  LoginService,
} from './login.service.js';

@Controller('auth')
export class LoginController {
  constructor(private readonly login: LoginService) {}

  @Post('login')
  @HttpCode(200)
  async signIn(
    @Body(new ZodValidationPipe(credentialsSchema)) credentials: Credentials,
  ): Promise<LoginResponse> {
    try {
      return await this.login.login(credentials);
    } catch (error) {
      if (error instanceof InvalidCredentialsError)
        throw new UnauthorizedException('Invalid credentials');
      if (error instanceof CustomersServiceUnavailableError)
        throw new ServiceUnavailableException();
      throw error;
    }
  }
}
