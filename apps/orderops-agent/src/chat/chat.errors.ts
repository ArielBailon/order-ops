import type { ChatErrorCode } from './chat.schemas.js';

export class ChatAgentError extends Error {
  constructor(readonly code: ChatErrorCode) {
    super(code);
    this.name = 'ChatAgentError';
  }
}
