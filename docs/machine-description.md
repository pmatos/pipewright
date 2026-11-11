# Machine description

A core is described by one JSON-serialisable object, `MachineDesc`
(`src/core/machine.ts`). Every timing model reads it. New fields are added as
optional with a default. Existing fields are never renamed and never change
meaning. `validateMachine` checks a description and returns readable errors.

## Fields

| Field | Type | Meaning |
|-------|------|---------|
| `name` | string | Short name shown in the UI. |
| `description` | string, optional | One paragraph on the design point. |
| `policy` | `'ooo'` | Scheduling policy. Only out-of-order exists so far. |
| `width.fetch` | integer >= 1 | Instructions fetched per cycle. |
| `width.rename` | integer >= 1 | Instructions renamed and dispatched per cycle. |
| `width.commit` | integer >= 1 | Instructions retired per cycle. |
| `rob` | integer >= 1 | Reorder buffer entries. |
| `iq` | integer >= 1 | Unified issue queue entries. |
| `physRegs` | integer >= 33 | Physical registers. 32 hold committed state, the rest can be in flight. |
| `fetchBuffer` | integer >= 1 | Entries in the fetch buffer and the decode queue. |
| `ports` | list, non-empty | Execution ports. Each issues at most one instruction per cycle. |
| `ports[].name` | string | Unique name of the port. |
| `ports[].classes` | list of class names | Classes that the port can execute. |
| `latency` | object | Execution latency in cycles for each class. Each value is an integer >= 1. |
| `pipelined` | object | For each class, `true` if a new operation can start every cycle. `false` keeps the unit busy for the whole latency, as a divider does. |
| `branchPredictor.kind` | `none`, `not-taken`, `btfn`, `bimodal`, `gshare` | Direction predictor. |
| `branchPredictor.tableBits` | integer 1..16 | log2 of the pattern history table size (`bimodal`, `gshare`). |
| `branchPredictor.historyBits` | integer 1..16 | Global history length (`gshare`). |
| `branchPredictor.rasDepth` | integer >= 0 | Return address stack depth. 0 turns it off. |
| `redirectPenalty` | integer >= 0 | Extra fetch bubble cycles after a mispredict redirect. |

The operation classes are `alu`, `mul`, `div`, `load`, `store`, `branch`,
`jump` and `system`. Every class needs a latency, a `pipelined` flag and at
least one port that can run it.

## Presets

| Preset | Idea |
|--------|------|
| `teaching` | Two-wide, 16-entry ROB. Every structure fits on screen. |
| `narrow` | One-wide, 8-entry window. Shows how little a narrow core overlaps. |
| `mobile` | Three-wide phone-class core with a small bimodal predictor. |
| `server` | Eight-wide server-class core with a 192-entry ROB and a gshare predictor. |

Keep this page and the presets in `machine.ts` in sync when a field is added.
