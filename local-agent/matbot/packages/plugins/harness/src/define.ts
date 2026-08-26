import type { Tool, ToolContext, ToolEvent } from '@matatbread/matbot-plugin-api';

/** Declare a tool with a bare generator; wraps it into the `Tool.executor` shape. */
export function defineTool(
  tool: Omit<Tool, 'executor'> & { execute(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> },
): Tool {
  const { execute, ...rest } = tool;
  return { ...rest, executor: { execute } };
}
