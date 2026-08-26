import type { Tool, ToolContext } from '@matatbread/matbot-plugin-api';
import { defineTool } from './define.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TodoPriority = 'high' | 'medium' | 'low';

export interface Todo {
  content: string;
  status:  TodoStatus;
  priority: TodoPriority;
}

const STATUSES: readonly TodoStatus[]   = ['pending', 'in_progress', 'completed', 'cancelled'];
const PRIORITIES: readonly TodoPriority[] = ['high', 'medium', 'low'];

const todosBySession = new Map<string, Todo[]>();

/** Current todo list for a session (UI/tests). */
export function getSessionTodos(sessionId: string): readonly Todo[] {
  return todosBySession.get(sessionId) ?? [];
}

export function clearSessionTodos(sessionId: string): void {
  todosBySession.delete(sessionId);
}

interface WriteInput { todos: Array<{ content?: unknown; status?: unknown; priority?: unknown }> }

export const todowriteTool: Tool = defineTool({
  name: 'todowrite',
  description:
    'Maintain the session task list. Replaces the whole list each call — always pass every todo with ' +
    'its current state. Create todos for work with 3 or more steps before starting; keep exactly one ' +
    '`in_progress`; mark `completed` immediately after finishing an item and `cancelled` for abandoned ' +
    'ones. Each call must include the full list.',
  inputSchema: {
    type: 'object',
    required: ['todos'],
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          required: ['content', 'status'],
          properties: {
            content:  { type: 'string', minLength: 1, description: 'Brief imperative description of the task.' },
            status:   { type: 'string', enum: [...STATUSES], description: 'Current state of this todo.' },
            priority: { type: 'string', enum: [...PRIORITIES], description: 'Relative importance. Default "medium".' },
          },
        },
      },
    },
  },
  async *execute(input: unknown, ctx: ToolContext) {
    const req = input as WriteInput;
    if (!Array.isArray(req.todos)) throw new Error('todos must be an array');
    const todos: Todo[] = req.todos.map((t, i) => {
      if (typeof t.content !== 'string' || t.content.trim() === '') {
        throw new Error(`todos[${i}].content must be a non-empty string`);
      }
      const status = (t.status ?? 'pending') as TodoStatus;
      if (!STATUSES.includes(status)) throw new Error(`todos[${i}].status must be one of ${STATUSES.join(', ')}`);
      const priority = (t.priority ?? 'medium') as TodoPriority;
      if (!PRIORITIES.includes(priority)) throw new Error(`todos[${i}].priority must be one of ${PRIORITIES.join(', ')}`);
      return { content: t.content.trim(), status, priority };
    });
    todosBySession.set(ctx.session.id, todos);
    yield { type: 'marker', creator: 'harness-todo', data: { sessionId: ctx.session.id, todos } };
    yield { type: 'result', value: { todos } };
  },
});
