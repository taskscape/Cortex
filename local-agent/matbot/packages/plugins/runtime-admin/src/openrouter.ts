import { createHash } from 'node:crypto';
import type { ProviderConfig, Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';
import {
  checkOpenRouterKey,
  OpenRouterAdapter,
  OpenRouterCatalogService,
  validateOpenRouterConfig,
} from '@matatbread/matbot-provider-openrouter';

type OpenRouterAction =
  | { action: 'models'; refresh?: boolean }
  | { action: 'validate'; profile: string; mode: 'configuration' | 'key' | 'model' | 'inference'; expectedVersion?: string };

function isOpenRouterProfile(config: ProviderConfig): boolean {
  return config.module === '@matatbread/matbot-provider-openrouter' ||
    /(?:^|[\\/])openrouter(?:[\\/]index(?:\.\w+)?)?$/i.test(config.module);
}

async function resolveProfile(config: ProviderConfig, ctx: ToolContext): Promise<ProviderConfig> {
  const credentials = config.credentials === undefined
    ? undefined
    : Object.fromEntries(await Promise.all(Object.entries(config.credentials).map(async ([key, value]) => [key, await ctx.vault.resolve(value)])));
  const endpoint = config.endpoint === undefined ? undefined : await ctx.vault.resolve(config.endpoint);
  return { ...config, ...(credentials !== undefined ? { credentials } : {}), ...(endpoint !== undefined ? { endpoint } : {}) };
}

function safeError(ctx: ToolContext, error: unknown): string {
  return ctx.vault.scrub(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

/**
 * Explicit OpenRouter discovery and readiness actions. Inference is separately permission-gated
 * because it may consume a user's credits; normal adapter health remains a local liveness check.
 */
export function createOpenRouterTool(providers: ReadonlyMap<string, ProviderConfig>): Tool {
  const catalog = new OpenRouterCatalogService();
  // A credential reference plus an in-memory digest detects rotation at the same reference without
  // retaining or exposing the resolved key. The plugin instance is workspace-scoped.
  const keyChecks = new Map<string, { expiresAt: number; result: Awaited<ReturnType<typeof checkOpenRouterKey>> }>();
  return {
    name: 'openrouter',
    description: 'Inspect the public OpenRouter model catalog or explicitly validate one configured OpenRouter profile. Key and model validation do not imply inference; inference is a small, credit-consuming user-approved check.',
    serial: true,
    permission: { action: 'openrouter-diagnostics', patterns: input => [(input as OpenRouterAction)?.action === 'validate' && (input as OpenRouterAction & { mode?: string }).mode === 'inference' ? 'inference' : 'read'] },
    inputSchema: {
      type: 'object', required: ['action'], properties: {
        action: { type: 'string', enum: ['models', 'validate'] },
        refresh: { type: 'boolean' },
        profile: { type: 'string' },
        mode: { type: 'string', enum: ['configuration', 'key', 'model', 'inference'] },
        expectedVersion: { type: 'string' },
      },
    },
    executor: {
      async *execute(raw: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
        const input = raw as OpenRouterAction;
        if (input.action === 'models') {
          try {
            const snapshot = await catalog.get(input.refresh === true);
            yield { type: 'result', value: { fetchedAt: snapshot.fetchedAt, stale: snapshot.stale, models: snapshot.models } };
          } catch (error) {
            yield { type: 'error', message: safeError(ctx, error) };
          }
          return;
        }
        if (input.action !== 'validate' || !input.profile || !input.mode) {
          yield { type: 'error', message: 'Specify action "models" or a profile and validation mode.' };
          return;
        }
        const rawProfile = providers.get(input.profile);
        if (rawProfile === undefined || !isOpenRouterProfile(rawProfile)) {
          yield { type: 'error', message: `No OpenRouter profile named "${input.profile}" is configured.` };
          return;
        }
        let profile: ProviderConfig;
        try {
          profile = await resolveProfile(rawProfile, ctx);
          const validated = validateOpenRouterConfig(profile);
          if (input.mode === 'configuration') {
            yield { type: 'result', value: { ok: true, profile: rawProfile.name, model: validated.model, endpoint: validated.apiOrigin, mode: input.mode } };
            return;
          }
          if (input.mode === 'key') {
            const keyReference = rawProfile.credentials?.['apiKey'] ?? rawProfile.name;
            const keyRevision = createHash('sha256').update(validated.apiKey).digest('hex');
            const cacheKey = `${keyReference}\u0000${keyRevision}`;
            const cached = keyChecks.get(cacheKey);
            const resolvedResult = cached !== undefined && cached.expiresAt > Date.now()
              ? cached.result
              : await checkOpenRouterKey(validated.apiKey);
            const result = resolvedResult.error === undefined
              ? resolvedResult
              : { ...resolvedResult, error: ctx.vault.scrub(resolvedResult.error) };
            if (cached === undefined || cached.expiresAt <= Date.now()) {
              keyChecks.set(cacheKey, { expiresAt: Date.now() + 60_000, result });
            }
            yield { type: 'result', value: { ...result, profile: rawProfile.name, mode: input.mode } };
            return;
          }
          if (input.mode === 'model') {
            const snapshot = await catalog.get(false);
            const model = snapshot.models.find(candidate => candidate.id === validated.model);
            yield {
              type: 'result', value: {
                ok: true, profile: rawProfile.name, model: validated.model, mode: input.mode,
                catalog: model === undefined ? 'unknown-manual-id' : { ...model, stale: snapshot.stale, fetchedAt: snapshot.fetchedAt },
                configuredCapabilities: validated.capabilities,
              },
            };
            return;
          }
          const adapter = new OpenRouterAdapter();
          let done = false;
          let usage: Record<string, unknown> | undefined;
          let completion: Record<string, unknown> | undefined;
          for await (const event of adapter.complete([
            { id: 'openrouter-diagnostic', role: 'user', content: [{ type: 'text', text: 'Reply with ok.' }], createdAt: new Date().toISOString(), traceId: ctx.traceId ?? 'openrouter-diagnostic' },
          ], { ...profile, parameters: { ...(profile.parameters ?? {}), maxOutputTokens: 16 } }, [], ctx.signal)) {
            if (event.type === 'done') done = true;
            if (event.type === 'usage') usage = event;
            if (event.type === 'completion-metadata') {
              const { type: _type, ...metadata } = event;
              completion = metadata;
            }
          }
          yield { type: 'result', value: { ok: done, profile: rawProfile.name, model: validated.model, mode: input.mode, consumesCredits: true, ...(usage !== undefined ? { usage } : {}), ...(completion !== undefined ? { completion } : {}) } };
        } catch (error) {
          yield { type: 'error', message: safeError(ctx, error) };
        }
      },
    },
  };
}
