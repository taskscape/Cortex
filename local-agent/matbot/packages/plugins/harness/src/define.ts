import type { Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';

/**
 * Declares a tool with a bare generator; wraps it into the `Tool.executor` shape.
 *
 * The input tool omits `executor` and carries an `execute(input, ctx)` generator
 * at the top level instead; the returned tool nests it under `executor` unchanged.
 *
 * @param tool Tool definition without the `executor` wrapper, with a top-level
 *   `execute` generator receiving the parsed input and tool context.
 * @returns An equivalent `Tool` whose `executor.execute` is the given generator.
 * @throws Never.
 */
export function defineTool(
  tool: Omit<Tool, 'executor'> & { execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> },
): Tool {
  const { execute, ...rest } = tool;
  return { ...rest, executor: { execute } };
}
