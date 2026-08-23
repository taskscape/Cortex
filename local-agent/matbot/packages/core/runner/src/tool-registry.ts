import type { Tool, ToolRegistry, ToolRegistryEvent } from './types.js';
import { createBroadcaster } from '@matatbread/matbot-plugin-api';

/** In-memory {@link ToolRegistry} backed by a name-keyed map, with a live watch stream. */
export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly events = createBroadcaster<ToolRegistryEvent>();

  /**
   * Create a registry, optionally seeded.
   *
   * @param initial - Tools to register up front (last one per name wins).
   */
  constructor(initial?: Iterable<Tool>) {
    if (initial !== undefined) for (const tool of initial) this.tools.set(tool.name, tool);
  }

  /**
   * Register (or replace) a tool by name and emit a `registered` event.
   *
   * @param tool - The tool to register.
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
    this.events.emit({ type: 'registered', name: tool.name, ...(tool.pluginName !== undefined ? { pluginName: tool.pluginName } : {}) });
  }

  /**
   * Remove a tool by name; emits `removed` only when it existed.
   *
   * @param name - The tool's unique name.
   */
  remove(name: string): void {
    if (this.tools.delete(name)) this.events.emit({ type: 'removed', name });
  }

  /**
   * Remove every tool owned by the named plugin, emitting one `removed` event each.
   *
   * @param pluginName - The plugin whose tools to drop.
   */
  removeByPlugin(pluginName: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginName === pluginName && this.tools.delete(name)) this.events.emit({ type: 'removed', name });
    }
  }

  /**
   * Look up a tool by name.
   *
   * @param name - The tool's unique name.
   * @returns The tool, or `null` when not registered.
   */
  resolve(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  /**
   * Snapshot of all registered tools.
   *
   * @returns A new array of the registered tools in insertion order.
   */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Observe tool registrations/removals as they happen.
   *
   * @param signal - Optional abort signal; aborting ends the iteration.
   * @returns An async iterable of registry events.
   */
  watch(signal?: AbortSignal): AsyncIterable<ToolRegistryEvent> {
    return this.events.subscribe(signal);
  }
}
