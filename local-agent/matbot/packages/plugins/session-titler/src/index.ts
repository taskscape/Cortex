import { PLUGIN_API_VERSION, singleTurnRequest } from '@matatbread/matbot-plugin-api';
import type { MatbotPluginSpec, MatbotMachine, Message, MessageContent, ModelParameters } from '@matatbread/matbot-plugin-api';

const CREATOR = 'session-titler';
const PROVIDER_KEY = 'titlerProvider';
// Overridden per call rather than through a dedicated provider profile: `providers` is the user's list
// of selectable chat models, so an entry existing only for this plugin would have to be hidden from the
// picker to stay out of the way. Temperature 0 is the other half of the anti-drift fix — a 3-6 word
// generation is short enough that sampling noise shows up as a title in the wrong language.
const TITLE_PARAMS: Partial<ModelParameters> = { temperature: 0, maxTokens: 64 };
// Budgeted per part rather than as one slice over the joined prompt: an expert-panel answer runs to
// tens of thousands of characters and would otherwise crowd the opening request out entirely — and the
// opening request is what fixes both the topic and the title's language. The reply only has to break
// ties when the request is terse, so it gets the smaller share.
const REQUEST_BUDGET = 1000;
const REPLY_BUDGET = 500;

/**
 * Clips text to a character budget, appending an ellipsis when truncated.
 * Used to bound the prompt/reply shares sent to the titler model.
 * @param text - Text to clip.
 * @param budget - Maximum characters kept (plus the ellipsis when truncated).
 * @returns The original text, or its clipped prefix with a trailing ellipsis.
 * @throws Never.
 */
function clip(text: string, budget: number): string {
  return text.length > budget ? `${text.slice(0, budget)}…` : text;
}

// The language rule leads, is stated concretely, and is restated last. Buried in a rule list it was
// ignored often enough to produce titles in a language appearing nowhere in the input (an English
// request titled in Spanish) — short generations have no long text to anchor the language.
const SYSTEM = [
  'You write a short title for a conversation.',
  '',
  'LANGUAGE — this matters most: write the title in the SAME language as the OPENING REQUEST.',
  'An English request gets an English title. A Polish request gets a Polish title. Never translate',
  'the topic into another language, and never use a language absent from the request.',
  '',
  'CONTENT: 3-6 words naming what the conversation is ABOUT. Describe the topic instead of repeating',
  'the wording. No quotes, no trailing period, no "Conversation about" prefix.',
  '',
  'Output the title only, in the language of the opening request.',
].join('\n');

/**
 * Arguments for {@link SessionTitler.titleSession}: which session to title,
 * the fallback provider, and an optional abort signal.
 */
export interface TitleSessionInput {
  sessionId: string;
  /** Provider to title with when no `titlerProvider` setting is pinned. */
  provider:  string;
  signal?:   AbortSignal;
}

/**
 * Service that writes a model-generated descriptive title to a session,
 * at most once per session. Registered under the `SessionTitler` service key
 * by the session-titler plugin.
 */
export interface SessionTitler {
  /**
   * Give a session a model-written descriptive title, at most once per session. Resolves to the title
   * written, or undefined when the session was already titled, had nothing to summarise, the candidate
   * was rejected, or the write lost a race.
   *
   * @param input - Session id, fallback provider, and optional abort signal;
   *   a pinned `titlerProvider` setting overrides the fallback provider.
   * @returns The written title, or `undefined` when nothing was written
   *   (already titled, missing session/prompt, rejected candidate, lost CAS race).
   * @throws Error - If the completion call fails or the titler state store
   *   write fails.
   */
  titleSession(input: TitleSessionInput): Promise<string | undefined>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    /** Optional service writing one-time descriptive titles to sessions. */
    SessionTitler?: SessionTitler;
  }
}

/**
 * One idempotency record in the plugin's `session_titler_state` store,
 * recording that a session was already titled, with which provider, and when.
 */
interface TitledRecord {
  id:       string;
  version:  string;
  title:    string;
  provider: string;
  titledAt: string;
}

/**
 * Concatenates the text parts of a message content list into one string.
 * @param content - Message content parts; non-text parts are skipped.
 * @returns The joined, trimmed text (empty when there is none).
 * @throws Never.
 */
function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join(' ')
    .trim();
}

/**
 * Returns the text of the first message with the given role.
 * @param messages - Session messages, scanned in order.
 * @param role - Role to match (e.g. the opening `user` request).
 * @returns The matched message's text, or `''` when no such message exists.
 * @throws Never.
 */
function firstTextOfRole(messages: readonly Message[], role: Message['role']): string {
  for (const m of messages) if (m.role === role) return textOf(m.content);
  return '';
}

/**
 * Returns the text of the last message with the given role.
 * @param messages - Session messages, scanned from the end.
 * @param role - Role to match (e.g. the latest `assistant` reply).
 * @returns The matched message's text, or `''` when no such message exists.
 * @throws Never.
 */
