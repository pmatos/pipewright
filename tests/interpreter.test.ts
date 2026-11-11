import { describe, expect, it } from 'vitest';
import { DATA_BASE, Interpreter, STACK_TOP, assemble, runProgram, type RunResult } from '../src/core';

/** Run a snippet and return the final registers by ABI name. */
function run(src: string, maxSteps?: number): RunResult {
  return runProgram(assemble(src), { maxSteps, trace: true });
}
const reg = (r: RunResult, n: number) => r.state.regs[n]!;
const A0 = 10;
const A1 = 11;

/** Evaluate `op a0, a1, a2` with the given inputs. */
function rrr(op: string, x: number, y: number): number {
  return reg(run(`li a1, ${x}\nli a2, ${y}\n${op} a0, a1, a2\necall`), A0);
}
function rri(op: string, x: number, imm: number): number {
  return reg(run(`li a1, ${x}\n${op} a0, a1, ${imm}\necall`), A0);
}

const MIN = -0x80000000;

describe('interpreter: ALU', () => {
  it.each([
    ['add', 5, 7, 12],
    ['add', 0x7fffffff, 1, MIN],
    ['sub', 5, 7, -2],
    ['sub', MIN, 1, 0x7fffffff],
    ['and', 0b1100, 0b1010, 0b1000],
    ['or', 0b1100, 0b1010, 0b1110],
    ['xor', 0b1100, 0b1010, 0b0110],
    ['sll', 1, 31, MIN],
    ['sll', 1, 33, 2], // only the low 5 bits of the shift amount count
    ['srl', -1, 28, 0xf],
    ['sra', -16, 2, -4],
    ['slt', -1, 1, 1],
    ['slt', 1, -1, 0],
    ['sltu', -1, 1, 0],
    ['sltu', 1, -1, 1],
  ])('%s %d, %d = %d', (op, x, y, want) => {
    expect(rrr(op, x, y)).toBe(want);
  });

  it.each([
    ['addi', 10, -11, -1],
    ['slti', -5, -4, 1],
    ['sltiu', 5, -1, 1], // -1 is compared as 0xffffffff
    ['xori', 0xff, -1, ~0xff],
    ['ori', 0xf0, 0x0f, 0xff],
    ['andi', -1, 0x7f0, 0x7f0],
    ['slli', 3, 4, 48],
    ['srli', MIN, 31, 1],
    ['srai', MIN, 31, -1],
  ])('%s %d, %d = %d', (op, x, imm, want) => {
    expect(rri(op, x, imm)).toBe(want);
  });

  it('lui and auipc', () => {
    const r = run('lui a0, 0x12345\nauipc a1, 1\necall');
    expect(reg(r, A0)).toBe(0x12345000);
    expect(reg(r, A1)).toBe(0x00010004 + 0x1000);
  });

  it('keeps x0 at zero', () => {
    const r = run('addi zero, zero, 5\nadd a0, zero, zero\necall');
    expect(reg(r, 0)).toBe(0);
    expect(reg(r, A0)).toBe(0);
  });
});

describe('interpreter: M extension', () => {
  it.each([
    ['mul', 7, -6, -42],
    ['mul', 0x10000, 0x10000, 0], // low 32 bits only
    ['mulh', 0x10000, 0x10000, 1],
    ['mulh', -1, -1, 0],
    ['mulh', MIN, MIN, 0x40000000],
    ['mulhu', -1, -1, -2], // 0xffffffff * 0xffffffff >> 32 = 0xfffffffe
    ['mulhsu', -1, -1, -1], // -1 * 0xffffffff >> 32 = -1
    ['mulhsu', 2, -1, 1],
    ['div', 20, -6, -3], // truncates towards zero
    ['div', -20, 6, -3],
    ['div', 5, 0, -1],
    ['div', MIN, -1, MIN],
    ['divu', -1, 2, 0x7fffffff],
    ['divu', 5, 0, -1],
    ['rem', 20, -6, 2],
    ['rem', -20, 6, -2],
    ['rem', 5, 0, 5],
    ['rem', MIN, -1, 0],
    ['remu', -1, 10, 5], // 4294967295 % 10
    ['remu', 5, 0, 5],
  ])('%s %d, %d = %d', (op, x, y, want) => {
    expect(rrr(op, x, y)).toBe(want);
  });
});

