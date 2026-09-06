import type {} from '@matatbread/matbot-plugin-api';
/**
 * Shape of the `HostFileAccess` service: health probing plus brokered list/read/write access to
 * host files, with every method accepting an optional abort signal. Implementations enforce the
 * host security policy; return payloads are opaque to this package.
 */
export interface HostFileAccess {
    /** Report backend health. @param signal - Optional abort signal. @returns Backend-defined health details. @throws Error - If the backend is unavailable. */
    health(signal?: AbortSignal): Promise<unknown>;
    /** List entries under a host path, subject to the security policy. @param path - Host path to list. @param signal - Optional abort signal. @returns Backend-defined listing. @throws Error - If the path is not permitted or the backend fails. */
    list(path: string, signal?: AbortSignal): Promise<unknown>;
    /** Read a host file, subject to the security policy. @param path - Host path to read. @param signal - Optional abort signal. @returns Backend-defined file content. @throws Error - If the path is not permitted or the backend fails. */
    read(path: string, signal?: AbortSignal): Promise<unknown>;
    /** Write content to a host file, subject to the security policy. @param path - Host path to write. @param content - File content to write. @param approved - Whether the write carries explicit user approval. @param signal - Optional abort signal. @returns Backend-defined write result. @throws Error - If the write is not permitted or the backend fails. */
    write(path: string, content: string, approved: boolean, signal?: AbortSignal): Promise<unknown>;
}
/**
 * Shape of the `FileIndex` service: health/status reporting, indexing of configured host roots,
 * text search over indexed files, and cancellation of running jobs. Return payloads are opaque to
 * this package.
 */
export interface FileIndex {
    /** Report index health; also serves as the `status` action's payload. @returns Backend-defined health/status details. @throws Error - If the backend fails. */
    health(): Promise<unknown>;
    /** Index configured host roots, reconciling the persistent store. @param root - Specific root to index; `undefined` means the backend's default scope. @param signal - Optional abort signal. @returns Backend-defined job/summary payload. @throws Error - If indexing fails. */
    index(root?: string, signal?: AbortSignal): Promise<unknown>;
    /** Search indexed host text files. @param query - Free-text query. @param limit - Maximum number of hits; `undefined` means the backend's default. @param signal - Optional abort signal. @returns Backend-defined search results. @throws Error - If the search fails. */
    search(query: string, limit?: number, signal?: AbortSignal): Promise<unknown>;
    /** Cancel a running job. @param id - Job to cancel; what `undefined` targets is backend-defined. @returns The number of cancelled jobs, sync or as a promise. @throws Error - If cancellation fails. */
    cancel(id?: string): {
        cancelled: number;
    } | Promise<{
        cancelled: number;
    }>;
}
/** Registry additions for the file-services plugins: the selected wiring mode and the two optional services. */
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        /** Which file-services wiring the app selected: `local` (in-process) or `http` (client to a sidecar server). */
        readonly FileAccessSelection?: {
            mode: "local" | "http";
        };
        /** Brokered host file access, provided by a file-broker-backed plugin. */
        readonly HostFileAccess?: HostFileAccess;
        /** Host text-file index, provided by a file-index-backed plugin. */
        readonly FileIndex?: FileIndex;
    }
}
