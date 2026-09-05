import type { FileStore, MessageContent } from '@matatbread/matbot-plugin-api';
const MAX_WORKSPACE_ATTACHMENTS = 20;
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
export async function prepareWorkspaceAttachments(files: FileStore | undefined, rawAttachments: unknown, signal?: AbortSignal): Promise<{
    refs: MessageContent[];
    ephemeral: MessageContent[];
}> {
    if (rawAttachments === undefined)
        return { refs: [], ephemeral: [] };
    if (!Array.isArray(rawAttachments))
        throw new Error('"attachments" must be an array.');
    if (rawAttachments.length > MAX_WORKSPACE_ATTACHMENTS) {
        throw new Error(`A message can attach at most ${MAX_WORKSPACE_ATTACHMENTS} workspace files.`);
    }
    if (rawAttachments.length > 0 && files === undefined) {
        throw new Error('Workspace file attachments are unavailable because no file store is configured.');
    }
    const refs: MessageContent[] = [];
    const paths = new Set<string>();
    for (const raw of rawAttachments) {
        signal?.throwIfAborted();
        if (!isRecord(raw) || raw.namespace !== 'workspace' || typeof raw.path !== 'string') {
            throw new Error('Each attachment must identify a workspace file with { namespace: "workspace", path }.');
        }
        const path = raw.path;
        if (/^[\\/]|^[a-z]:/i.test(path) || path.replace(/\\/g, '/').split('/').some(part => part === '..'))
            throw new Error('Attachment path escapes the workspace.');
        if (!path.trim() || path.length > 1024)
            throw new Error('Attachment paths must contain 1 to 1024 characters.');
        if (paths.has(path))
            continue;
        paths.add(path);
        const handle = await files!.getByName(path, 'workspace');
        signal?.throwIfAborted();
        if (!handle)
            throw new Error(`Workspace attachment not found: ${JSON.stringify(path)}.`);
        refs.push({ type: 'file-ref', fileId: handle.id, name: handle.name, mimeType: handle.mimeType });
    }
    if (refs.length === 0)
        return { refs, ephemeral: [] };
    const calls = refs.map(ref => {
        const name = (ref as Extract<MessageContent, {
            type: 'file-ref';
        }>).name;
        return `- ${JSON.stringify(name)}: workspace_action ${JSON.stringify({ action: 'read', path: name })}`;
    });
    return {
        refs,
        ephemeral: [{
                type: 'text',
                origin: 'robo',
                text: [
                    '[Explicit Cortex Files attachments]',
                    'The user explicitly attached the workspace files listed below to this message.',
                    'Read them with workspace_action using each exact path. They are imported workspace files, not host filesystem paths.',
                    'Prefer these attachments over same-named paths from Workspace RAG or other retrieved context. Do not use file_broker_action for these attachments.',
                    ...calls,
                    '[End explicit Cortex Files attachments]',
                ].join('\n'),
            }],
    };
}
export interface AttachmentResolver {
    resolve(files: FileStore | undefined, refs: unknown, signal?: AbortSignal): Promise<{
        refs: MessageContent[];
        ephemeral: MessageContent[];
    }>;
}
export const workspaceAttachmentResolver: AttachmentResolver = { resolve: prepareWorkspaceAttachments };
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly AttachmentResolver?: AttachmentResolver;
    }
}
