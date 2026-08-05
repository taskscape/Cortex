import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Exercise the real execution path without requiring a local Postgres service. The plugin imports
// `pg` from its own package boundary, so resolve and replace that exact Pool prototype before the
// plugin module is loaded.
const structuredDataRequire = createRequire(new URL("../local-agent/matbot/packages/plugins/structured-data/src/index.ts", import.meta.url));
const { Pool } = structuredDataRequire("pg");
const sqlClientCalls = [];
Pool.prototype.connect = async () => ({
  async query(sql, values) {
    sqlClientCalls.push({ sql, values });
    if (/^SELECT\b/i.test(sql)) {
      return {
        rows: [{ order_date: "2026-01-01", total_revenue: "42.00" }],
        fields: [{ name: "order_date" }, { name: "total_revenue" }],
      };
    }
    return { rows: [], fields: [] };
  },
  release() {
    sqlClientCalls.push({ sql: "RELEASE" });
  },
});
Pool.prototype.end = async () => undefined;

const { plugin } = await import("../local-agent/matbot/packages/plugins/structured-data/src/index.ts");
const { plugin: sourceRegistryPlugin } = await import("../local-agent/matbot/packages/plugins/source-registry/src/index.ts");

class MemoryStore {
  constructor() {
    this.docs = new Map();
  }

  async get(id) {
    return this.docs.get(id) ?? null;
  }

  async set(id, value) {
    this.docs.set(id, value);
  }

  async cas(id, expected, next) {
    const current = this.docs.get(id) ?? null;
    if (current === null || current.version !== expected) return { ok: false, current };
    this.docs.set(id, next);
    return { ok: true, doc: next };
  }

  async delete(id, expectedVersion) {
    const current = this.docs.get(id) ?? null;
    if (current === null) return false;
    if (expectedVersion !== undefined && current.version !== expectedVersion) return false;
    return this.docs.delete(id);
  }

  async query(q = {}) {
    let items = [...this.docs.values()];
    if (q.where !== undefined) items = items.filter(item => matches(item, q.where));
    return { items, total: items.length };
  }
}

function fieldValue(item, field) {
  const parts = Array.isArray(field) ? field : [field];
  let value = item;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    value = value[part];
  }
  return value;
}

function matches(item, filter) {
  switch (filter.op) {
    case "eq":
      return fieldValue(item, filter.field) === filter.value;
    case "and":
      return filter.clauses.every(clause => matches(item, clause));
    case "or":
      return filter.clauses.some(clause => matches(item, clause));
    default:
      return true;
  }
}

async function collectTool(tool, input) {
  const events = [];
  for await (const event of tool.executor.execute(input, {
    signal: new AbortController().signal,
    vault: {
      async resolve(value) { return value; },
    },
  })) {
    events.push(event);
  }
  const error = events.find(event => event.type === "error");
  if (error !== undefined) return { error: error.message };
  return events.find(event => event.type === "result")?.value;
}

