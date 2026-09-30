import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CustomersServiceModule } from './customers-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(CustomersServiceModule);
  await app.listen(
    app.get(ConfigService).getOrThrow<number>('CUSTOMERS_SERVICE_PORT'),
    '127.0.0.1',
  );
}
await bootstrap();
