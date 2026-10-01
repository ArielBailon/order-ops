import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

export const CHECKPOINTER = Symbol('CHECKPOINTER');

/** Thread checkpoints live in library-managed tables; `setup()` is idempotent. */
export async function createCheckpointer(
  connectionString: string,
): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(connectionString);
  await saver.setup();
  return saver;
}
