import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { RagV2SemanticServices } from '../v2/semantic.js';
/**
 * Builds the RAG v2 semantic services (query rewriting and optional document
 * summarization) on top of the machine's provider registry. Summarization is
 * included only when `CORTEX_RAG_V2_SUMMARY_PROVIDER` names a registered
 * provider; the provider used for query rewriting is chosen per call.
 *
 * @param services - Machine whose provider registry and `singleTurn` back the returned services.
 * @returns A {@link RagV2SemanticServices} with `rewriteQuery` and, when a summary provider is configured, `summarizerSignature` plus `summarize`.
 * @throws Never.
 */
export function createSemanticServices(services: MatbotMachine): RagV2SemanticServices {
    const summaryProvider = process.env['CORTEX_RAG_V2_SUMMARY_PROVIDER']?.trim();
    const summaryModel = summaryProvider ? services.providers.get(summaryProvider)?.model : undefined;
    /**
     * Extracts a named string field from a raw LLM response.
     *
     * Tries the first JSON object embedded in the text; if it cannot be parsed
     * or lacks the key, falls back to the whole text with code fences stripped.
     *
     * @param text - Raw model response text.
     * @param key - JSON field to read, e.g. "standaloneQuery" or "summary".
     * @returns The trimmed field value, else the fence-stripped trimmed text, else undefined when both are empty.
     * @throws Never; JSON parse failures are swallowed by design.
     */
    const parseJsonString = (text: string, key: string): string | undefined => {
        const match = /\{[\s\S]*\}/u.exec(text);
        if (match) {
            try {
                const parsed = JSON.parse(match[0]) as Record<string, unknown>;
                if (typeof parsed[key] === 'string' && parsed[key].trim())
                    return parsed[key].trim();
            }
            catch {
                // Fall through to a bounded plain-text response.
            }
        }
        const value = text.replace(/^```(?:json)?|```$/gimu, '').trim();
        return value || undefined;
    };
    return {
        /**
         * Rewrites a conversational follow-up as one standalone retrieval query
         * with a single LLM turn. Returns undefined instead of throwing when
         * the provider is missing or the response cannot be parsed.
         *
         * @param input - `provider` names a registered provider (absent or unknown short-circuits to undefined), `compactConversation` is the bounded recent transcript used to resolve references, `latestQuestion` is the follow-up to rewrite, and `signal` aborts the call.
         * @returns The standalone query extracted from the JSON response, or undefined when no provider is available or the output cannot be parsed.
         * @throws {Error} When the provider request fails or is aborted.
         */
        rewriteQuery: async (input) => {
            if (!input.provider || !services.providers.has(input.provider))
                return undefined;
            const result = await services.singleTurn({
                provider: input.provider,
                system: [
                    'Rewrite a conversational follow-up as one standalone knowledge-retrieval query.',
                    'Resolve pronouns, ellipsis, relative versions, people, and dates only from the supplied conversation.',
                    'Preserve exact identifiers and quoted strings. Do not answer the question.',
                    'Return JSON only: {"standaloneQuery":"..."}.',
                ].join(' '),
                prompt: `Conversation:\n${input.compactConversation}\n\nLatest question:\n${input.latestQuestion}`,
                ...(input.signal ? { signal: input.signal } : {}),
            });
            return parseJsonString(result.text, 'standaloneQuery');
        },
        ...(summaryProvider && services.providers.has(summaryProvider) ? {
            summarizerSignature: `${summaryProvider}:${summaryModel ?? 'unknown'}:rag-routing-summary-v1`,
            /**
             * Produces a concise routing summary of one indexed unit via the
             * configured summary provider; source text is capped at 12000
             * characters before the request.
             *
             * @param input - Level, title, breadcrumb, and source text of the unit to summarize.
             * @param signal - Optional abort signal for the provider call.
             * @returns The summary extracted from the JSON response, or undefined when the output cannot be parsed.
             * @throws {Error} When the provider request fails or is aborted.
             */
            summarize: async (input, signal) => {
                const result = await services.singleTurn({
                    provider: summaryProvider,
                    system: [
                        'Create a concise semantic routing summary for retrieval.',
                        'Include distinctive topics, entities, terminology, version cues, and relationships.',
                        'Do not invent facts. The output is a routing derivative and will never be cited as evidence.',
                        'Use at most 180 words. Return JSON only: {"summary":"..."}.',
                    ].join(' '),
                    prompt: [
                        `Level: ${input.level}`,
                        `Title: ${input.title}`,
                        `Breadcrumb: ${input.breadcrumb.join(' > ')}`,
                        `Source material:\n${input.text.slice(0, 12000)}`,
                    ].join('\n\n'),
                    ...(signal ? { signal } : {}),
                });
                return parseJsonString(result.text, 'summary');
            },
        } : {}),
    };
}
