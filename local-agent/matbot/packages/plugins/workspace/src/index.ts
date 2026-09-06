import type {} from '@matatbread/matbot-capabilities-types';
import {uiContribution} from './ui.js';
import {workspaceAttachmentResolver} from './attachments.js';
import type { Tool, ToolEvent, ToolContext, MatbotPluginSpec } from '@matatbread/matbot-plugin-api';
import { PLUGIN_API_VERSION } from '@matatbread/matbot-plugin-api';

const WORKSPACE_NS = 'workspace';

const MIME_MAP: Record<string, string> = {
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.pdf':  'application/pdf',
  '.zip':  'application/zip',
  '.sh':   'application/x-sh',
};

/**
 * Returns a normalised relative path if safe, null if it contains traversal.
 *
 * Backslashes are treated as separators and empty segments dropped; any `..`
 * segment rejects the whole path. The result is forward-slash-joined.
 *
 * @param input Raw path as supplied by the model, relative to the workspace root.
 * @returns The normalized relative path, or `null` when it would escape the workspace.
 */
function safePath(input: string): string | null {
  const parts = input.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some(p => p === '..')) return null;
  return parts.join('/');
}

/**
 * Maps a file name to a MIME type via its lower-cased extension.
 *
 * @param name File name; only the extension determines the type.
 * @returns The mapped MIME type (with charset for text formats), or `application/octet-stream` when unknown.
 */
function mimeFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot !== -1 ? name.slice(dot).toLowerCase() : '';
  return MIME_MAP[ext] ?? 'application/octet-stream';
}

/**
 * Decodes a base64 string into raw bytes.
 *
 * @param b64 Base64-encoded content.
 * @returns The decoded bytes.
 * @throws Error - When `b64` is not valid base64 (`atob` failure).
 */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Encodes raw bytes as a base64 string.
 *
 * @param bytes Bytes to encode.
 * @returns The base64-encoded string.
 * @throws Never.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 * Concatenates an async byte stream into a single buffer.
 *
 * @param stream Chunks to consume, in order.
 * @returns The concatenated bytes in stream order.
 * @throws Error - Propagates stream consumption failures (e.g. an aborted read).
 */
async function collectStream(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) { chunks.push(chunk); total += chunk.byteLength; }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

// The precise per-action contract. JSON Schema can't express "content is required only for write"
// without an awkward oneOf the providers honour inconsistently, so the schema stays loose and the
// description below carries this TypeScript discriminated union — which LLMs read accurately — as
// the source of truth. The executor enforces it.
/**
 * Per-action contract for `workspace_action`; the executor enforces what the
 * loose JSON schema cannot express. `content` is required only for `write`.
 */
type WorkspaceInput =
  | { action: 'read';   path: string; encoding?: 'utf8' | 'base64' }
  | { action: 'write';  path: string; content: string; encoding?: 'utf8' | 'base64' }
  | { action: 'list';   path?: string; recursive?: boolean }
  | { action: 'delete'; path: string };

