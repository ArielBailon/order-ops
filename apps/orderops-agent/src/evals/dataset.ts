import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { chatRouteSchema } from '../chat/chat.schemas.js';
import { CUSTOMER_IDS } from './fixtures.js';

export const DATASET_PATH = fileURLToPath(
  new URL('../../../../evals/dataset.json', import.meta.url),
);

export const categorySchema = z.enum(['normal', 'out_of_scope', 'adversarial']);
export type EvalCategory = z.infer<typeof categorySchema>;

const guardrailSchema = z.strictObject({
  /** Refund outcome on the last turn's `final` event; `none` means no refund summary. */
  refund: z.enum(['pending_approval', 'auto_rejected', 'none']).optional(),
  /** Whether the last turn streams `approval_required`. */
  approvalRequired: z.boolean().optional(),
  /** Strings that must not appear in the last turn's answer. */
  mustNotInclude: z.array(z.string().min(1)).optional(),
  /** The last turn's answer is the fixed out-of-scope refusal. */
  refusal: z.boolean().optional(),
  /** The order (and amount) a stored refund outcome refers to; checked against the rules by the dataset spec. */
  refundTarget: z
    .strictObject({
      orderId: z.string().min(1),
      amount: z.string().optional(),
    })
    .optional(),
});

export const evalCaseSchema = z.strictObject({
  id: z.string().min(1),
  category: categorySchema,
  customer: z.enum(Object.keys(CUSTOMER_IDS) as [string, ...string[]]),
  turns: z.array(z.string().min(1)).min(1),
  expect: z.strictObject({
    route: chatRouteSchema,
    /** Tool names over the whole case, in call order; empty means no tool is called. */
    tools: z.array(z.enum(['list_orders', 'get_order'])),
    /** `orderId` per tool call, by position; checked only where given. */
    toolArgs: z.array(z.strictObject({ orderId: z.string() })).optional(),
    /**
     * Read-only order lookups (`get_order`, `list_orders`) beyond `tools` do not count against
     * the tools and trajectory metrics. Set on refund cases: the refund route may look the order
     * up before proposing, and the outcome is scored by `guardrail`.
     */
    lookupsAllowed: z.boolean().optional(),
    guardrail: guardrailSchema.optional(),
  }),
});

export type EvalCase = Omit<z.infer<typeof evalCaseSchema>, 'customer'> & {
  customer: keyof typeof CUSTOMER_IDS;
};

export const datasetSchema = z.array(evalCaseSchema).min(1);

export interface LoadedDataset {
  cases: EvalCase[];
  /** SHA-256 of the file bytes, recorded in every results file. */
  sha256: string;
}

export async function loadDataset(
  path: string = DATASET_PATH,
): Promise<LoadedDataset> {
  const bytes = await readFile(path);
  const cases = datasetSchema.parse(JSON.parse(bytes.toString('utf8')));
  const ids = new Set<string>();
  for (const { id } of cases) {
    if (ids.has(id)) throw new Error(`Duplicate eval case id: ${id}`);
    ids.add(id);
  }
  return {
    cases: cases as EvalCase[],
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
