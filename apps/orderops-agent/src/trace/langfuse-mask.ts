import type { Attributes, AttributeValue, Context } from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

/** Replaces every input and output sent to Langfuse. */
export const REDACTED = '[redacted]';

const INPUT_OUTPUT = new Set([
  'langfuse.observation.input',
  'langfuse.observation.output',
  'langfuse.trace.input',
  'langfuse.trace.output',
]);

/** Span attributes that carry no customer text, prompts, tool data or credentials. */
const SAFE = new Set([
  'langfuse.observation.type',
  'langfuse.observation.level',
  'langfuse.observation.completion_start_time',
  'langfuse.observation.model.name',
  'langfuse.observation.model.parameters',
  'langfuse.observation.usage_details',
  'langfuse.observation.cost_details',
  'langfuse.trace.name',
  'langfuse.trace.tags',
  'langfuse.environment',
  'langfuse.release',
  'langfuse.version',
  'langfuse.internal.as_root',
  'langfuse.internal.is_app_root',
  // Thread id and customer id; already visible to viewers in the observability API.
  'session.id',
  'user.id',
  'langfuse.session.id',
  'langfuse.user.id',
]);

const STATUS_MESSAGE = 'langfuse.observation.status_message';
const METADATA_PREFIX = 'langfuse.observation.metadata.';

/**
 * Run metadata kept per observation. LangChain copies primitive `configurable` values (the
 * caller's JWT, customer id, thread id) into run metadata, so everything else is dropped.
 */
export const METADATA_ALLOWLIST = new Set([
  'langgraph_node',
  'langgraph_step',
  'ls_provider',
  'ls_model_name',
  'ls_model_type',
]);

/** `err.toString()` is `Name: message`, and the message can echo model output or tool input. */
export function errorType(message: AttributeValue | undefined): string {
  const text = typeof message === 'string' ? message : '';
  const name = text.split(':')[0].trim();
  return /^[A-Za-z_$][\w$.]*$/.test(name) ? name : 'Error';
}

/** The metadata-only form of one span's attributes: a new object, the input is left as is. */
export function scrubAttributes(attributes: Attributes): Attributes {
  const scrubbed: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (INPUT_OUTPUT.has(key)) scrubbed[key] = JSON.stringify(REDACTED);
    else if (key === STATUS_MESSAGE) scrubbed[key] = errorType(value);
    else if (SAFE.has(key)) scrubbed[key] = value;
    else if (
      key.startsWith(METADATA_PREFIX) &&
      METADATA_ALLOWLIST.has(key.slice(METADATA_PREFIX.length))
    )
      scrubbed[key] = value;
    // Anything else (other metadata keys, trace metadata, unknown attributes) is dropped.
  }
  return scrubbed;
}

/**
 * Scrubs each finished span before the wrapped processor (Langfuse's) exports it. Masking
 * lives here, in one place, so no caller has to avoid sending text.
 */
export class ScrubbingSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    const attributes = span.attributes as Attributes;
    const scrubbed = scrubAttributes(attributes);
    for (const key of Object.keys(attributes)) delete attributes[key];
    Object.assign(attributes, scrubbed);
    // Exception events and the status message would carry the same error text.
    (span.events as unknown[]).length = 0;
    if (span.status.message) {
      Object.assign(span.status, { message: errorType(span.status.message) });
    }
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
