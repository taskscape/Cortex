import type { DriveAuth } from './drive-auth.js';

// Thin wrapper over the Google Drive v3 REST + upload endpoints. Every call carries the bearer token
// from DriveAuth; a 401 invalidates the token and retries once (covers silent renewal of an expired
// token). Nothing here knows about matbot stores — it speaks folders, files, and bytes.

const API    = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS       = 4;
const MAX_LIST_PAGES     = 100;

/**
 * Whether an HTTP status warrants a retry.
 * @param status - HTTP status code of the response.
 * @returns True for 429 (rate limit) or any 5xx server error.
 * @throws Never.
 */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Resolves after `ms` milliseconds.
 * @param ms - Delay in milliseconds.
 * @returns Resolves once the delay elapses.
 * @throws Never.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Metadata of a Drive file/folder as returned by list operations.
 */
export interface DriveFile {
  id:        string;
  name:      string;
  mimeType?: string;
}

/**
 * Escapes a value for embedding in a single-quoted Drive `q` string literal.
 * @param value - Raw value (folder id or name).
 * @returns The escaped value.
 * @throws Never.
 */
function qEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Minimal typed client over the Drive v3 REST API: folder management,
 * reads, multipart uploads, deletes — with retry on transient errors.
 */
export class DriveClient {
  private readonly auth: DriveAuth;

  /**
   * Creates the client; requests carry no token until the first call fetches
   * one via {@link DriveAuth.token}.
   * @param auth - Token source; every request bears its bearer token, and a
   *   401 invalidates it via {@link DriveAuth.invalidate}.
   * @throws Never.
   */
  constructor(auth: DriveAuth) {
    this.auth = auth;
  }

  /**
   * Core request path: attaches the bearer token, retries transient failures
   * (429/5xx) up to four attempts honouring `Retry-After` (else exponential
   * backoff), and on a 401 invalidates the token and retries exactly once —
   * covering silent renewal of an expired token.
   * @param url - Absolute endpoint URL.
   * @param init - Fetch init (method, headers, body); headers are copied and
   *   the Authorization header is set.
   * @param retryOn401 - Internal guard set to false on the single 401 retry so
   *   an authoritative auth failure cannot loop.
   * @returns The final {@link Response} (which may still be non-OK).
   * @throws Propagates authorisation failures from {@link DriveAuth.token} and
   *   network/timeout errors from `fetch`.
   */
  private async fetch(url: string, init: RequestInit, retryOn401 = true): Promise<Response> {
    const token = await this.auth.token();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);

