import type {
  MatbotPluginSpec, MatbotMachine, Tool, ToolEvent, Session, Store, Message, Marker,
} from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const MARKER_CREATOR = '@matatbread/matbot-edit-session';

// This plugin's marker payload, made type-safe by augmenting the shared MarkerData registry.
// Any reader narrowing on creator === MARKER_CREATOR gets the typed `data` for free.
declare module '@matatbread/matbot-plugin-api' {
  interface MarkerData {
    '@matatbread/matbot-edit-session': {
      /** 'split-from': earlier messages were split into peerSessionId (navigate back).
       *  'continued-in': this conversation continued in peerSessionId (navigate forward).
       *  'forked-from': this session was forked from peerSessionId (navigate to the origin). */
      relation:      'split-from' | 'continued-in' | 'forked-from';
      peerSessionId: string;
      /** Message index in peerSessionId to scroll to. Baked at edit time, so it's fragile to later
       *  inserts/removes in the peer — best-effort; the UI scrolls there only if it still resolves. */
      targetMsg:     number;
    };
  }
}

/** Typed payload of this plugin's marker messages, via the `MarkerData` augmentation above. */
type EditSessionMarkerData = Marker<typeof MARKER_CREATOR>['data'];

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Current wall-clock time as an ISO-8601 UTC timestamp.
 *
 * @returns ISO timestamp string, e.g. `2026-01-01T12:34:56.789Z`.
 * @throws Never.
 */
function now(): string { return new Date().toISOString(); }

/**
 * A standalone marker message: opaque to the LLM (the 'marker' role is skipped by every provider
 * converter), preserved by compaction, carried with the session for the UI to render as a
 * cross-thread link.
 *
 * @param data - Typed marker payload naming the peer session and the message to scroll to.
 * @returns A marker-role {@link Message} with fresh id and trace id.
 * @throws Never.
 */
function markerMessage(data: EditSessionMarkerData): Message {
  const marker: Marker<typeof MARKER_CREATOR> = { type: 'marker', creator: MARKER_CREATOR, data };
  return {
    id:        crypto.randomUUID(),
    role:      'marker',
    content:   [marker],
    createdAt: now(),
    traceId:   crypto.randomUUID(),
  };
}

/**
 * Copies a store document with a fresh random version token, so a subsequent compare-and-swap
 * write against the new version succeeds and stale concurrent writers fail.
 *
 * @typeParam T - Document shape carrying the required `version` token.
 * @param doc - Document to re-version; not mutated.
 * @returns A shallow copy of `doc` with `version` set to a fresh UUID.
 * @throws Never.
 */
function bumpVersion<T extends { version: string }>(doc: T): T {
  return { ...doc, version: crypto.randomUUID() };
}

/**
 * Resolve msgIndex (raw index into session.messages) to the actual index.
 * The frontend passes the original message index from the full messages array.
 *
 * @param session - Session whose message array bounds the index.
 * @param msgIndex - Zero-based index into `session.messages` as passed by the frontend.
 * @returns `msgIndex` unchanged when in bounds; `null` when negative or past the end.
 * @throws Never.
 */
function resolveIndex(session: Session, msgIndex: number): number | null {
  if (msgIndex < 0 || msgIndex >= session.messages.length) return null;
  return msgIndex;
}

/**
 * Derives the title for the current session after a split by bumping a trailing split counter: a
 * title ending in " pt N" becomes " pt N+1"; any other title gets " pt 2" appended.
 *
 * @param title - Current session title; may be empty.
 * @returns The bumped title — an empty title yields "Untitled pt 2".
 * @throws Never.
 */
function generateSplitTitle(title: string): string {
  // If title ends with " pt N", bump the number
  const match = title.match(/^(.*?)\s*pt\s+(\d+)$/);
  if (match && match.length > 2) {
    return `${match[1]?.trimEnd()} pt ${parseInt(match[2] ?? '0') + 1}`;
  }
  // Otherwise append " pt 2"
  return `${title || 'Untitled'} pt 2`;
}