async function main() {
  const stores = new Map();
  const servicesByKey = new Map();
  const tools = new Map();
  const services = {
    Vault: {
      async resolve(value) { return value; },
    },
    createStore(namespace) {
      if (!stores.has(namespace)) stores.set(namespace, new MemoryStore());
      return stores.get(namespace);
    },
    async register(key, value) {
      servicesByKey.set(key, value);
      this[key] = value;
    },
    get(key) {
      return servicesByKey.get(key);
    },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
      },
    },
  };

  await sourceRegistryPlugin.setup(services);
  await plugin.setup(services);
  const catalog = services.DataCatalog;
  const planner = services.SqlPlanner;
  const structuredTool = tools.get("structured_data_action");
  const sourceTool = tools.get("source_action");
  assert.ok(catalog, "DataCatalog service should be registered");
  assert.ok(planner, "SqlPlanner service should be registered");
  assert.ok(structuredTool, "structured_data_action tool should be registered");

  const connection = await collectTool(structuredTool, {
    action: "register_connection",
    connection: {
      workspaceId: "default",
      displayName: "Warehouse",
      credentialRef: "postgres://readonly:fake@127.0.0.1:5432/warehouse",
      rowLimitDefault: 50,
      timeoutMsDefault: 2500,
      defaultSchema: "public",
    },
  });
  assert.equal(connection.readOnly, true);
  assert.equal(connection.dialect, "postgres");
  assert.equal(connection.connectorInstanceId, "connector-instance:postgres-readonly:local");

  const table = await collectTool(structuredTool, {
    action: "upsert_table",
    table: {
      workspaceId: "default",
      connectionId: connection.id,
      schemaName: "public",
      tableName: "orders",
      displayName: "Orders",
      primaryKey: ["id"],
      columns: [
        { tableId: "ignored", name: "id", dataType: "string", role: "identifier", nullable: false },
        { tableId: "ignored", name: "order_date", dataType: "date", role: "dimension", nullable: false },
        { tableId: "ignored", name: "status", dataType: "string", role: "dimension", nullable: false },
        { tableId: "ignored", name: "amount", dataType: "number", role: "measure", nullable: false },
      ],
    },
  });
  assert.equal(table.tableName, "orders");

  const catalogView = await collectTool(structuredTool, { action: "catalog" });
  const storedTable = catalogView.tables.find(item => item.id === table.id);
  const orderDate = catalogView.columns.find(item => item.tableId === table.id && item.name === "order_date");
  const status = catalogView.columns.find(item => item.tableId === table.id && item.name === "status");
  assert.ok(storedTable.sourceId, "cataloged tables should have source records");
  assert.ok(orderDate);
  assert.ok(status);

  const metric = await collectTool(structuredTool, {
    action: "upsert_metric",
    metric: {
      workspaceId: "default",
      name: "total_revenue",
      businessName: "Total Revenue",
      baseTableId: table.id,
      expression: "amount",
      aggregation: "sum",
      allowedDimensions: [orderDate.id],
      allowedFilters: [status.id],
    },
  });
  assert.equal(metric.name, "total_revenue");

  const plan = await collectTool(structuredTool, {
    action: "plan_query",
    plan: {
      workspaceId: "default",
      metricName: "total_revenue",
      dimensions: [orderDate.id],
      filters: [{ columnId: status.id, op: "eq", value: "paid" }],
      limit: 200,
    },
  });
  assert.equal(plan.queryRun.status, "planned");
  assert.match(plan.queryRun.sql, /SELECT "order_date" AS "order_date", sum\("amount"\) AS "total_revenue"/);
  assert.match(plan.queryRun.sql, /FROM "public"\."orders"/);
  assert.match(plan.queryRun.sql, /WHERE "status" = \$1/);
  assert.match(plan.queryRun.sql, /LIMIT 50/);
  assert.deepEqual(plan.queryRun.parameters, ["paid"]);
  assert.equal(plan.validation.valid, true);
  assert.deepEqual(plan.costEstimate, {
    complexity: "medium",
    score: 3,
    factors: ["1 dimension", "1 filter", "row limit 50"],
  });
  assert.match(plan.rowCapWarning, /Requested limit 200 exceeds row cap 50/);
  assert.deepEqual(plan.queryRun.sourceIds, [storedTable.sourceId]);

  const badWrite = await collectTool(structuredTool, { action: "validate_sql", sql: "DELETE FROM public.orders WHERE id = 1" });
  assert.equal(badWrite.valid, false);
  assert.equal(badWrite.readOnly, false);
  assert.ok(badWrite.reasons.some(reason => reason.includes("Only SELECT")));

  const missingLimit = await collectTool(structuredTool, { action: "validate_sql", sql: "SELECT id FROM public.orders" });
  assert.equal(missingLimit.valid, false);
  assert.ok(missingLimit.reasons.some(reason => reason.includes("explicit LIMIT")));

  const crossJoin = await collectTool(structuredTool, {
    action: "validate_sql",
    sql: "SELECT o.id FROM public.orders o CROSS JOIN public.orders other LIMIT 10",
  });
  assert.equal(crossJoin.valid, false);
  assert.ok(crossJoin.reasons.some(reason => reason.includes("CROSS JOIN")));

  const multipleStatements = await collectTool(structuredTool, {
    action: "validate_sql",
    sql: "SELECT id FROM public.orders LIMIT 1; SELECT id FROM public.orders LIMIT 1",
  });
  assert.equal(multipleStatements.valid, false);
  assert.ok(multipleStatements.reasons.some(reason => reason.includes("Multiple SQL statements")));

  const dataModifyingCte = await collectTool(structuredTool, {
    action: "validate_sql",
    sql: "WITH removed AS (DELETE FROM public.orders RETURNING id) SELECT id FROM removed LIMIT 1",
  });
  assert.equal(dataModifyingCte.valid, false);
  assert.ok(dataModifyingCte.reasons.some(reason => reason.includes("Only SELECT")));
  assert.ok(dataModifyingCte.reasons.some(reason => reason.includes("disallowed write")));

  const harmlessComment = await collectTool(structuredTool, {
    action: "validate_sql",
    sql: "SELECT id /* DELETE is documentation here */ FROM public.orders LIMIT 1",
  });
  assert.equal(harmlessComment.valid, true);

  const unknownDimension = await collectTool(structuredTool, {
    action: "plan_query",
    plan: {
      workspaceId: "default",
      metricName: "total_revenue",
      dimensions: ["not_a_column"],
    },
  });
  assert.match(unknownDimension.error, /Unknown dimension column/);

  const unknownMetric = await collectTool(structuredTool, {
    action: "plan_query",
    plan: { workspaceId: "default", metricName: "not_a_metric" },
  });
  assert.match(unknownMetric.error, /known metricId or metricName/);

  const unknownFilter = await collectTool(structuredTool, {
    action: "plan_query",
    plan: {
      workspaceId: "default",
      metricName: "total_revenue",
      filters: [{ columnId: "not_a_filter", op: "eq", value: "paid" }],
    },
  });
  assert.match(unknownFilter.error, /Unknown filter column/);

  const zeroLimit = await collectTool(structuredTool, {
    action: "plan_query",
    plan: {
      workspaceId: "default",
      metricName: "total_revenue",
      dimensions: [orderDate.id],
      limit: 0,
    },
  });
  assert.equal(zeroLimit.queryRun.rowLimit, 1);
  assert.match(zeroLimit.queryRun.sql, /LIMIT 1/);

  const approval = await collectTool(structuredTool, { action: "approve_query", queryRunId: plan.queryRun.id });
  assert.equal(approval.queryRun.status, "approved");
  assert.equal(typeof approval.approvalToken, "string");

  const badExecution = await collectTool(structuredTool, {
    action: "execute_query",
    queryRunId: plan.queryRun.id,
    approvalToken: "wrong-token",
  });
  assert.match(badExecution.error, /Invalid approval token/);

  const executablePlan = await collectTool(structuredTool, {
    action: "plan_query",
    plan: {
      workspaceId: "default",
      metricName: "total_revenue",
      dimensions: [orderDate.id],
      filters: [{ columnId: status.id, op: "eq", value: "paid" }],
      limit: 5,
    },
  });
  const executableApproval = await collectTool(structuredTool, {
    action: "approve_query",
    queryRunId: executablePlan.queryRun.id,
  });
  const executed = await collectTool(structuredTool, {
    action: "execute_query",
    queryRunId: executablePlan.queryRun.id,
    approvalToken: executableApproval.approvalToken,
  });
  assert.equal(executed.run.status, "succeeded");
  assert.equal(executed.run.rowCount, 1);
  assert.deepEqual(executed.rows, [{ order_date: "2026-01-01", total_revenue: "42.00" }]);
  assert.deepEqual(executed.fields, ["order_date", "total_revenue"]);
  assert.ok(executed.citation?.sourceId, "execution records a durable result source for provenance");
  assert.equal(executed.run.resultSourceId, executed.citation.sourceId);
  assert.deepEqual(sqlClientCalls.map(call => call.sql), [
    "BEGIN READ ONLY",
    "SET LOCAL statement_timeout = 2500",
    executablePlan.queryRun.sql,
    "COMMIT",
    "RELEASE",
  ]);
  assert.deepEqual(sqlClientCalls[2].values, ["paid"], "the approved semantic filter is bound as a query parameter");

  const resultVersion = (await stores.get("source_versions").query()).items
    .find(version => version.sourceId === executed.citation.sourceId);
  assert.equal(resultVersion?.provenance.activityId, `structured-data:${executablePlan.queryRun.id}:execute`);

  const runStore = stores.get("structured_data_query_runs");
  const expiringPlan = await collectTool(structuredTool, {
    action: "plan_query",
    plan: {
      workspaceId: "default",
      metricName: "total_revenue",
      dimensions: [orderDate.id],
      limit: 5,
    },
  });
  const expiringApproval = await collectTool(structuredTool, {
    action: "approve_query",
    queryRunId: expiringPlan.queryRun.id,
  });
  const expiringRun = await runStore.get(expiringPlan.queryRun.id);
  await runStore.set(expiringRun.id, {
    ...expiringRun,
    approvalExpiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  const expiredExecution = await collectTool(structuredTool, {
    action: "execute_query",
    queryRunId: expiringRun.id,
    approvalToken: expiringApproval.approvalToken,
  });
  assert.match(expiredExecution.error, /approval expired/);
  const resetExpiredRun = await runStore.get(expiringRun.id);
  assert.equal(resetExpiredRun.status, "planned");
  assert.equal(Object.hasOwn(resetExpiredRun, "approvalTokenHash"), false);

  const approvedRun = await runStore.get(plan.queryRun.id);
  await runStore.set(plan.queryRun.id, {
    ...approvedRun,
    sql: "DELETE FROM public.orders WHERE id = 1",
  });
  const tamperedExecution = await collectTool(structuredTool, {
    action: "execute_query",
    queryRunId: plan.queryRun.id,
    approvalToken: approval.approvalToken,
  });
  assert.match(tamperedExecution.error, /SQL validation failed before execution/);

  await runStore.set(plan.queryRun.id, { ...approvedRun, status: "succeeded" });
  const reusedApproval = await collectTool(structuredTool, {
    action: "execute_query",
    queryRunId: plan.queryRun.id,
    approvalToken: approval.approvalToken,
  });
  assert.match(reusedApproval.error, /must be approved before execution/);

  const runs = await collectTool(structuredTool, { action: "runs" });
  assert.equal(runs.runs.length, 4);
  assert.equal(runs.runs.find(run => run.id === plan.queryRun.id).status, "succeeded");
  assert.equal(runs.runs.find(run => run.id === executablePlan.queryRun.id).status, "succeeded");
  assert.equal(runs.runs.find(run => run.id === zeroLimit.queryRun.id).status, "planned");

  const sources = await collectTool(sourceTool, { action: "list" });
  assert.ok(sources.sources.some(source => source.id === storedTable.sourceId && source.sourceKind === "table"));
  assert.ok(sources.sources.some(source => source.id === executed.citation.sourceId && source.sourceKind === "query_result"));
}

await main();
console.log("structured-data plans governed SQL from semantic catalog records and rejects unsafe queries");
