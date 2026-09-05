import type {} from '@matatbread/matbot-plugin-api';
export interface HostFileAccess {
    health(signal?: AbortSignal): Promise<unknown>;
    list(path: string, signal?: AbortSignal): Promise<unknown>;
    read(path: string, signal?: AbortSignal): Promise<unknown>;
    write(path: string, content: string, approved: boolean, signal?: AbortSignal): Promise<unknown>;
}
export interface FileIndex {
    health(): Promise<unknown>;
    index(root?: string, signal?: AbortSignal): Promise<unknown>;
    search(query: string, limit?: number, signal?: AbortSignal): Promise<unknown>;
    cancel(id?: string): {
        cancelled: number;
    } | Promise<{
        cancelled: number;
    }>;
}
declare module '@matatbread/matbot-plugin-api' {
    interface MatbotServices {
        readonly FileAccessSelection?: {
            mode: "local" | "http";
        };
        readonly HostFileAccess?: HostFileAccess;
        readonly FileIndex?: FileIndex;
    }
}