const workspaceTool: Tool = {
  name: 'workspace_action',
  description:
    'Read, write, list, and delete files in the **workspace** — a small scratch ' +
    'and transfer area, NOT the host filesystem. Use it for files the user uploads or downloads, ' +
    'generated artifacts (reports, charts, exports), and working notes or to-do lists. It is not a code ' +
    'workspace: files here are not executable. Workspace files are publicly viewable; if a tool is available ' +
    'to mint a shareable link for a stored file, prefer it over guessing a URL.\n\n' +
    'Parameters depend on `action` (TypeScript):\n' +
    '```ts\n' +
    'type WorkspaceAction =\n' +
    "  | { action: 'read';   path: string; encoding?: 'utf8' | 'base64' }              // -> file contents\n" +
    "  | { action: 'write';  path: string; content: string; encoding?: 'utf8' | 'base64' } // -> { path, bytes }\n" +
    "  | { action: 'list';   path?: string; recursive?: boolean }                      // -> [{ path, size }] NOTE: `path` is a filename prefix - \".\" and \"/\" won't work.\n" +
    "  | { action: 'delete'; path: string };                                           // -> { path }\n" +
    '```\n' +
    "Use encoding 'base64' for binary files (images, PDFs, zips); 'utf8' (the default) for text.",
  inputSchema: {
    type:       'object',
    required:   ['action'],
    properties: {
      action:    { type: 'string', enum: ['read', 'write', 'list', 'delete'], description: 'The operation to perform.' },
      path:      { type: 'string', description: 'File path relative to the workspace root (e.g. "report.md", "charts/data.csv"). Required for read/write/delete; optional subdirectory filter for list.' },
      content:   { type: 'string', description: 'File contents — required for action "write".' },
      encoding:  { type: 'string', enum: ['utf8', 'base64'], default: 'utf8', description: "Used by read/write. 'base64' for binary files, 'utf8' (default) for text." },
      recursive: { type: 'boolean', default: false, description: 'list only: include files in subdirectories.' },
    },
  },
  executor: {
    async *execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const args = input as Partial<WorkspaceInput> & { action?: string };
      if (!ctx.files) { yield { type: 'error', message: 'No file store is configured for this session.' }; return; }

      switch (args.action) {
        case 'read': {
          const { path: inputPath, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'read' }>;
          if (!inputPath) { yield { type: 'error', message: 'action "read" requires "path".' }; return; }
          const safe = safePath(inputPath);
          if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

          const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
          if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

          let bytes: Uint8Array;
          try {
            bytes = await collectStream(handle.stream(ctx.signal));
          } catch (e) {
            yield { type: 'error', message: String(e) };
            return;
          }

          yield {
            type:  'result',
            value: encoding === 'base64' ? uint8ToBase64(bytes) : new TextDecoder().decode(bytes),
          };
          return;
        }

        case 'write': {
          const { path: inputPath, content, encoding = 'utf8' } = args as Extract<WorkspaceInput, { action: 'write' }>;
          if (!inputPath) { yield { type: 'error', message: 'action "write" requires "path".' }; return; }
          if (content === undefined) { yield { type: 'error', message: 'action "write" requires "content".' }; return; }
          const safe = safePath(inputPath);
          if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

          const bytes = encoding === 'base64'
            ? base64ToUint8(content)
            : new TextEncoder().encode(content);

          async function* makeStream(): AsyncIterable<Uint8Array> { yield bytes; }

          let handle;
          try {
            handle = await ctx.files.put(safe, mimeFromName(safe), makeStream(), { namespace: WORKSPACE_NS, allowed: true });
          } catch (e) {
            yield { type: 'error', message: String(e) };
            return;
          }

          yield { type: 'result', value: { path: safe, bytes: handle.size } };
          return;
        }

        case 'list': {
          const { path: inputPath, recursive = false } = args as Extract<WorkspaceInput, { action: 'list' }>;
          const prefix = inputPath ? `${safePath(inputPath) ?? ''}/` : '';

          const files: Array<{ path: string; size: number }> = [];
          try {
            for await (const handle of ctx.files.list({ namespace: WORKSPACE_NS })) {
              const name = handle.name;
              if (prefix && !name.startsWith(prefix)) continue;
              const rel = prefix ? name.slice(prefix.length) : name;
              if (!recursive && rel.includes('/')) continue;
              files.push({ path: name, size: handle.size });
            }
          } catch (e) {
            yield { type: 'error', message: String(e) };
            return;
          }

          yield { type: 'result', value: files };
          return;
        }

        case 'delete': {
          const { path: inputPath } = args as Extract<WorkspaceInput, { action: 'delete' }>;
          if (!inputPath) { yield { type: 'error', message: 'action "delete" requires "path".' }; return; }
          const safe = safePath(inputPath);
          if (!safe) { yield { type: 'error', message: 'Path escapes the workspace directory.' }; return; }

          const handle = await ctx.files.getByName(safe, WORKSPACE_NS);
          if (!handle) { yield { type: 'error', message: `File not found: "${safe}"` }; return; }

          await ctx.files.delete(handle.id);
          yield { type: 'result', value: { path: safe } };
          return;
        }

        default:
          yield { type: 'error', message: `Unknown action "${String(args.action)}". Expected one of: read, write, list, delete.` };
      }
    },
  },
};

/**
 * Workspace plugin: registers the `workspace_action` tool, a scratch file area
 * (read/write/list/delete) backed by the session's FileStore under the
 * `workspace` namespace.
 *
 * @returns The plugin specification.
 */
export const plugin: MatbotPluginSpec = {
  apiVersion: PLUGIN_API_VERSION,
  tools: [workspaceTool],
  async setup(services){
    services.contributions?.register('webui','files',uiContribution);await services.register('AttachmentResolver',workspaceAttachmentResolver);},
};
