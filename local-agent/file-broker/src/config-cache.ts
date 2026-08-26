import { stat } from "node:fs/promises";

interface CachedConfig<T> {
  fingerprint: string;
  value: T;
}

/**
 * Caches a config value keyed by the file's size+mtime fingerprint, reloading
 * lazily on change and coalescing concurrent loads of the same version.
 *
 * @typeParam T - The parsed configuration type.
 */
export class ReloadingConfig<T> {
  private cached: CachedConfig<T> | undefined;
  private loading: { fingerprint: string; promise: Promise<T> } | undefined;
  private readonly filePath: string;
  private readonly loader: (filePath: string) => Promise<T>;

  /**
   * Creates a reload-on-change cache around one config file.
   *
   * @param filePath - Path of the configuration file to watch.
   * @param loader - Async function that reads and parses the file into a value.
   */
  constructor(
    filePath: string,
    loader: (filePath: string) => Promise<T>
  ) {
    this.filePath = filePath;
    this.loader = loader;
  }

  /**
   * Returns the current value, re-reading the file only when its size or
   * modification time has changed since the cached load. The fingerprint uses
   * bigint stat (`mtimeNs`) so sub-millisecond rapid edits are detected where a
   * millisecond-resolution fingerprint would miss them.
   *
   * @returns A promise resolving to the freshest parsed configuration.
   * @throws Any error from stat-ing or loading the file; concurrent callers of
   * the same pending load share its rejection.
   */
  async get(): Promise<T> {
    const info = await stat(this.filePath, { bigint: true });
    const fingerprint = `${info.size}:${info.mtimeNs}`;
    if (this.cached?.fingerprint === fingerprint) return this.cached.value;
    if (this.loading?.fingerprint === fingerprint) return this.loading.promise;

    const promise = this.loader(this.filePath).then(value => {
      this.cached = { fingerprint, value };
      return value;
    }).finally(() => {
      if (this.loading?.promise === promise) this.loading = undefined;
    });
    this.loading = { fingerprint, promise };
    return promise;
  }
}
