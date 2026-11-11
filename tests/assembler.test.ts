import { describe, expect, it } from 'vitest';
import { AssemblerError, DATA_BASE, TEXT_BASE, assemble, formatInstr, hi20, lo12 } from '../src/core';

const text = (src: string) => assemble(src).instrs.map(formatInstr);

describe('assembler: instructions', () => {
  it('assembles every operand format', () => {
    expect(
      text(`
        add  a0, a1, a2
        addi t0, zero, -5
        slli s1, s0, 31
        lw   a0, 8(sp)
        lw   a0, (sp)
        sw   ra, -4(sp)
        lui  a0, 0xfffff
        jalr ra, 0(t0)
        jalr t1, t2, 12
        jalr t0
        ecall
        ebreak
      `),
    ).toEqual([
      'add a0, a1, a2',
      'addi t0, zero, -5',
      'slli s1, s0, 31',
      'lw a0, 8(sp)',
      'lw a0, 0(sp)',
      'sw ra, -4(sp)',
      'lui a0, 0xfffff',
      'jalr ra, 0(t0)',
      'jalr t1, 12(t2)',
      'jalr ra, 0(t0)',
      'ecall',
      'ebreak',
    ]);
  });

  it('accepts x-names, ABI names and fp', () => {
    const [i] = assemble('add x5, fp, s0').instrs;
    expect([i!.rd, i!.rs1, i!.rs2]).toEqual([5, 8, 8]);
  });

  it('lays out instructions from TEXT_BASE, 4 bytes apart', () => {
    const p = assemble('nop\nnop\nnop');
    expect(p.instrs.map((i) => i.pc)).toEqual([TEXT_BASE, TEXT_BASE + 4, TEXT_BASE + 8]);
  });

  it('resolves backward and forward labels to PC-relative offsets', () => {
    const p = assemble(`
      top:  addi a0, a0, 1
            bne  a0, a1, top
            beq  a0, a1, done
            j    top
      done: ecall
    `);
    expect(p.instrs.map((i) => i.imm)).toEqual([1, -4, 8, -12, 0]);
    expect(p.symbols.get('done')).toBe(TEXT_BASE + 16);
  });

  it('uses _start, then main, then TEXT_BASE as the entry point', () => {
    expect(assemble('nop').entry).toBe(TEXT_BASE);
    expect(assemble('nop\nmain: nop').entry).toBe(TEXT_BASE + 4);
    expect(assemble('nop\nmain: nop\n_start: nop').entry).toBe(TEXT_BASE + 8);
  });

  it('allows several labels on one line and a label on its own line', () => {
    const p = assemble('a: b:\nc: nop');
    expect([p.symbols.get('a'), p.symbols.get('b'), p.symbols.get('c')]).toEqual([TEXT_BASE, TEXT_BASE, TEXT_BASE]);
  });

  it('strips # and // comments but not inside strings', () => {
    const p = assemble('.data\ns: .asciz "a#b//c" # comment\n.text\nnop // another');
    expect(new TextDecoder().decode(p.data)).toBe('a#b//c\0');
    expect(p.instrs).toHaveLength(1);
  });
});

describe('assembler: pseudo-instructions', () => {
  it('expands the simple ones', () => {
    expect(
      text(`
        nop
        mv   a0, a1
        not  a0, a1
        neg  a0, a1
        seqz a0, a1
        snez a0, a1
        sltz a0, a1
        sgtz a0, a1
        jr   t0
        ret
      `),
    ).toEqual([
      'addi zero, zero, 0',
      'addi a0, a1, 0',
      'xori a0, a1, -1',
      'sub a0, zero, a1',
      'sltiu a0, a1, 1',
      'sltu a0, zero, a1',
      'slt a0, a1, zero',
      'slt a0, zero, a1',
      'jalr zero, 0(t0)',
      'jalr zero, 0(ra)',
    ]);
  });

  it('expands branch pseudos with swapped or zero operands', () => {
    const p = assemble(`
      L: beqz a0, L
         bnez a0, L
         blez a0, L
         bgez a0, L
         bltz a0, L
         bgtz a0, L
         bgt  a0, a1, L
         ble  a0, a1, L
         bgtu a0, a1, L
         bleu a0, a1, L
    `);
    expect(p.instrs.map((i) => [i.op, i.rs1, i.rs2])).toEqual([
      ['beq', 10, 0],
      ['bne', 10, 0],
      ['bge', 0, 10],
      ['bge', 10, 0],
      ['blt', 10, 0],
      ['blt', 0, 10],
      ['blt', 11, 10],
      ['bge', 11, 10],
      ['bltu', 11, 10],
      ['bgeu', 11, 10],
    ]);
  });

  it('expands j, jal, call and tail', () => {
    const p = assemble('f: j f\njal f\ncall f\ntail f\njal t0, f');
    expect(p.instrs.map((i) => [i.op, i.rd, i.imm])).toEqual([
      ['jal', 0, 0],
      ['jal', 1, -4],
      ['jal', 1, -8],
      ['jal', 0, -12],
      ['jal', 5, -16],
    ]);
  });

  it('picks the shortest li expansion', () => {
    expect(text('li a0, 2047')).toEqual(['addi a0, zero, 2047']);
    expect(text('li a0, -2048')).toEqual(['addi a0, zero, -2048']);
    expect(text('li a0, 0x12345000')).toEqual(['lui a0, 0x12345']);
    expect(text('li a0, 0x12345678')).toEqual(['lui a0, 0x12345', 'addi a0, a0, 1656']);
    // Low half has its sign bit set, so the upper half is rounded up.
    expect(text('li a0, 0xdeadbeef')).toEqual(['lui a0, 0xdeadc', 'addi a0, a0, -273']);
    expect(text('li a0, -1')).toEqual(['addi a0, zero, -1']);
  });

  it('expands la and lw-from-symbol to absolute lui pairs', () => {
    const p = assemble('.data\n.space 0x800\nx: .word 7\n.text\nla a0, x\nlw a1, x');
    const addr = DATA_BASE + 0x800;
    expect(p.instrs.map(formatInstr)).toEqual([
      `lui a0, 0x${hi20(addr).toString(16)}`,
      `addi a0, a0, ${lo12(addr)}`,
      `lui a1, 0x${hi20(addr).toString(16)}`,
      `lw a1, ${lo12(addr)}(a1)`,
    ]);
    // Instructions after a two-instruction pseudo land at the right address.
    expect(p.instrs.map((i) => i.pc - TEXT_BASE)).toEqual([0, 4, 8, 12]);
  });

  it('sizes li with a forward symbol as two instructions', () => {
    const p = assemble('li a0, later\nlater: nop');
    expect(p.instrs).toHaveLength(3);
    expect(p.symbols.get('later')).toBe(TEXT_BASE + 8);
  });

  it('supports %hi/%lo relocations and expressions', () => {
    const p = assemble('.data\n.word 0\nv: .word 0\n.text\nlui a0, %hi(v+4)\naddi a0, a0, %lo(v+4)\nlw a1, %lo(v)(a0)');
    expect(p.instrs[0]!.imm).toBe(hi20(DATA_BASE + 8));
    expect(p.instrs[1]!.imm).toBe(lo12(DATA_BASE + 8));
    expect(p.instrs[2]!.imm).toBe(lo12(DATA_BASE + 4));
  });
});

