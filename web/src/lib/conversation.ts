import type { SseMessage } from './sse';

/** Mirrors the gateway's `trace` SSE event: metadata about one reply, never message text. */
export interface TraceSummary {
  id: string;
  route: string | null;
  tools: string[];
  provider: string | null;
  model: string | null;
  failovers: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
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

/** Set on a refund-route `final` when a request was stored or an open one reused. */
export interface RefundSummary {
  id: string;
  status: 'pending_approval' | 'auto_rejected';
}

/** The gateway's chat events, as far as the console uses them. */
export type ChatEvent =
  | { type: 'token'; data: { text: string } }
  | { type: 'tool_call'; data: { name: string; args: Record<string, unknown> } }
  | { type: 'approval_required'; data: ApprovalNotice }
  | {
      type: 'final';
      data: {
        answer: string;
        route: string;
        threadId: string;
        refund?: RefundSummary;
      };
    }
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
  refund?: RefundSummary;
  error?: string;
  trace?: TraceSummary;
}

/** An operator's decision on a watched refund request, shown after it is made. */
export interface OperatorUpdate {
  id: string;
  role: 'operator';
  refundId: string;
  text: string;
}

export type Message = UserMessage | AssistantMessage | OperatorUpdate;

export interface Conversation {
  threadId?: string;
  messages: Message[];
  /** Refund requests from this conversation still waiting for an operator. */
  watching: string[];
}

export type ConversationAction =
  | { type: 'send'; userId: string; assistantId: string; text: string }
  | { type: 'event'; assistantId: string; event: ChatEvent }
  /** The stream closed or was aborted; a reply still streaming was cut off. */
  | { type: 'end'; assistantId: string }
  /** The request failed before or instead of a stream (network, 4xx, 5xx). */
  | { type: 'fail'; assistantId: string; message: string }
  /** An operator decided a watched request; `text` is the gateway's fixed decision text. */
  | { type: 'refund_decided'; refundId: string; updateId: string; text: string }
  /** The gateway no longer knows the request (404); stop watching it quietly. */
  | { type: 'refund_unwatched'; refundId: string }
  | { type: 'reset' };

export const emptyConversation: Conversation = { messages: [], watching: [] };

function updateReply(
  state: Conversation,
  id: string,
  update: (reply: AssistantMessage) => AssistantMessage,
): Conversation {
  return {
    ...state,
    messages: state.messages.map((message) =>
      message.role === 'assistant' && message.id === id
        ? update(message)
        : message,
    ),
  };
}

function applyEvent(
  reply: AssistantMessage,
  event: ChatEvent,
): AssistantMessage {
  switch (event.type) {
    case 'token':
      return { ...reply, text: reply.text + event.data.text };
    case 'tool_call':
      return { ...reply, tools: [...reply.tools, event.data.name] };
    case 'approval_required':
      return { ...reply, approval: event.data };
    case 'final':
      return {
        ...reply,
        text: event.data.answer,
        status: 'done',
        refund: event.data.refund,
      };
    case 'error':
      return { ...reply, status: 'failed', error: event.data.message };
    case 'trace':
      return { ...reply, trace: event.data };
  }
}

/** The refund request an event leaves waiting for an operator, if any. */
function pendingRefundOf(event: ChatEvent): string | null {
  if (event.type === 'approval_required') return event.data.refundId;
  if (
    event.type === 'final' &&
    event.data.refund?.status === 'pending_approval'
  )
    return event.data.refund.id;
  return null;
}

function watch(state: Conversation, refundId: string | null): Conversation {
  return refundId && !state.watching.includes(refundId)
    ? { ...state, watching: [...state.watching, refundId] }
    : state;
}

function unwatch(state: Conversation, refundId: string): Conversation {
  return {
    ...state,
    watching: state.watching.filter((id) => id !== refundId),
  };
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
      const next = watch(
        updateReply(state, action.assistantId, (reply) =>
          applyEvent(reply, action.event),
        ),
        pendingRefundOf(action.event),
      );
      return action.event.type === 'final'
        ? { ...next, threadId: action.event.data.threadId }
        : next;
    }
    case 'end':
      return updateReply(state, action.assistantId, (reply) =>
        reply.status === 'streaming'
          ? { ...reply, status: 'interrupted' }
          : reply,
      );
    case 'fail':
      return updateReply(state, action.assistantId, (reply) => ({
        ...reply,
        status: 'failed',
        error: action.message,
      }));
    case 'refund_decided':
      // A late or repeated poll result for a request no longer watched adds nothing.
      if (!state.watching.includes(action.refundId)) return state;
      return unwatch(
        {
          ...state,
          messages: [
            ...state.messages,
            {
              id: action.updateId,
              role: 'operator',
              refundId: action.refundId,
              text: action.text,
            },
          ],
        },
        action.refundId,
      );
    case 'refund_unwatched':
      return unwatch(state, action.refundId);
    case 'reset':
      return emptyConversation;
  }
}
