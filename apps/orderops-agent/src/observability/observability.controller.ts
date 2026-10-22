import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, ViewerGuard, ZodValidationPipe } from '@app/auth';
import {
  EVAL_RESULTS_DIR,
  latestEvals,
  type LatestEvalsResponse,
} from './eval-results.js';
import {
  type SummaryQuery,
  summaryQuerySchema,
  type SummaryResponse,
  type TraceDetail,
  traceIdSchema,
  type TraceListQuery,
  traceListQuerySchema,
  type TraceListResponse,
} from './observability.schemas.js';
import {
  OBSERVABILITY_STORE,
  type ObservabilityStore,
} from './observability.store.js';

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Read-only trace metrics for viewers and operators; customers get 403. */
@Controller('observability')
@UseGuards(JwtAuthGuard, ViewerGuard)
export class ObservabilityController {
  constructor(
    @Inject(OBSERVABILITY_STORE) private readonly store: ObservabilityStore,
    @Inject(EVAL_RESULTS_DIR) private readonly evalResultsDir: string,
  ) {}

  @Get('summary')
  summary(
    @Query(new ZodValidationPipe(summaryQuerySchema)) { since }: SummaryQuery,
  ): Promise<SummaryResponse> {
    const now = new Date();
    return this.store.summary(
      since ?? new Date(now.getTime() - DEFAULT_WINDOW_MS),
      now,
    );
  }

  @Get('traces')
  async traces(
    @Query(new ZodValidationPipe(traceListQuerySchema)) query: TraceListQuery,
  ): Promise<TraceListResponse> {
    const page = await this.store.listTraces(query);
    if (!page) throw new BadRequestException(['before: unknown trace id']);
    return page;
  }

  /** Latest eval run per provider from the result files baked into the image. */
  @Get('evals/latest')
  evals(): Promise<LatestEvalsResponse> {
    return latestEvals(this.evalResultsDir);
  }

  @Get('traces/:id')
  async trace(
    @Param('id', new ZodValidationPipe(traceIdSchema)) id: string,
  ): Promise<TraceDetail> {
    const trace = await this.store.getTrace(id);
    if (!trace) throw new NotFoundException();
    return trace;
  }
}