describe('interpreter: memory', () => {
  const prog = `
    .data
    v: .word 0x80ff7f01
    .text
    la  t0, v
    lb  a0, 0(t0)
    lb  a1, 3(t0)
    lbu a2, 3(t0)
    lh  a3, 2(t0)
    lhu a4, 2(t0)
    lw  a5, 0(t0)
    ecall
  `;

  it('sign- and zero-extends loads', () => {
    const r = run(prog);
    expect(Array.from(r.state.regs.slice(10, 16))).toEqual([1, -128, 0x80, -32513, 0x80ff, 0x80ff7f01 | 0]);
  });

  it('stores bytes, halves and words little-endian', () => {
    const r = run(`
      li t0, ${DATA_BASE}
      li t1, 0x11223344
      sw t1, 0(t0)
      sh t1, 4(t0)
      sb t1, 7(t0)
      ecall
    `);
    expect([...r.state.mem.readBytes(DATA_BASE, 8)]).toEqual([0x44, 0x33, 0x22, 0x11, 0x44, 0x33, 0x00, 0x44]);
  });

  it('records effective addresses and values', () => {
    const r = run(prog);
    const loads = r.trace.filter((t) => t.memAddr !== undefined);
    expect(loads.map((t) => t.memAddr! - DATA_BASE)).toEqual([0, 3, 3, 2, 2, 0]);
    expect(loads[2]!.memValue).toBe(0x80);
  });

  it('initialises sp to the stack top and reads untouched memory as 0', () => {
    const r = run('mv a0, sp\nlw a1, -4(sp)\necall');
    expect(reg(r, A0)).toBe(STACK_TOP);
    expect(reg(r, A1)).toBe(0);
  });
});

describe('interpreter: control flow', () => {
  it.each([
    ['beq', 3, 3, true],
    ['beq', 3, 4, false],
    ['bne', 3, 4, true],
    ['blt', -1, 0, true],
    ['blt', 0, -1, false],
    ['bge', 0, 0, true],
    ['bltu', 0, -1, true],
    ['bgeu', -1, 0, true],
    ['bgeu', 0, -1, false],
  ])('%s %d, %d taken=%s', (op, x, y, taken) => {
    const r = run(`li a1, ${x}\nli a2, ${y}\n${op} a1, a2, yes\nli a0, 1\necall\nyes: li a0, 2\necall`);
    expect(reg(r, A0)).toBe(taken ? 2 : 1);
    expect(r.trace.find((t) => t.instr.op === op)!.taken).toBe(taken);
  });

  it('jal and jalr link and jump, and jalr clears bit 0', () => {
    const r = run(`
      main: jal  f
            mv   s0, a0
            la   t0, g
            addi t0, t0, 1     # odd address: jalr must clear bit 0
            jalr t0
            ecall
      f:    li   a0, 42
            ret
      g:    addi a0, a0, 1
            ret
    `);
    expect(reg(r, 8)).toBe(42);
    expect(reg(r, A0)).toBe(43);
    expect(r.halt).toBe('ecall');
  });
});

describe('interpreter: halting', () => {
  it('stops on ecall, ebreak, falling off the end, a bad pc and the step limit', () => {
    expect(run('nop\necall\nnop').halt).toBe('ecall');
    expect(run('ebreak').halt).toBe('ebreak');
    expect(run('nop\nnop').halt).toBe('end');
    expect(run('li t0, 0x100\njr t0').halt).toBe('bad-pc');
    const loop = run('l: j l', 50);
    expect(loop.halt).toBe('limit');
    expect(loop.retired).toBe(50);
  });

  it('counts the ecall as retired and does nothing after halting', () => {
    const it = new Interpreter(assemble('nop\necall\nnop'));
    expect(it.run().retired).toBe(2);
    expect(it.step()).toBeNull();
  });

  it('produces a trace with sequence numbers and next PCs', () => {
    const r = run('li a0, 3\nl: addi a0, a0, -1\nbnez a0, l\necall');
    expect(r.trace.map((t) => t.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(r.trace.filter((t) => t.taken !== undefined).map((t) => t.taken)).toEqual([true, true, false]);
    for (let k = 1; k < r.trace.length; k++) expect(r.trace[k]!.pc).toBe(r.trace[k - 1]!.nextPc);
  });
});
