# Expert Panel WebUI User Manual

> Part of the [Cortex Local Agent documentation](../README.md).

The Expert Panel lets one user question be answered from several configured
perspectives, such as design, finance, and engineering. It is useful when a
decision has tradeoffs and a single assistant answer would flatten the problem.

The panel is integrated into the normal chat composer. You do not type into a
separate expert form. You choose the expert settings, type the question in the
main chat box, and send it normally.

## Where To Find It

Open the WebUI at `http://localhost:19778`. At the bottom composer, the top row
contains:

- `Model:` selector: chooses the normal chat model/provider.
- `Experts` selector: opens the expert-panel settings popup.

When the expert panel is enabled, the selector changes from `Experts` to
`Experts on`. This is the quick visual cue that the next message will run
through the panel instead of normal chat.

## Expert Popup Controls

Click `Experts` to open the popup. The popup contains these controls:

| Control | What it does |
| --- | --- |
| `Use experts` | Turns expert-panel mode on for the next submitted chat question. If unchecked, the chat behaves normally. |
| `All experts` | Runs every configured expert. In the default setup this means Design, Finance, and Engineering. |
| Individual expert checkboxes | Lets you run only selected experts. These appear under `Selection` when experts are available. |
| `Mode` | Controls how each expert should frame the answer: `Parallel`, `Review`, or `Debate`. |
| `Synthesize decision` | When checked, runs a final orchestration pass that collates expert opinions into a recommendation. |
| Status line | Shows whether experts are unavailable, running, complete, or failed. |

The popup closes when you click outside it. Your selected settings remain in the
composer until changed or until the page is refreshed.

## Running The Whole Panel

Use this when you want all available perspectives.

1. Click `Experts`.
2. Check `Use experts`.
3. Leave `All experts` checked.
4. Choose a `Mode`.
5. Leave `Synthesize decision` checked if you want a final recommendation.
6. Type your question in the main chat box.
7. Click the send button.

The user message shown in the transcript includes a short summary such as:

```text
Expert panel (review)
Experts: all
Synthesize decision: yes

Should we ship this feature?
```

That summary is intentional. It records which panel settings were used for that
turn. The summary is stored as the user message for the expert-panel turn, so it
survives reloads and remains available as context for later normal chat turns.

## Running Selected Experts

Use this when only some perspectives are relevant.

1. Click `Experts`.
2. Check `Use experts`.
3. Uncheck `All experts`.
4. Check the individual experts you want, for example `Design Expert` and
   `Engineering Expert`.
5. Choose a `Mode`.
6. Choose whether to synthesize.
7. Type the question in the main chat box and send.

If `All experts` is unchecked and no individual expert is selected, Cortex shows
an error in the expert popup and does not run the panel.

## Choosing A Mode

| Mode | Best for | Behavior |
| --- | --- | --- |
| `Parallel` | Broad perspective gathering. | Each expert answers independently from its own viewpoint. |
| `Review` | Critiquing a proposal, implementation, or plan. | Experts look for strengths, risks, omissions, and practical concerns. |
| `Debate` | Surfacing disagreement and tradeoffs. | Experts emphasize where their priorities conflict and what would change their recommendation. |

The `Mode` dropdown uses the same compact selector design as the model selector.

## Synthesis

`Synthesize decision` controls whether Cortex asks an orchestrating agent to
collate the expert outputs.

When synthesis is enabled, the final answer includes:

- each expert's opinion;
- citations for files retrieved for each expert;
- a synthesis section with consensus, disagreement, risks, assumptions, and a
  final recommendation.

When synthesis is disabled, Cortex returns only the selected expert opinions.
This is useful when you want to compare raw perspectives yourself.

## Reading The Result

The answer is rendered in the normal chat transcript. A typical expert-panel
answer has:

- one heading per expert, such as `Design Expert`, `Finance Expert`, or
  `Engineering Expert`;