const KEEP_TYPES = new Set(['text', 'refusal', 'marker']);

// ── tool ──────────────────────────────────────────────────────────────────────

/**
 * Executor-level input contract for `session_edit`: the four actions share this shape ({ sessionId,
 * msgIndex }) and differ only in behaviour. Loose by design — the executor validates per action.
 */
interface SessionEditInput { action: string; sessionId: string; msgIndex: number }

/**
 * All four actions share the same parameter shape ({ sessionId, msgIndex }); only the behaviour
 * differs. The schema stays loose (action enum + the shared fields) and the description carries
 * this TypeScript signature, which the executor enforces.
 *
 * Every write goes through compare-and-swap against the store; on CAS failure (or any other
 * rejection) the tool yields an `error` tool event — and for `split` deletes the peer session it
 * just created — rather than throwing.
 *
 * @param store - Session store backing all reads, CAS writes and deletes.
 * @returns The `session_edit` tool definition.
 * @throws Never.
 */
function makeSessionEditTool(store: Store<Session>): Tool {
  return {
    name: 'session_edit',
    description:
      'Edit the message history of a session (see `session_action` for what a session is). Every ' +
      'action takes a session ID and a message index (`msgIndex`, an index into session.messages) ' +
      'and uses it to manage the conversation\'s length and structure:\n' +
      '  cut     — Truncate: remove all messages from msgIndex onward.\n' +
      '  fork    — Branch: create a NEW session with messages[0..msgIndex-1]; the original is unchanged.\n' +
      '  split   — Move: messages before msgIndex move to a new session; the current session keeps\n' +
      '            msgIndex onward. Both sides get cross-link markers.\n' +
      '  compact — Shrink: strip thinking blocks, tool calls, and tool results from messages before\n' +
      '            msgIndex, keeping user/assistant text — fewer tokens, same thread.\n\n' +
      '```ts\n' +
      "type SessionEdit = { action: 'cut' | 'fork' | 'split' | 'compact'; sessionId: string; msgIndex: number };\n" +
      '```',
    inputSchema: {
      type:       'object',
      required:   ['action', 'sessionId', 'msgIndex'],
      properties: {
        action:    { type: 'string', enum: ['cut', 'fork', 'split', 'compact'], description: 'The edit to perform.' },
        sessionId: { type: 'string', description: 'ID of the session to edit.' },
        msgIndex:  { type: 'number', description: 'Index into session.messages the action pivots on (see per-action meaning in the description).' },
      },
    },
    executor: {
      async *execute(input: unknown): AsyncIterable<ToolEvent> {
        const { action, sessionId, msgIndex } = input as Partial<SessionEditInput>;
        if (!sessionId) { yield { type: 'error', message: 'session_edit requires "sessionId".' }; return; }
        if (typeof msgIndex !== 'number') { yield { type: 'error', message: 'session_edit requires "msgIndex" (number).' }; return; }

        const session = await store.get(sessionId);
        if (!session) { yield { type: 'error', message: `Session "${sessionId}" not found.` }; return; }
        const idx = resolveIndex(session, msgIndex);
        if (idx === null) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range.` }; return; }

        switch (action) {
          case 'cut': {
            const next: Session = bumpVersion({
              ...session,
              messages:  session.messages.slice(0, idx),
              updatedAt: now(),
            });
            const res = await store.cas(sessionId, session.version, next);
            if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
            yield { type: 'result', value: { sessionId, messagesRemaining: next.messages.length } };
            return;
          }

          case 'fork': {
            // One-way: only the fork is marked (pointing back to its origin). The original is left
            // unchanged, per this action's contract.
            const forked: Session = {
              ...bumpVersion(session),
              id:               crypto.randomUUID(),
              parentSessionId:  sessionId,
              // targetMsg idx-1: the fork point in the (unchanged) parent — its last message shared
              // with this fork.
              messages:         [...session.messages.slice(0, idx), markerMessage({ relation: 'forked-from', peerSessionId: sessionId, targetMsg: Math.max(0, idx - 1) })],
              createdAt:        now(),
              updatedAt:        now(),
            };
            await store.set(forked.id, forked);
            yield { type: 'result', value: { newSessionId: forked.id, messagesCopied: idx } };
            return;
          }

          case 'split': {
            if (idx === 0) { yield { type: 'error', message: 'Cannot split at index 0 — nothing to split off.' }; return; }

            // Messages before the split point go to the new session
            const prefixMsgs = session.messages.slice(0, idx);
            // Messages from the split point onward stay in the current session
            const suffixMsgs = session.messages.slice(idx);

            const newSessionId = crypto.randomUUID();

            // New session: prefix messages, tailed by a marker pointing forward to the continuing
            // (current) session.
            const newSession: Session = {
              ...bumpVersion(session),
              id:               newSessionId,
              parentSessionId:  sessionId,
              // targetMsg 1: in the current session the prepended split-from marker is index 0, so the
              // continuation (first suffix message) lands at index 1.
              messages:         [...prefixMsgs, markerMessage({ relation: 'continued-in', peerSessionId: sessionId, targetMsg: 1 })],
              createdAt:        now(),
              updatedAt:        now(),
            };
            await store.set(newSession.id, newSession);

            // Current session: keep only suffix messages, headed by a marker pointing back to where
            // the earlier messages now live.
            const updated: Session = bumpVersion({
              ...session,
              title:     generateSplitTitle(session.title ?? ''),
              // targetMsg idx-1: the last earlier message in the new session.
              messages:  [markerMessage({ relation: 'split-from', peerSessionId: newSessionId, targetMsg: idx - 1 }), ...suffixMsgs],
              updatedAt: now(),
            });
            const res = await store.cas(sessionId, session.version, updated);
            if (!res.ok) {
              // CAS failed — clean up the new session we just created
              await store.delete(newSession.id);
              yield { type: 'error', message: 'Concurrent modification — please retry.' };
              return;
            }

            yield {
              type: 'result',
              value: {
                newSessionId:      newSession.id,
                messagesSplit:     prefixMsgs.length,
                currentSessionId:  sessionId,
                messagesRemaining: suffixMsgs.length,
              },
            };
            return;
          }

          case 'compact': {
            if (idx === 0) { yield { type: 'error', message: `msgIndex ${msgIndex} out of range or nothing to compact.` }; return; }
            let stripped = 0;
            const messages = session.messages.map((m, i) => {
              if (i >= idx) return m;
              const compact = m.content.filter(c => KEEP_TYPES.has(c.type));
              if (compact.length === m.content.length) return m;
              stripped++;
              return { ...m, content: compact };
            });
            const next: Session = bumpVersion({ ...session, messages, updatedAt: now() });
            const res = await store.cas(sessionId, session.version, next);
            if (!res.ok) { yield { type: 'error', message: 'Concurrent modification — please retry.' }; return; }
            yield { type: 'result', value: { sessionId, messagesStripped: stripped } };
            return;
          }

          default:
            yield { type: 'error', message: `Unknown action "${String(action)}". Expected one of: cut, fork, split, compact.` };
        }
      },
    },
  };
}

// ── plugin ────────────────────────────────────────────────────────────────────

/**
 * Plugin exporting the `session_edit` tool (cut/fork/split/compact operations
 * on a session's message history, backed by the sessions store).
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  /**
   * Registers the `session_edit` tool against the runtime's session store.
   *
   * @param services - Runtime machine; a no-op when no sessions store is present.
   * @returns A promise that resolves once registration is done.
   * @throws Never.
   */
  async setup(services: MatbotMachine) {
    const store = services.sessions;
    if (!store) return;
    services.tools.register(makeSessionEditTool(store));
  },
};
