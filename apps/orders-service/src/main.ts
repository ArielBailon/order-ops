import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { OrdersServiceModule } from './orders-service.module.js';

async function bootstrap() {
  const app = await NestFactory.create(OrdersServiceModule);
  await app.listen(
    app.get(ConfigService).getOrThrow<number>('ORDERS_SERVICE_PORT'),
    '127.0.0.1',
  );
}
await bootstrap();
