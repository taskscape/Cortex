import type { Session, SystemContextContributor, SystemContextRegistry } from './types.js';

interface TaggedContributor {
  fn:          SystemContextContributor;
  pluginName?: string;
}

/** In-memory {@link SystemContextRegistry}: contributors run concurrently per build. */
export class SystemContextRegistryImpl implements SystemContextRegistry {
  private readonly _contributors: TaggedContributor[] = [];

  /**
   * Register a system-prompt contributor.
   *
   * @param contributor - Called once per turn build.
   * @param pluginName - Owning plugin, used for bulk removal on unload.
   */
  register(contributor: SystemContextContributor, pluginName?: string): void {
    this._contributors.push({ fn: contributor, ...(pluginName !== undefined ? { pluginName } : {}) });
  }

  /**
   * Remove all contributors owned by the named plugin.
   *
   * @param pluginName - The plugin whose contributors to drop.
   */
  removeByPlugin(pluginName: string): void {
    for (let i = this._contributors.length - 1; i >= 0; i--) {
      if (this._contributors[i]?.pluginName === pluginName) this._contributors.splice(i, 1);
    }
  }

  /**
   * Run all contributors concurrently and join their non-empty results.
   *
   * @param ctx - The session being run and the abort signal.
   * @returns The joined system-context text, or `null` when no contributor produced output.
   */
  async build(ctx: { session: Session; signal: AbortSignal }): Promise<string | null> {
    const results = await Promise.allSettled(this._contributors.map(c => c.fn(ctx)));
    const parts: string[] = [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        const owner = this._contributors[i]?.pluginName ?? 'anonymous';
        console.warn(`[runner] system-context contributor "${owner}" failed; skipping it: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        continue;
      }
      const s = result.value;
      if (typeof s === 'string' && s.length > 0) parts.push(s);
    }
    return parts.length > 0 ? parts.join('\n\n') : null;
  }
}