function lastTextOfRole(messages: readonly Message[], role: Message['role']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === role) return textOf(m.content);
  }
  return '';
}

/**
 * Normalizes text for prompt-echo detection: lowercased, whitespace collapsed
 * to single spaces, trimmed.
 * @param s - Text to normalize.
 * @returns The normalized text.
 * @throws Never.
 */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// The model's failure mode here is echoing the prompt back, which is exactly what the deterministic
// truncation already does — so a label that merely prefixes the prompt is rejected in favour of it.
/**
 * Cleans a raw model answer into a title candidate: the first line, stripped
 * of surrounding quotes/backticks/punctuation, collapsed whitespace, at most
 * 60 characters. Candidates that merely echo the opening prompt (case- and
 * whitespace-insensitive prefix match) are rejected.
 *
 * @param raw - Raw completion text from the titler model.
 * @param prompt - The opening request text, used for the echo check.
 * @returns The cleaned title, or `undefined` when the candidate is empty,
 *   too long, or a prompt echo.
 * @throws Never.
 */
function sanitize(raw: string, prompt: string): string | undefined {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  const cleaned = firstLine.replace(/^["'`\s]+/, '').replace(/["'`\s.!?]+$/, '').replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 60) return undefined;
  if (norm(prompt).startsWith(norm(cleaned))) return undefined;
  return cleaned;
}

/**
 * Factory for the {@link SessionTitler} service implementation.
 *
 * Idempotency lives in the plugin's own `session_titler_state` store (not in
 * a session marker, which the pump would clobber). A title run: skips already
 * titled sessions, reads the session's opening user request and latest
 * assistant reply (clipped to per-part budgets), resolves the provider from
 * the `titlerProvider` setting (falling back to the supplied provider), asks
 * the model for a 3–6 word title at temperature 0, sanitizes the candidate,
 * and writes it via a compare-and-swap on the session document before
 * recording the titled state.
 *
 * @param services - Machine services: session store, settings, provider
 *   registry, completion, and the titler state store.
 * @returns The service implementing {@link SessionTitler}.
 */
function makeSessionTitler(services: MatbotMachine): SessionTitler {
  // Idempotency lives in this plugin's own store, not in a session marker: returning markers from a
  // followup hook makes the pump re-`set` the session from the snapshot it read *before* the hook ran
  // (session-runner: "the pump is the sole writer post-commit"), which would clobber the title.
  const titled = services.createStore<TitledRecord>('session_titler_state');

  return {
    async titleSession({ sessionId, provider: fallbackProvider, signal }) {
      if (await titled.get(sessionId)) return undefined;

      const store = services.sessions;
      if (!store) return undefined;
      const session = await store.get(sessionId);
      if (!session) return undefined;

      const prompt = firstTextOfRole(session.messages, 'user');
      if (!prompt) return undefined;
      const answer = lastTextOfRole(session.messages, 'assistant');

      const configured = await services.settings().get<string>(PROVIDER_KEY);
      const provider = configured && services.providers.has(configured) ? configured : fallbackProvider;

      const res = await services.complete({
        ...singleTurnRequest({
          provider,
          system: SYSTEM,
          prompt: `Opening request:\n${clip(prompt, REQUEST_BUDGET)}\n\nReply:\n${clip(answer, REPLY_BUDGET)}`,
          ...(signal !== undefined ? { signal } : {}),
        }),
        parameters: TITLE_PARAMS,
      });

      const title = sanitize(res.text, prompt);
      if (!title) {
        console.warn(`[${CREATOR}] rejected candidate for session=${sessionId}: ${JSON.stringify(res.text.slice(0, 120))}`);
        return undefined;
      }

      const written = await store.cas(session.id, session.version, {
        ...session,
        title,
        updatedAt: new Date().toISOString(),
        version: crypto.randomUUID(),
      });
      if (!written.ok) return undefined;

      await titled.set(sessionId, {
        id:       sessionId,
        version:  crypto.randomUUID(),
        title,
        provider,
        titledAt: new Date().toISOString(),
      });
      console.warn(`[${CREATOR}] session=${sessionId} provider=${provider} title=${JSON.stringify(title)}`);
      return title;
    },
  };
}

/**
 * Plugin registering the {@link SessionTitler} service and a `followup` hook
 * that titles each committed session once.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const titler = makeSessionTitler(services);
    // Registered as a service because not every path that commits a turn runs hooks: the expert-panel
    // submit writes messages straight to the store, bypassing the pump, so it calls this directly.
    await services.register('SessionTitler', titler);

    /**
     * `followup` hook: titles the just-committed session once. Resubmitted
     * turns (depth > 0) are skipped so re-runs do not retitle. Failures of
     * {@link SessionTitler.titleSession} are isolated by the hook dispatcher.
     */
    services.hooks.register({
      on: 'followup',
      async handler(ctx) {
        if (ctx.resubmitDepth > 0) return;
        await titler.titleSession({
          sessionId: ctx.session.id,
          provider:  ctx.config.provider,
          signal:    ctx.signal,
        });
      },
    });
  },
};
