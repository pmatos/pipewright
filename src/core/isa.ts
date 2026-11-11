/**
 * The Pipewright ISA: an RV32IM subset.
 *
 * Covered: all RV32I computational, load/store, branch and jump
 * instructions, the full M extension, plus ECALL/EBREAK as "halt".
 * Not covered: FENCE, CSR instructions, compressed encodings.
 *
 * Instructions are kept in decoded form. The timing models only need the
 * operation, its register operands, its immediate and its execution class.
 */

/** Execution class. Machine descriptions map latencies and ports by class. */
export type OpClass = 'alu' | 'mul' | 'div' | 'load' | 'store' | 'branch' | 'jump' | 'system';

/** Operand shape, used by the assembler to parse and by the UI to print. */
export type Format =
  | 'R' //    op rd, rs1, rs2
  | 'I' //    op rd, rs1, imm
  | 'SH' //   op rd, rs1, shamt
  | 'LOAD' // op rd, imm(rs1)
  | 'S' //    op rs2, imm(rs1)
  | 'B' //    op rs1, rs2, label
  | 'U' //    op rd, imm20
  | 'J' //    op rd, label
  | 'JR' //   jalr rd, imm(rs1)  (also: jalr rs1 / jalr rd, rs1, imm)
  | 'N'; //   op

export const OPCODES = {
  // RV32I: upper immediates
  lui: { format: 'U', cls: 'alu' },
  auipc: { format: 'U', cls: 'alu' },
  // RV32I: register-immediate
  addi: { format: 'I', cls: 'alu' },
  slti: { format: 'I', cls: 'alu' },
  sltiu: { format: 'I', cls: 'alu' },
  xori: { format: 'I', cls: 'alu' },
  ori: { format: 'I', cls: 'alu' },
  andi: { format: 'I', cls: 'alu' },
  slli: { format: 'SH', cls: 'alu' },
  srli: { format: 'SH', cls: 'alu' },
  srai: { format: 'SH', cls: 'alu' },
  // RV32I: register-register
  add: { format: 'R', cls: 'alu' },
  sub: { format: 'R', cls: 'alu' },
  sll: { format: 'R', cls: 'alu' },
  slt: { format: 'R', cls: 'alu' },
  sltu: { format: 'R', cls: 'alu' },
  xor: { format: 'R', cls: 'alu' },
  srl: { format: 'R', cls: 'alu' },
  sra: { format: 'R', cls: 'alu' },
  or: { format: 'R', cls: 'alu' },
  and: { format: 'R', cls: 'alu' },
  // RV32M
  mul: { format: 'R', cls: 'mul' },
  mulh: { format: 'R', cls: 'mul' },
  mulhsu: { format: 'R', cls: 'mul' },
  mulhu: { format: 'R', cls: 'mul' },
  div: { format: 'R', cls: 'div' },
  divu: { format: 'R', cls: 'div' },
  rem: { format: 'R', cls: 'div' },
  remu: { format: 'R', cls: 'div' },
  // RV32I: loads and stores
  lb: { format: 'LOAD', cls: 'load' },
  lh: { format: 'LOAD', cls: 'load' },
  lw: { format: 'LOAD', cls: 'load' },
  lbu: { format: 'LOAD', cls: 'load' },
  lhu: { format: 'LOAD', cls: 'load' },
  sb: { format: 'S', cls: 'store' },
  sh: { format: 'S', cls: 'store' },
  sw: { format: 'S', cls: 'store' },
  // RV32I: control flow
  beq: { format: 'B', cls: 'branch' },
  bne: { format: 'B', cls: 'branch' },
  blt: { format: 'B', cls: 'branch' },
  bge: { format: 'B', cls: 'branch' },
  bltu: { format: 'B', cls: 'branch' },
  bgeu: { format: 'B', cls: 'branch' },
  jal: { format: 'J', cls: 'jump' },
  jalr: { format: 'JR', cls: 'jump' },
  // System: both halt the machine in Pipewright.
  ecall: { format: 'N', cls: 'system' },
  ebreak: { format: 'N', cls: 'system' },
} as const satisfies Record<string, { format: Format; cls: OpClass }>;

export type Opcode = keyof typeof OPCODES;

export function isOpcode(s: string): s is Opcode {
  return Object.prototype.hasOwnProperty.call(OPCODES, s);
}

/** A decoded instruction placed at an address. */
export interface Instr {
  op: Opcode;
  /** Destination register, 0 if none (writes to x0 are discarded anyway). */
  rd: number;
  rs1: number;
  rs2: number;
  /**
   * Immediate. For branches and JAL this is the PC-relative byte offset,
   * as in the real encoding. For LUI/AUIPC it is the 20-bit upper value.
   */
  imm: number;
  /** Byte address of this instruction. */
  pc: number;
  /** 1-based source line it came from. */
  line: number;
  /** Source text it came from (a pseudo-instruction may expand to several). */
  source: string;
}

export function opClass(op: Opcode): OpClass {
  return OPCODES[op].cls;
}

/** Registers each instruction reads, used by dependency tracking in the cores. */
export function sourceRegs(i: Instr): number[] {
  switch (OPCODES[i.op].format) {
    case 'R':
    case 'S':
    case 'B':
      return [i.rs1, i.rs2];
    case 'I':
    case 'SH':
    case 'LOAD':
    case 'JR':
      return [i.rs1];
    case 'U':
    case 'J':
    case 'N':
      return [];
  }
}

/** Register written by an instruction, or null if none (or x0). */
export function destReg(i: Instr): number | null {
  switch (OPCODES[i.op].format) {
    case 'S':
    case 'B':
    case 'N':
      return null;
    default:
      return i.rd === 0 ? null : i.rd;
  }
}

export const ABI_NAMES = [
  'zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2',
  's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5',
  'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7',
  's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6',
] as const;

const REG_BY_NAME: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  ABI_NAMES.forEach((n, i) => m.set(n, i));
  for (let i = 0; i < 32; i++) m.set(`x${i}`, i);
  m.set('fp', 8);
  return m;
})();

export function parseReg(name: string): number | undefined {
  return REG_BY_NAME.get(name.toLowerCase());
}

export function regName(r: number): string {
  return ABI_NAMES[r] ?? `x${r}`;
}

/** Disassemble a decoded instruction back to canonical text. */
export function formatInstr(i: Instr): string {
  const r = regName;
  switch (OPCODES[i.op].format) {
    case 'R':
      return `${i.op} ${r(i.rd)}, ${r(i.rs1)}, ${r(i.rs2)}`;
    case 'I':
    case 'SH':
      return `${i.op} ${r(i.rd)}, ${r(i.rs1)}, ${i.imm}`;
    case 'LOAD':
      return `${i.op} ${r(i.rd)}, ${i.imm}(${r(i.rs1)})`;
    case 'S':
      return `${i.op} ${r(i.rs2)}, ${i.imm}(${r(i.rs1)})`;
    case 'B':
      return `${i.op} ${r(i.rs1)}, ${r(i.rs2)}, ${hex(i.pc + i.imm)}`;
    case 'U':
      return `${i.op} ${r(i.rd)}, ${hex(i.imm)}`;
    case 'J':
      return `${i.op} ${r(i.rd)}, ${hex(i.pc + i.imm)}`;
    case 'JR':
      return `${i.op} ${r(i.rd)}, ${i.imm}(${r(i.rs1)})`;
    case 'N':
      return i.op;
  }
}

export function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16);
}
