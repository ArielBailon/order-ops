import { Module } from '@nestjs/common';
import { PrismaModule } from '@app/prisma';
import { PrismaTraceStore, TRACE_STORE } from './trace.store.js';

@Module({
  imports: [PrismaModule],
  providers: [{ provide: TRACE_STORE, useClass: PrismaTraceStore }],
  exports: [TRACE_STORE],
})
export class TraceModule {}
