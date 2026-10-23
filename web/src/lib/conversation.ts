import type { SseMessage } from './sse';

/** Mirrors the gateway's `trace` SSE event: metadata about one reply, never message text. */
export interface TraceSummary {
  id: string;
  route: string | null;
  tools: string[];
  provider: string | null;
  model: string | null;
  failovers: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  costUsd: string | null;
  unpriced: number;
  latencyMs: number;
  status: 'ok' | 'error';
}

export interface ApprovalNotice {
  refundId: string;
  orderId: string;
  amount: string;
}

/** The gateway's chat events, as far as the console uses them. */
export type ChatEvent =
  | { type: 'token'; data: { text: string } }
  | { type: 'tool_call'; data: { name: string; args: Record<string, unknown> } }
  | { type: 'approval_required'; data: ApprovalNotice }
  | { type: 'final'; data: { answer: string; route: string; threadId: string } }
  | { type: 'error'; data: { code: string; message: string } }
  | { type: 'trace'; data: TraceSummary };

const EVENT_TYPES = new Set<string>([
  'token',
  'tool_call',
  'approval_required',
  'final',
  'error',
  'trace',
]);

/** A known chat event, or null for unknown event types and data that is not JSON. */
export function toChatEvent(message: SseMessage): ChatEvent | null {
  if (!EVENT_TYPES.has(message.event)) return null;
  try {
    return { type: message.event, data: JSON.parse(message.data) } as ChatEvent;
  } catch {
    return null;
  }
}

export type ReplyStatus = 'streaming' | 'done' | 'failed' | 'interrupted';

export interface UserMessage {
  id: string;
  role: 'user';
  text: string;
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  text: string;
  status: ReplyStatus;
  tools: string[];
  approval?: ApprovalNotice;
  error?: string;
  trace?: TraceSummary;
}

export type Message = UserMessage | AssistantMessage;

export interface Conversation {
  threadId?: string;
  messages: Message[];
}

export type ConversationAction =
  | { type: 'send'; userId: string; assistantId: string; text: string }
  | { type: 'event'; assistantId: string; event: ChatEvent }
  /** The stream closed or was aborted; a reply still streaming was cut off. */
  | { type: 'end'; assistantId: string }
  /** The request failed before or instead of a stream (network, 4xx, 5xx). */
  | { type: 'fail'; assistantId: string; message: string }
  | { type: 'reset' };

export const emptyConversation: Conversation = { messages: [] };

function updateReply(
  state: Conversation,
  id: string,
  update: (reply: AssistantMessage) => AssistantMessage,
): Conversation {
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.role === 'assistant' && message.id === id ? update(message) : message,
    ),
  };
}

function applyEvent(reply: AssistantMessage, event: ChatEvent): AssistantMessage {
  switch (event.type) {
    case 'token':
      return { ...reply, text: reply.text + event.data.text };
    case 'tool_call':
      return { ...reply, tools: [...reply.tools, event.data.name] };
    case 'approval_required':
      return { ...reply, approval: event.data };
    case 'final':
      return { ...reply, text: event.data.answer, status: 'done' };
    case 'error':
      return { ...reply, status: 'failed', error: event.data.message };
    case 'trace':
      return { ...reply, trace: event.data };
  }
}

export function conversationReducer(
  state: Conversation,
  action: ConversationAction,
): Conversation {
  switch (action.type) {
    case 'send':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.userId, role: 'user', text: action.text },
          {
            id: action.assistantId,
            role: 'assistant',
            text: '',
            status: 'streaming',
            tools: [],
          },
        ],
      };
    case 'event': {
      const next = updateReply(state, action.assistantId, (reply) =>
        applyEvent(reply, action.event),
      );
      return action.event.type === 'final'
        ? { ...next, threadId: action.event.data.threadId }
        : next;
    }
    case 'end':
      return updateReply(state, action.assistantId, (reply) =>
        reply.status === 'streaming' ? { ...reply, status: 'interrupted' } : reply,
      );
    case 'fail':
      return updateReply(state, action.assistantId, (reply) => ({
        ...reply,
        status: 'failed',
        error: action.message,
      }));
    case 'reset':
      return emptyConversation;
  }
}