- each expert's grounded answer;
- citations listing expert-specific source files when relevant;
- an optional `Synthesis` section.

The status line in the popup changes to `Complete.` after a successful run.
The panel answer is stored as a normal assistant message in the active session.
Reloading the WebUI re-renders the same expert-panel turn from session history.

## Model Selector And Expert Providers

The `Model:` selector still controls normal chat. Expert panel execution has two
provider layers:

- Individual experts use the provider configured for that expert in
  `local-agent\config\experts.json`. If an expert has no provider, Cortex falls
  back to the current turn provider or the expert panel default provider.
- The synthesis pass uses the current turn provider when available, falling back
  to the expert panel default provider.

This means changing the WebUI `Model:` selector can affect synthesis and fallback
behavior, but it does not directly rewrite each expert's configured provider.

## Knowledge And Citations

Each expert has its own knowledge roots. In the default setup:

- Design knowledge lives under `local-agent\knowledge\design`.
- Finance knowledge lives under `local-agent\knowledge\finance`.
- Engineering knowledge lives under `local-agent\knowledge\engineering`.

When the panel runs, each expert searches only its own configured files. That
keeps perspectives separated. For example, the Design Expert does not retrieve
from the Finance Expert's knowledge root unless both experts are explicitly
configured to share a root.

Supported expert knowledge file extensions are `.md`, `.mdx`, `.txt`, `.json`,
`.csv`, `.tsv`, `.yaml`, and `.yml`. Files larger than 1 MB are skipped.

## Common User Problems

`expert_panel plugin unavailable.`

The active workspace did not load `./plugins/expert-panel`, or the browser is
connected to an old WebUI process. Restart Cortex:

```powershell
.\scripts\run.ps1
```

Then hard-refresh the browser and open the `Experts` selector again.

`No experts configured.`

The plugin loaded, but `local-agent\config\experts.json` is missing, invalid, or
contains no experts.

The panel runs but citations are empty.

The selected expert's knowledge roots did not contain matching text for the
question, the files are unsupported, or the files are larger than the 1 MB expert
retrieval limit. The expert can still answer from its system prompt, but it will
have less grounding.

The wrong experts were used.

Check whether `All experts` is still selected. If it is checked, individual
checkboxes are treated as all selected. Uncheck `All experts` before selecting a
subset.

## Implementation Workflow

Internally, the expert panel is deliberately tool-based. It does not spin up
separate chatbot processes.

Flow:

1. The WebUI submits a forced expert-panel turn to
   `POST /sessions/:id/expert-panel`.
2. The web frontend persists the panel settings summary as a normal user
   message in the active session and emits it through the session event stream.
3. The server calls the `expert_panel` tool with the question, selected panel
   options, current provider, and real session context.
4. The plugin selects requested experts or all configured experts.
5. Each expert retrieves text snippets from its own configured roots.
6. Each expert receives an independent `services.singleTurn(...)` call with its
   system prompt, question, and expert-scoped citations.
7. If `synthesize` is `true`, a final orchestrator call collates consensus,
   disagreement, assumptions, risks, and recommendation.
8. The formatted panel result is persisted as a normal assistant message and
   rendered from the same session transcript used by ordinary chat.

This keeps design, finance, and engineering knowledge isolated while still
running inside one Matbot process.

## Adding Or Changing Experts

Add an expert by editing `local-agent\config\experts.json`:

```json
{
  "id": "security",
  "title": "Security Expert",
  "description": "Threat modeling, privacy, auth, and operational security.",
  "provider": "openai",
  "roots": ["../knowledge/security"],
  "tags": ["security", "privacy"],
  "systemPrompt": "You are the Security Expert..."
}
```

Then add text files:

```powershell
mkdir local-agent\knowledge\security
```

Restart Cortex:

```powershell
.\scripts\run.ps1
```

The new expert appears in the WebUI after restart. Open the `Experts` selector
and verify it appears under `Selection`.
