/**
 * Public API of the `triggers` plugin: data-driven hooks that judge conversation
 * surfaces against stored conditions and invoke tools when they fire.
 *
 * @packageDocumentation
 */

export type { Trigger, TriggerCondition, TriggerInvoke, TriggerKind, TriggerSurface, TriggerSpec, Triggers, FiredCondition } from './types.js';
export { surfaceOfKind } from './types.js';
export { TriggerManager }                       from './manager.js';
export { dispatchTrigger, renderResult }        from './dispatch.js';
export { createTriggerActionTool, createTriggersConfigTool } from './tools.js';
export { createTriggersPlugin, setupTriggers, plugin } from './plugin.js';