    for (let attempt = 1;; attempt++) {
      const res = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!isTransient(res.status) || attempt >= MAX_ATTEMPTS) {
        if (res.status === 401 && retryOn401) {
          this.auth.invalidate();
          return this.fetch(url, init, false);
        }
        return res;
      }
      // Drive rate-limits aggressively; honor Retry-After, else exponential backoff.
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter >= 0
          ? Math.min(retryAfter * 1000, 30_000)
          : Math.min(500 * 2 ** (attempt - 1), 8_000),
      );
    }
  }

  /**
   * Parses a response body as JSON, converting non-OK responses into
   * descriptive errors (status, status text, first 500 bytes of the body).
   * @typeParam T - Expected shape of the parsed body.
   * @param res - Response to parse.
   * @returns The parsed body.
   * @throws Error when the response is not OK; JSON parse errors propagate.
   */
  private async json<T>(res: Response): Promise<T> {
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Google Drive ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }
    return res.json() as Promise<T>;
  }

  /**
   * Lists children of a folder, optionally filtered to one exact name. Folders
   * themselves are excluded unless `foldersOnly`. Walks pagination so callers
   * get the full set.
   * @param parentId - Folder id to list.
   * @param opts - Optional name filter and folders-only flag.
   * @returns Matching entries in Drive order, complete across pages (empty
   *   when the parent is missing).
   * @throws Error when listing exceeds 100 pages; propagates Drive API errors
   *   from non-OK responses.
   */
  async list(parentId: string, opts?: { name?: string; foldersOnly?: boolean }): Promise<DriveFile[]> {
    const clauses = [`'${qEscape(parentId)}' in parents`, 'trashed=false'];
    if (opts?.name !== undefined)  clauses.push(`name='${qEscape(opts.name)}'`);
    if (opts?.foldersOnly)         clauses.push(`mimeType='${FOLDER_MIME}'`);
    const q = clauses.join(' and ');

    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      if (++pages > MAX_LIST_PAGES) {
        throw new Error(`Google Drive listing exceeded ${MAX_LIST_PAGES} pages for parent ${parentId}`);
      }
      const params = new URLSearchParams({
        q,
        fields:   'nextPageToken,files(id,name,mimeType)',
        spaces:   'drive',
        pageSize: '1000',
      });
      if (pageToken !== undefined) params.set('pageToken', pageToken);
      const res  = await this.fetch(`${API}/files?${params.toString()}`, { method: 'GET' });
      const page = await this.json<{ files?: DriveFile[]; nextPageToken?: string }>(res);
      out.push(...(page.files ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return out;
  }

  /**
   * Finds a child folder by name, creating it when absent. `parentId` of
   * 'root' targets Drive root. The lookup-then-create window means concurrent
   * creators can race Drive itself, but the id returned is valid either way.
   * @param name - Folder name.
   * @param parentId - Parent folder id.
   * @returns The folder id (existing or newly created).
   * @throws Propagates Drive API errors from the listing or creation.
   */
  async ensureFolder(name: string, parentId: string): Promise<string> {
    const existing = await this.list(parentId, { name, foldersOnly: true });
    if (existing[0] !== undefined) return existing[0].id;
    const res = await this.fetch(`${API}/files`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return (await this.json<DriveFile>(res)).id;
  }

  /**
   * Resolves (creating as needed) a nested folder path under `rootParent`.
   * Each segment is resolved sequentially via {@link DriveClient.ensureFolder},
   * so the call costs one round-trip per segment.
   * @param parts - Folder path segments, in order.
   * @param rootParent - Id of the folder to resolve under; 'root' means Drive
   *   root (the default).
   * @returns The id of the final folder in the path.
   * @throws Propagates Drive API errors from any segment.
   */
  async ensureFolderPath(parts: string[], rootParent = 'root'): Promise<string> {
    let parent = rootParent;
    for (const part of parts) parent = await this.ensureFolder(part, parent);
    return parent;
  }

  /**
   * Downloads a file's content as UTF-8 text.
   * @param fileId - Drive file id.
   * @returns The file content.
   * @throws Error on any non-OK response (after transient-error retries).
   */
  async readText(fileId: string): Promise<string> {
    const res = await this.fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' });
    if (!res.ok) throw new Error(`Google Drive read ${res.status} for ${fileId}`);
    return res.text();
  }

  /**
   * Downloads a file's content as raw bytes.
   * @param fileId - Drive file id.
   * @returns The file content.
   * @throws Error on any non-OK response (after transient-error retries).
   */
  async readBytes(fileId: string): Promise<Uint8Array> {
    const res = await this.fetch(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, { method: 'GET' });
    if (!res.ok) throw new Error(`Google Drive read ${res.status} for ${fileId}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Creates a file with the given body via a multipart upload.
   * @param name - File name within the folder.
   * @param parentId - Folder id to create the file in.
   * @param body - Content as a Blob or string.
   * @param mimeType - MIME type of the content.
   * @returns The new file id.
   * @throws Propagates Drive API errors from the upload.
   */
  async createFile(name: string, parentId: string, body: Blob | string, mimeType: string): Promise<string> {
    const metadata = { name, parents: [parentId] };
    const { contentType, payload } = multipart(metadata, body, mimeType);
    const res = await this.fetch(`${UPLOAD}?uploadType=multipart&fields=id`, {
      method:  'POST',
      headers: { 'content-type': contentType },
      body:    payload,
    });
    return (await this.json<DriveFile>(res)).id;
  }

  /**
   * Overwrites an existing file's content in place (metadata unchanged) via a
   * media PATCH upload.
   * @param fileId - Drive file id to overwrite.
   * @param body - New content as a Blob or string.
   * @param mimeType - MIME type of the content.
   * @returns Resolves once the content is replaced.
   * @throws Propagates Drive API errors from the upload.
   */
  async updateFile(fileId: string, body: Blob | string, mimeType: string): Promise<void> {
    const res = await this.fetch(`${UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media`, {
      method:  'PATCH',
      headers: { 'content-type': mimeType },
      body,
    });
    await this.json<DriveFile>(res);
  }

  /**
   * Deletes (trashes) a file. A 404 counts as success — already gone is the
   * caller's desired end state.
   * @param fileId - Drive file id.
   * @returns Resolves once the delete is accepted.
   * @throws Error on any non-OK response other than 404.
   */
  async deleteFile(fileId: string): Promise<void> {
    const res = await this.fetch(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
    // 404 ⇒ already gone, which is the caller's desired end state.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Google Drive delete ${res.status} for ${fileId}`);
    }
  }
}

/**
 * Builds a `multipart/related` body (JSON metadata part + media part) for
 * Drive's multipart upload, using a random UUID-derived boundary.
 * @param metadata - JSON-serialisable file metadata (first part).
 * @param media - The media payload (second part).
 * @param mediaType - MIME type of the media part.
 * @returns The `content-type` header value and the assembled body.
 * @throws Never.
 */
function multipart(metadata: unknown, media: Blob | string, mediaType: string): { contentType: string; payload: Blob } {
  const boundary = `mb${crypto.randomUUID().replace(/-/g, '')}`;
  const head =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    payload:     new Blob([head, media, tail]),
  };
}
