import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { CallbackHandler } from '@langfuse/langchain';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { context, trace, TraceFlags } from '@opentelemetry/api';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ScrubbingSpanProcessor } from './langfuse-mask.js';

export const LANGFUSE = Symbol('LANGFUSE');

/** Per-request Langfuse handlers; null (not provided) when Langfuse is off. */
export interface LangfuseTracing {
  handlerFor(
    traceId: string,
    ids: { sessionId: string; userId: string },
  ): BaseCallbackHandler;
  flush(): Promise<void>;
}

/**
 * Langfuse (OpenTelemetry) trace ids are 32 lowercase hex characters. `ChatTrace.id` is a
 * UUID, so the Langfuse id is the same UUID without dashes, and the mapping is reversible.
 */
export function langfuseTraceId(chatTraceId: string): string {
  return chatTraceId.replace(/-/g, '').toLowerCase();
}

/**
 * The Langfuse handler starts its root span under the active OpenTelemetry context and every
 * child under its parent run. Activating a context carrying our trace id while the root run
 * starts puts the whole span tree under `ChatTrace.id`.
 */
class TraceBoundHandler extends CallbackHandler {
  constructor(
    private readonly otelTraceId: string,
    params: { sessionId: string; userId: string },
  ) {
    super(params);
  }

  override handleChainStart(
    ...args: Parameters<CallbackHandler['handleChainStart']>
  ): Promise<void> {
    const parentRunId = args[3];
    if (parentRunId) return super.handleChainStart(...args);
    const parent = trace.setSpanContext(context.active(), {
      traceId: this.otelTraceId,
      // Never created: only carries the trace id, as Langfuse documents for external ids.
      spanId: randomBytes(8).toString('hex'),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });
    return context.with(parent, () => super.handleChainStart(...args));
  }
}

/** Registers a tracer provider whose spans are scrubbed and then sent by `exporter`. */
export function createLangfuseTracing(
  exporter: SpanProcessor,
): LangfuseTracing {
  const provider = new NodeTracerProvider({
    spanProcessors: [new ScrubbingSpanProcessor(exporter)],
  });
  // Sets the global tracer provider and the async context manager the handler relies on.
  provider.register();
  return {
    handlerFor: (traceId, ids) =>
      new TraceBoundHandler(langfuseTraceId(traceId), ids),
    flush: () => provider.forceFlush(),
  };
}

const logger = new Logger('Langfuse');

/** Langfuse when both keys are set (env validation enforces both or neither), else null. */
export function langfuseFromEnv(env: {
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL: string;
}): LangfuseTracing | null {
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return null;
  logger.log(`sending metadata-only spans to ${env.LANGFUSE_BASE_URL}`);
  return createLangfuseTracing(
    new LangfuseSpanProcessor({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
      // Inputs are redacted anyway; no separate media uploads.
      mediaUploadEnabled: false,
    }),
  );
}
