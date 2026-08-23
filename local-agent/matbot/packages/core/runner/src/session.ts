import type { Session, Message, MessageContent, MessageRole, Principal } from './types.js';

/** Options for creating a new session. */
export interface CreateSessionOpts {
  /** Principal that owns the session. */
  ownerPrincipal:        Principal;
  /** Principal acting within the session, when different from the owner. */
  actorPrincipal?:       Principal;
  /** Persona label applied to the session. */
  persona?:              string;
  /** Human-readable title. */
  title?:                string;
  /** Context tags; defaults to empty. */
  contexts?:             string[];
  /** Parent session when this one is a branch/fork. */
  parentSessionId?:      string;
  /** Message in the parent at which the branch occurred. */
  branchPointMessageId?: string;
}

/**
 * Create a new empty active session with fresh ids and timestamps.
 *
 * @param opts - Ownership, persona/title, and branching provenance.
 * @returns The constructed session.
 */
export function createSession(opts: CreateSessionOpts): Session {
  const now = new Date().toISOString();
  return {
    id:               crypto.randomUUID(),
    version:          crypto.randomUUID(),
    ownerPrincipalId: opts.ownerPrincipal.id,
    ...(opts.actorPrincipal && opts.actorPrincipal.id !== opts.ownerPrincipal.id
      ? { actorPrincipalId: opts.actorPrincipal.id }
      : {}),
    ...(opts.persona              !== undefined ? { persona:              opts.persona              } : {}),
    ...(opts.title                !== undefined ? { title:                opts.title                } : {}),
    ...(opts.parentSessionId      !== undefined ? { parentSessionId:      opts.parentSessionId      } : {}),
    ...(opts.branchPointMessageId !== undefined ? { branchPointMessageId: opts.branchPointMessageId } : {}),
    status:    'active',
    contexts:  opts.contexts ?? [],
    messages:  [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Return a copy of the session with one message appended, a bumped timestamp, and a new version.
 *
 * @param session - The session to extend.
 * @param message - The message to append.
 * @returns The updated session copy (the input is never mutated).
 */
export function appendMessage(session: Session, message: Message): Session {
  return {
    ...session,
    messages:  [...session.messages, message],
    updatedAt: new Date().toISOString(),
    version:   crypto.randomUUID(),
  };
}

/**
 * Build one message, stamping fresh id/timestamps.
 *
 * @param opts - Role, content blocks, trace correlation, and optional provider/metadata.
 * @returns The constructed message.
 */
export function createMessage(opts: {
  role:           MessageRole;
  content:        MessageContent[];
  traceId:        string;
  providerName?:  string;
  metadata?:      Record<string, unknown>;
}): Message {
  return {
    id:        crypto.randomUUID(),
    role:      opts.role,
    content:   opts.content,
    createdAt: new Date().toISOString(),
    traceId:   opts.traceId,
    ...(opts.providerName !== undefined ? { providerName: opts.providerName } : {}),
    ...(opts.metadata     !== undefined ? { metadata:     opts.metadata     } : {}),
  };
}
