import assert from "node:assert/strict";
import test from "node:test";

import { plugin as expertPanelPlugin } from "../local-agent/matbot/plugins/expert-panel/dist/index.js";

test("expert panel runs selected experts with isolated knowledge and synthesis", async () => {
  let registeredTool;
  const calls = [];

  const services = {
    providers: new Map([["openai", {}]]),
    tools: {
      register(tool) {
        registeredTool = tool;
      }
    },
    async singleTurn(request) {
      calls.push(request);
      return {
        text: `fake response ${calls.length}`,
        usage: { inputTokens: 10, outputTokens: 5 }
      };
    }
  };

  await expertPanelPlugin.setup(services);
  assert.equal(registeredTool?.name, "expert_panel");

  const listEvents = [];
  for await (const event of registeredTool.executor.execute({ action: "list" }, { signal: new AbortController().signal, provider: "openai" })) {
    listEvents.push(event);
  }
  const listResult = listEvents.find(event => event.type === "result");
  assert.deepEqual(listResult.value.experts.map(expert => expert.id), ["design", "finance", "engineering"]);
  assert.equal(listResult.value.experts.some(expert => "systemPrompt" in expert), false);

  const events = [];
  const context = { signal: new AbortController().signal, provider: "openai" };
  for await (const event of registeredTool.executor.execute({
    question: "Compare PanelProbeDesign PanelProbeFinance PanelProbeEngineering.",
    experts: ["design", "finance", "engineering"],
    mode: "review",
    maxCitationsPerExpert: 2,
    synthesize: true
  }, context)) {
    events.push(event);
  }

  const resultEvent = events.find(event => event.type === "result");
  assert.ok(resultEvent);
  assert.equal(resultEvent.value.experts.length, 3);
  assert.equal(typeof resultEvent.value.synthesis, "string");

  const design = resultEvent.value.experts.find(expert => expert.expertId === "design");
  const finance = resultEvent.value.experts.find(expert => expert.expertId === "finance");
  const engineering = resultEvent.value.experts.find(expert => expert.expertId === "engineering");

  assert.ok(design.citations.some(citation => citation.title === "panel-probe.md"));
  assert.ok(finance.citations.some(citation => citation.title === "panel-probe.md"));
  assert.ok(engineering.citations.some(citation => citation.title === "panel-probe.md"));

  assert.match(calls[0].prompt, /PanelProbeDesign/);
  assert.match(calls[1].prompt, /PanelProbeFinance/);
  assert.match(calls[2].prompt, /PanelProbeEngineering/);
  assert.match(calls[3].system, /orchestrating agent/i);
});

test("expert panel reports unknown experts as tool errors", async () => {
  let registeredTool;
  const services = {
    providers: new Map([["openai", {}]]),
    tools: {
      register(tool) {
        registeredTool = tool;
      }
    },
    async singleTurn() {
      throw new Error("singleTurn should not be called for unknown experts");
    }
  };

  await expertPanelPlugin.setup(services);

  const events = [];
  for await (const event of registeredTool.executor.execute({
    question: "Test",
    experts: ["nonexistent"]
  }, { signal: new AbortController().signal, provider: "openai" })) {
    events.push(event);
  }

  const error = events.find(event => event.type === "error");
  assert.match(error?.message ?? "", /Unknown expert/);
});
