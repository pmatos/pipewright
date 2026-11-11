# Pipewright

A browser-based, configurable CPU microarchitecture simulator for learning
performance engineering by building and watching cores run.

**Live:** https://pmatos.github.io/pipewright/ (deployed from `main` by GitHub Actions)

## Goal

Make microarchitecture and performance counters something you can explain from
first-hand experience: register renaming, scoreboards and wakeup/select, branch
prediction, in-order vs out-of-order vs VLIW, big vs little cores, and Arm PMU
top-down analysis. Pipewright is a study instrument first and a portfolio piece
second.

## Scope for v1

- Runs entirely in the browser as a static page; no backend.
- ISA: an RV32IM subset plus a VLIW bundle syntax.
- One simulation core with three scheduling policies (in-order with
  scoreboard, out-of-order with rename and ROB, VLIW), selected by a JSON
  machine description.
- Configurable widths, ports, per-class latencies, pipelined or not, ROB and
  register file sizes, and branch predictor (off, static, bimodal, gshare).
- Cycle-by-cycle stepping with a pipeline diagram and views of the RAT, free
  list, ROB, issue queues and scoreboard.
- Counters named after Arm PMU events, with Level 1 top-down computed from them.
- Presets for a little, a big and a VLIW core, and a side-by-side mode.
- Kanata trace export so [Konata](https://github.com/shioyadan/Konata) can view runs.

**Non-goals:** cycle accuracy against any real core, a full ISA or OS support, a
C compiler inside the tool (use external clang output), multi-core coherence.

## Roadmap

| # | Milestone | Status |
|---|-----------|--------|
| 1 | Assembler and functional interpreter (the test oracle) | done |
| 2 | Machine description schema and presets | OoO presets done (`teaching`, `narrow`, `mobile`, `server`); `vliw4` pending |
| 3 | In-order core with scoreboard | |
| 4 | Out-of-order core (rename, ROB, issue queues, predictors) | done, with per-cycle explanations |
| 5 | Arm PMU counters and Level 1 top-down | partial: core counters and a slot-based top-down bar |
| 6 | UI: editor, config, pipeline diagram, structure tables, counters | done: step-through teaching UI and compare mode |
| 7 | Demo programs (latency, width, branch, memory, mixed) | partial: rename, chain, independent, branch, forwarding |

## Using it to learn

**Step through** loads a program on one core. Step forward and back a cycle at a
time (← →, space to play). For every cycle the narration panel says what each
stage did and why: which physical register a write was renamed to, why an
instruction is still waiting in the issue queue and for whom, which tag a result
broadcast and who it woke up, how a branch was predicted, and what a mispredict
squashed and restored. Hover or click any `#n` instruction or `pN` register to
highlight it everywhere and follow its life in the inspector. Each structure
panel has a "What is this?" note.

**Compare two cores** runs the same program on two machine descriptions, for
example the `mobile` and `server` presets, and shows cycles, IPC, mispredicts,
a top-down breakdown of where the rename slots went, and how each parameter of
the two designs differs and what it costs. A shared cycle slider steps both
pipelines side by side.

## The out-of-order core

`src/core/ooo.ts` models a merged-register-file core in the style of the MIPS
R10000 and today's big Arm cores:

- **Fetch** up to `width.fetch` per cycle, ending a group at a predicted-taken
  branch. Predictors: `none` (fetch waits for every branch), `not-taken`,
  `btfn`, `bimodal`, `gshare`, plus a return address stack. Direct jumps are
  followed at fetch; other indirect jumps wait for their target.
- **Rename** through a RAT and a free list; every control instruction
  checkpoints the RAT. **Dispatch** into the ROB and a unified issue queue.
  Back-pressure from a full ROB, issue queue or free list stalls rename.
- **Issue**: per port, the oldest instruction whose source tags are ready
  (wakeup happens at writeback, so dependents issue back to back). Non-pipelined
  units block their port. Loads wait until all older store addresses are known,
  then take bytes from older in-flight stores (forwarding) or memory.
- **Writeback** broadcasts tags and resolves branches; a mispredict squashes
  everything younger, returns their registers, restores the RAT, history and
  return stack, and redirects fetch.
- **Commit** in order, up to `width.commit` per cycle: frees the previous
  mapping, writes stores to memory, trains the predictor.

Values are real, so the golden tests check that every program on every preset
and predictor retires exactly the interpreter's instruction stream and ends in
the same registers and memory. The core is a teaching model, not a model of
any real chip.

## Development

```sh
npm install
npm run dev        # Vite dev server
npm test           # Vitest
npm run typecheck
npm run build      # static site in dist/
```

### Layout

```
src/core/      pure simulation core: no React, DOM or UI imports (enforced by tests/purity.test.ts)
  isa.ts         opcode table, execution classes, register names, disassembler
  assembler.ts   two-pass assembler: labels, sections, data directives, pseudo-instructions
  interpreter.ts functional interpreter, the oracle for every timing model
  memory.ts      sparse little-endian memory
  machine.ts     machine description schema, presets and validation
  ooo.ts         out-of-order core: per-cycle snapshots and explained events
src/ui/        React front end (renders snapshots from the core)
programs/      example assembly programs, each with a golden test
tests/         Vitest suites
```

## The assembly language

GNU-as-flavoured RV32IM. Code is placed at `0x00010000`, data at
`0x10000000`, `sp` starts at `0x7ffffff0`. Execution starts at `_start`, else
`main`, else the first instruction, and stops at `ecall`/`ebreak` or when it
falls off the end of the code.

- **Instructions:** all RV32I computational, load/store, branch and jump
  instructions and the whole M extension. No FENCE, CSRs or compressed forms.
- **Pseudo-instructions:** `nop li la mv not neg seqz snez sltz sgtz beqz bnez
  blez bgez bltz bgtz bgt ble bgtu bleu j jal(1 operand) jr jalr(1 operand) ret
  call tail`, and `lw rd, symbol` style loads.
- **Directives:** `.text .data .rodata .bss .section .word .long .half .short
  .byte .ascii .asciz .string .space .zero .align .p2align .balign .equ .set`;
  `.globl` and friends are accepted and ignored.
- **Expressions:** decimal, hex, binary and character literals, symbols,
  parentheses, `* / + - << >>`, `%hi()` and `%lo()`.
- **Comments:** `#` or `//`.

The VLIW `{ op ; op }` bundle syntax arrives with the VLIW milestone.

## Licence

[MIT](LICENSE)