describe('assembler: data', () => {
  it('lays out .word/.half/.byte little-endian with symbols resolved', () => {
    const p = assemble(`
      .data
      w: .word 0x11223344, -1, w
      h: .half 0xbeef
      b: .byte 1, 2, 'A'
    `);
    expect([...p.data]).toEqual([
      0x44, 0x33, 0x22, 0x11, 0xff, 0xff, 0xff, 0xff,
      0x00, 0x00, 0x00, 0x10,
      0xef, 0xbe,
      1, 2, 65,
    ]);
    expect(p.symbols.get('h')).toBe(DATA_BASE + 12);
    expect(p.symbols.get('b')).toBe(DATA_BASE + 14);
  });

  it('handles .ascii, .asciz, .string, escapes, .space and .zero', () => {
    const p = assemble('.data\n.ascii "hi"\n.asciz "a\\n"\n.string "z"\n.space 2\n.zero 1');
    expect([...p.data]).toEqual([104, 105, 97, 10, 0, 122, 0, 0, 0, 0]);
  });

  it('aligns with .align (power of two) and .balign (bytes)', () => {
    const p = assemble('.data\n.byte 1\n.align 2\nx: .word 2\n.byte 3\n.balign 8\ny: .byte 4');
    expect(p.symbols.get('x')).toBe(DATA_BASE + 4);
    expect(p.symbols.get('y')).toBe(DATA_BASE + 16);
  });

  it('supports .equ constants in data and code', () => {
    const p = assemble('.equ N, 4\n.data\nbuf: .space N*1+N\n.text\nli a0, N\naddi a1, a0, N-1');
    expect(p.data.length).toBe(8);
    expect(p.instrs.map(formatInstr)).toEqual(['addi a0, zero, 4', 'addi a1, a0, 3']);
  });

  it('switches sections back and forth', () => {
    const p = assemble('.data\na: .word 1\n.text\nnop\n.section .rodata\nb: .word 2\n.section .text\nnop');
    expect(p.instrs).toHaveLength(2);
    expect(p.symbols.get('b')).toBe(DATA_BASE + 4);
  });
});

describe('assembler: errors', () => {
  const errors = (src: string) => {
    try {
      assemble(src);
    } catch (e) {
      if (e instanceof AssemblerError) return e.diagnostics;
      throw e;
    }
    throw new Error('expected an AssemblerError');
  };

  it('reports every bad line with its line number', () => {
    expect(errors('nop\nfoo a0\nadd a0, a1\nbeq a0, a1, nowhere')).toEqual([
      { line: 2, message: "unknown instruction 'foo'" },
      { line: 3, message: "'add' expects 3 operands, got 2" },
      { line: 4, message: "undefined symbol 'nowhere'" },
    ]);
  });

  it('range-checks immediates', () => {
    expect(errors('addi a0, a0, 2048')[0]!.message).toMatch(/out of range/);
    expect(errors('slli a0, a0, 32')[0]!.message).toMatch(/out of range/);
    expect(errors('lui a0, 0x100000')[0]!.message).toMatch(/out of range/);
    expect(errors('.data\n.byte 256')[0]!.message).toMatch(/does not fit/);
  });

  it('rejects bad registers, duplicate labels and misplaced code', () => {
    expect(errors('add a0, a1, x32')[0]!.message).toMatch(/expected register/);
    expect(errors('x: nop\nx: nop')[0]).toEqual({ line: 2, message: "symbol 'x' redefined" });
    expect(errors('.data\nadd a0, a0, a0')[0]!.message).toMatch(/outside .text/);
    expect(errors('.word 1')[0]!.message).toMatch(/in .text/);
  });

  it('rejects branch targets out of range', () => {
    expect(errors('beq a0, a0, far\n.space 0\n' + 'nop\n'.repeat(1100) + 'far: nop')[0]!.message).toMatch(/out of range/);
  });
});
