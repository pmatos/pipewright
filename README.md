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
| 2 | Machine description schema and presets (`little`, `big`, `vliw4`) | |
| 3 | In-order core with scoreboard | |
| 4 | Out-of-order core (rename, ROB, issue queues, predictors) | |
| 5 | Arm PMU counters and Level 1 top-down | |
| 6 | UI: editor, config, pipeline diagram, structure tables, counters | |
| 7 | Demo programs (latency, width, branch, memory, mixed) | |

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
