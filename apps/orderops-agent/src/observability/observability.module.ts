import { Module } from '@nestjs/common';
import { AuthModule } from '@app/auth';
import { PrismaModule } from '@app/prisma';
import { defaultEvalResultsDir, EVAL_RESULTS_DIR } from './eval-results.js';
import { ObservabilityController } from './observability.controller.js';
import {
  OBSERVABILITY_STORE,
  PrismaObservabilityStore,
} from './observability.store.js';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ObservabilityController],
  providers: [
    { provide: OBSERVABILITY_STORE, useClass: PrismaObservabilityStore },
    { provide: EVAL_RESULTS_DIR, useFactory: defaultEvalResultsDir },
  ],
})
export class ObservabilityModule {}
