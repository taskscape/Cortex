import { stat } from "node:fs/promises";

interface CachedConfig<T> {
  fingerprint: string;
  value: T;
}

export class ReloadingConfig<T> {
  private cached: CachedConfig<T> | undefined;
  private loading: { fingerprint: string; promise: Promise<T> } | undefined;
  private readonly filePath: string;
  private readonly loader: (filePath: string) => Promise<T>;

  constructor(
    filePath: string,
    loader: (filePath: string) => Promise<T>
  ) {
    this.filePath = filePath;
    this.loader = loader;
  }

  async get(): Promise<T> {
    const info = await stat(this.filePath);
    const fingerprint = `${info.size}:${info.mtimeMs}`;
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
