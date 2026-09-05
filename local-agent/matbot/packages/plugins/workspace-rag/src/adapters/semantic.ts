import type { MatbotMachine } from '@matatbread/matbot-plugin-api';
import type { RagV2SemanticServices } from '../v2/semantic.js';
export function createSemanticServices(services: MatbotMachine): RagV2SemanticServices {
    const summaryProvider = process.env['CORTEX_RAG_V2_SUMMARY_PROVIDER']?.trim();
    const summaryModel = summaryProvider ? services.providers.get(summaryProvider)?.model : undefined;
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
