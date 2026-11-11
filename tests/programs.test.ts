import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemble, runProgram } from '../src/core';

const dir = join(__dirname, '..', 'programs');
const load = (name: string) => assemble(readFileSync(join(dir, name), 'utf8'));

/** Reference Collatz total, computed in TypeScript. */
function collatzTotal(limit: number): number {
  let total = 0;
  for (let n = 1; n <= limit; n++) {
    for (let x = n; x !== 1; x = x % 2 === 0 ? x / 2 : 3 * x + 1) total++;
  }
  return total;
}

describe('example programs', () => {
  it('every program in programs/ assembles and halts on ecall', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.s'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(runProgram(load(f)).halt, f).toBe('ecall');
  });

  it('factorial(10)', () => {
    const r = runProgram(load('factorial.s'));
    expect(r.state.regs[10]).toBe(3628800);
    // The stack is balanced on return.
    expect(r.state.regs[2]).toBe(runProgram(load('factorial.s'), { maxSteps: 0 }).state.regs[2]);
  });

  it('bubble sort', () => {
    const p = load('bubble_sort.s');
    const r = runProgram(p);
    const base = p.symbols.get('arr')!;
    const out = Array.from({ length: 10 }, (_, k) => r.state.mem.read32(base + 4 * k));
    expect(out).toEqual([-8, -3, 0, 1, 2, 4, 5, 7, 9, 12]);
  });

  it('strlen', () => {
    expect(runProgram(load('strlen.s')).state.regs[10]).toBe(26);
  });

  it('collatz', () => {
    expect(collatzTotal(100)).toBe(3142);
    expect(runProgram(load('collatz.s')).state.regs[10]).toBe(3142);
  });

  it('is deterministic: two runs give identical traces and memory', () => {
    const a = runProgram(load('bubble_sort.s'), { trace: true });
    const b = runProgram(load('bubble_sort.s'), { trace: true });
    expect(a.trace).toEqual(b.trace);
    expect(a.state.mem.nonZeroBytes()).toEqual(b.state.mem.nonZeroBytes());
  });
});
