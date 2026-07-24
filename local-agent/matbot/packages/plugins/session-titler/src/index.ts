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

export interface TitleSessionInput {
  sessionId: string;
  /** Provider to title with when no `titlerProvider` setting is pinned. */
  provider:  string;
  signal?:   AbortSignal;
}

export interface SessionTitler {
  /**
   * Give a session a model-written descriptive title, at most once per session. Resolves to the title
   * written, or undefined when the session was already titled, had nothing to summarise, the candidate
   * was rejected, or the write lost a race.
   */
  titleSession(input: TitleSessionInput): Promise<string | undefined>;
}

declare module '@matatbread/matbot-plugin-api' {
  interface MatbotServices {
    SessionTitler?: SessionTitler;
  }
}

interface TitledRecord {
  id:       string;
  version:  string;
  title:    string;
  provider: string;
  titledAt: string;
}

function textOf(content: readonly MessageContent[]): string {
  return content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map(c => c.text)
    .join(' ')
    .trim();
}

function firstTextOfRole(messages: readonly Message[], role: Message['role']): string {
  for (const m of messages) if (m.role === role) return textOf(m.content);
  return '';
}

function lastTextOfRole(messages: readonly Message[], role: Message['role']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === role) return textOf(m.content);
  }
  return '';
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// The model's failure mode here is echoing the prompt back, which is exactly what the deterministic
// truncation already does — so a label that merely prefixes the prompt is rejected in favour of it.
function sanitize(raw: string, prompt: string): string | undefined {
  const firstLine = raw.trim().split('\n')[0] ?? '';
  const cleaned = firstLine.replace(/^["'`\s]+/, '').replace(/["'`\s.!?]+$/, '').replace(/\s+/g, ' ');
  if (!cleaned || cleaned.length > 60) return undefined;
  if (norm(prompt).startsWith(norm(cleaned))) return undefined;
  return cleaned;
}

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

export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,

  async setup(services) {
    const titler = makeSessionTitler(services);
    // Registered as a service because not every path that commits a turn runs hooks: the expert-panel
    // submit writes messages straight to the store, bypassing the pump, so it calls this directly.
    await services.register('SessionTitler', titler);

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
