import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { CustomersServiceModule } from './customers-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(CustomersServiceModule);
  app.enableShutdownHooks();
  await app.listen(
    app.get(ConfigService).getOrThrow<number>('CUSTOMERS_SERVICE_PORT'),
    app.get(ConfigService).getOrThrow<string>('HOST'),
  );
}
await bootstrap();
