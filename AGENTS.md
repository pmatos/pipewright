# AGENTS.md

Guidance for coding agents working on Pipewright. Read this before changing
anything; `README.md` covers the same ground for human readers.

## What this project is

Pipewright is a **teaching device** for CPU microarchitecture that runs in the
browser. It is not an accurate simulator of any real core, and it should not
try to be one.

The central question it answers is: *the same ISA and the same program, run on
different microarchitectures (for example a small mobile core and a wide server
core), behave differently. Which subsystems differ, and how does each one
work?* A learner should be able to step through a run cycle by cycle and see
every hardware decision (rename, wakeup, select, prediction, flush, commit)
with a plain-language explanation of what happened and why.

When a design choice trades realism against clarity, choose clarity. When it
trades features against explainability, choose explainability. Non-goals:
cycle accuracy against real chips, a full ISA, OS support, a C compiler in the
tool, multi-core coherence.

## Stack

- TypeScript (strict, `noUncheckedIndexedAccess`), Vite, React 19, Vitest.
- Static site, no backend. Deployed to GitHub Pages from `main` by
  `.github/workflows/pages.yml`: https://pmatos.github.io/pipewright/
- MIT licence. If this is ever published to npm, the name is
  `@pmatos/pipewright` (the unscoped name belongs to an unrelated project).

## Commands

```sh
npm ci              # install exactly what package-lock.json pins
npm run dev         # Vite dev server
npm test            # Vitest, run once
npm run typecheck   # tsc -p tsconfig.json
npm run build       # typecheck + static site in dist/
```

CI (`.github/workflows/ci.yml`) runs `typecheck`, `test` and `build` on every
pull request. Run all three locally before you push.

## Layout

```
src/core/        pure simulation core (see the rules below)
  isa.ts           opcode table, execution classes, register names, disassembler
  assembler.ts     two-pass assembler: labels, sections, directives, pseudo-ops
  interpreter.ts   functional interpreter: the oracle for every timing model
  memory.ts        sparse little-endian memory
  index.ts         public API of the core; re-export new modules here
src/ui/          React front end; renders snapshots produced by the core
programs/        example assembly programs (*.s), each with a golden test
tests/           Vitest suites
```

The public entry points are `assemble(src)` and
`runProgram(program, { trace })`. Timing models reuse the interpreter's
semantics through `execute(instr, state, seq)`, which returns an `ExecRecord`.

Memory map: code at `0x00010000`, data at `0x10000000`, `sp` starts at
`0x7ffffff0`. `ecall` and `ebreak` halt the program.

## Rules

### The core stays pure

Everything in `src/core` is plain TypeScript with no React, DOM or browser
APIs, and imports only sibling modules (`./foo`). `tests/purity.test.ts`
enforces this. The UI may import from the core, never the other way round.
This keeps the core testable in Node and lets the UI step backwards by
replaying.

### Timing models are checked against the interpreter

The functional interpreter is the reference. Every timing model (in-order,
out-of-order, VLIW) must retire exactly the interpreter's dynamic instruction
stream and finish with the same registers and memory, for every program in
`programs/` and every preset. Add these golden tests whenever you add a model,
a preset or a predictor. Simulations must be deterministic: two runs of the
same program on the same machine give identical traces.

### Every decision is explained

Timing models emit, per cycle, a snapshot of each structure (ROB, RAT, free
list, issue queues, scoreboard, predictor state) and a list of events. Each
event says what the hardware did and why, in plain language a student can
follow. A new mechanism is not done until its decisions show up in that
narration.

### The machine description schema is stable and documented

Cores are configured by a JSON-serialisable machine description (widths,
ports, per-class latencies, pipelined or not, ROB and register file sizes,
branch predictor, VLIW slots). Every later milestone extends it, so:

- add new fields as optional with a sensible default; do not rename or change
  the meaning of existing fields;
- validate descriptions and give readable errors;
- document every field where it is declared and in the schema docs, and keep
  presets (for example `little`/`mobile`, `big`/`server`, `vliw4`) in sync.

### Names follow Arm terminology

Counters are named after Arm PMU events: `CPU_CYCLES`, `INST_RETIRED`,
`INST_SPEC`, `OP_SPEC`, `OP_RETIRED`, `BR_MIS_PRED_RETIRED`, `STALL_SLOT`,
`STALL_SLOT_FRONTEND`, `STALL_SLOT_BACKEND`, `STALL_FRONTEND_FLUSH`,
`L1D_CACHE_REFILL`. Level 1 top-down is computed from them with Arm's
formulas. Use Arm names for structures and concepts too where one exists.

### Programs and tests

- A new example program goes in `programs/` and gets a golden test in
  `tests/programs.test.ts` that checks its result against a value computed
  independently (in TypeScript, or by hand).
- Demo programs are meant to show one bottleneck each: latency, width,
  branch prediction, memory, or a mix. Say in a comment at the top of the
  file which one, and what the learner should see.
- Do not skip, disable or loosen a test to get green.

### Style

- Keep modules small and readable; this code is itself teaching material.
  Comment the *why* of each hardware mechanism, citing the classic design
  it follows (for example the MIPS R10000 merged register file) where useful.
- Prefer clear data structures over clever ones; performance matters only as
  far as the UI stays responsive on the demo programs.
- Kanata trace export (for the Konata viewer) is part of v1; keep per-cycle
  stage data rich enough to produce it.

## Roadmap

Build in milestone order. Each milestone ends with passing tests and an
updated status column in `README.md`.

| # | Milestone |
|---|-----------|
| 1 | Assembler and functional interpreter (the test oracle) |
| 2 | Machine description schema and presets |
| 3 | In-order core with scoreboard |
| 4 | Out-of-order core: rename, ROB, issue queues, wakeup/select, predictors |
| 5 | Arm PMU counters and Level 1 top-down |
| 6 | UI: editor, config, pipeline diagram, structure tables, counters, side-by-side compare |
| 7 | Demo programs (latency, width, branch, memory, mixed) |

Later phases, roughly in order: VLIW policy with typed slots and the
`{ op ; op }` bundle syntax; caches, MSHRs, prefetcher and load-store queue;
a richer frontend (BTB, return stack, TAGE-lite); big vs little presets with
an energy proxy; top-down Level 2; feeding in real `clang --target=riscv32`
output.

The `README.md` roadmap table is the source of truth for what is done.
