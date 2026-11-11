/**
 * Functional (ISA-level) interpreter.
 *
 * Executes one instruction per step with no notion of time. It is the
 * reference oracle: every timing model must retire the same instruction
 * stream and end in the same architectural state.
 */
import { STACK_TOP, type Program } from './assembler';
import { Memory } from './memory';
import type { Instr } from './isa';

export type HaltReason =
  | 'ecall' //   executed ECALL
  | 'ebreak' //  executed EBREAK
  | 'end' //     fell off the end of the program
  | 'limit' //   step limit reached
  | 'bad-pc'; // jumped somewhere that is not an instruction

export interface ArchState {
  pc: number;
  /** x0..x31 as signed 32-bit values; regs[0] is always 0. */
  regs: Int32Array;
  mem: Memory;
}

/** What one retired instruction did. Timing models compare against these. */
export interface ExecRecord {
  /** 0-based position in the dynamic instruction stream. */
  seq: number;
  pc: number;
  instr: Instr;
  nextPc: number;
  /** Value written to rd (absent if the instruction writes no register). */
  rdValue?: number;
  /** Effective address of a load or store. */
  memAddr?: number;
  /** Value loaded or stored (after width truncation / extension). */
  memValue?: number;
  /** Outcome of a conditional branch. */
  taken?: boolean;
}

export interface RunOptions {
  /** Stop after this many instructions. Default 1,000,000. */
  maxSteps?: number;
  /** Record every ExecRecord. Default false. */
  trace?: boolean;
}

export interface RunResult {
  state: ArchState;
  halt: HaltReason;
  /** Instructions retired (ECALL/EBREAK included). */
  retired: number;
  trace: ExecRecord[];
}

/** Fresh architectural state for a program: data loaded, sp at the stack top. */
export function initialState(program: Program): ArchState {
  const mem = new Memory();
  mem.writeBytes(program.dataBase, program.data);
  const regs = new Int32Array(32);
  regs[2] = STACK_TOP;
  regs[3] = program.dataBase; // gp
  return { pc: program.entry, regs, mem };
}

export class Interpreter {
  readonly state: ArchState;
  private seq = 0;
  private halted: HaltReason | null = null;
  private readonly textEnd: number;

  constructor(readonly program: Program, state?: ArchState) {
    this.state = state ?? initialState(program);
    this.textEnd = program.textBase + 4 * program.instrs.length;
  }

  get haltReason(): HaltReason | null {
    return this.halted;
  }

  get retired(): number {
    return this.seq;
  }

  /** Instruction at an address, or undefined if there is none. */
  fetch(pc: number): Instr | undefined {
    const off = pc - this.program.textBase;
    if (off < 0 || off % 4 !== 0) return undefined;
    return this.program.instrs[off / 4];
  }

  /** Execute one instruction. Returns null once the machine has halted. */
  step(): ExecRecord | null {
    if (this.halted) return null;
    const s = this.state;
    const instr = this.fetch(s.pc);
    if (!instr) {
      this.halted = s.pc === this.textEnd ? 'end' : 'bad-pc';
      return null;
    }
    const rec = execute(instr, s, this.seq++);
    if (instr.op === 'ecall' || instr.op === 'ebreak') this.halted = instr.op;
    return rec;
  }

  run(opts: RunOptions = {}): RunResult {
    const max = opts.maxSteps ?? 1_000_000;
    const trace: ExecRecord[] = [];
    while (!this.halted) {
      if (this.seq >= max) {
        this.halted = 'limit';
        break;
      }
      const rec = this.step();
      if (rec && opts.trace) trace.push(rec);
    }
    return { state: this.state, halt: this.halted, retired: this.seq, trace };
  }
}

/** Assemble-free convenience: run a program from its initial state. */
export function runProgram(program: Program, opts: RunOptions = {}): RunResult {
  return new Interpreter(program).run(opts);
}

const MIN_INT = -0x8000_0000;

function mulhSigned(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b)) >> 32n) | 0;
}
function mulhUnsigned(a: number, b: number): number {
  return Number((BigInt(a >>> 0) * BigInt(b >>> 0)) >> 32n) | 0;
}
function mulhSignedUnsigned(a: number, b: number): number {
  return Number((BigInt(a) * BigInt(b >>> 0)) >> 32n) | 0;
}

/**
 * Execute one instruction against `s`, updating pc, registers and memory.
 * Exported so timing models can execute at their own chosen stage.
 */
export function execute(i: Instr, s: ArchState, seq: number): ExecRecord {
  const r = s.regs;
  const a = r[i.rs1]!;
  const b = r[i.rs2]!;
  const pc = s.pc;
  let nextPc = (pc + 4) | 0;
  let rd: number | undefined;
  const rec: ExecRecord = { seq, pc, instr: i, nextPc };

  switch (i.op) {
    case 'lui': rd = i.imm << 12; break;
    case 'auipc': rd = (pc + (i.imm << 12)) | 0; break;
    case 'addi': rd = (a + i.imm) | 0; break;
    case 'slti': rd = a < i.imm ? 1 : 0; break;
    case 'sltiu': rd = a >>> 0 < i.imm >>> 0 ? 1 : 0; break;
    case 'xori': rd = a ^ i.imm; break;
    case 'ori': rd = a | i.imm; break;
    case 'andi': rd = a & i.imm; break;
    case 'slli': rd = a << i.imm; break;
    case 'srli': rd = (a >>> i.imm) | 0; break;
    case 'srai': rd = a >> i.imm; break;
    case 'add': rd = (a + b) | 0; break;
    case 'sub': rd = (a - b) | 0; break;
    case 'sll': rd = a << (b & 31); break;
    case 'slt': rd = a < b ? 1 : 0; break;
    case 'sltu': rd = a >>> 0 < b >>> 0 ? 1 : 0; break;
    case 'xor': rd = a ^ b; break;
    case 'srl': rd = (a >>> (b & 31)) | 0; break;
    case 'sra': rd = a >> (b & 31); break;
    case 'or': rd = a | b; break;
    case 'and': rd = a & b; break;
    case 'mul': rd = Math.imul(a, b); break;
    case 'mulh': rd = mulhSigned(a, b); break;
    case 'mulhsu': rd = mulhSignedUnsigned(a, b); break;
    case 'mulhu': rd = mulhUnsigned(a, b); break;
    // RISC-V defines division by zero and overflow instead of trapping.
    case 'div': rd = b === 0 ? -1 : a === MIN_INT && b === -1 ? MIN_INT : (a / b) | 0; break;
    case 'divu': rd = b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0; break;
    case 'rem': rd = b === 0 ? a : a === MIN_INT && b === -1 ? 0 : a % b | 0; break;
    case 'remu': rd = b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0; break;
    case 'lb':
    case 'lh':
    case 'lw':
    case 'lbu':
    case 'lhu': {
      const addr = (a + i.imm) | 0;
      const m = s.mem;
      rd =
        i.op === 'lb' ? (m.read8(addr) << 24) >> 24
        : i.op === 'lh' ? (m.read16(addr) << 16) >> 16
        : i.op === 'lw' ? m.read32(addr)
        : i.op === 'lbu' ? m.read8(addr)
        : m.read16(addr);
      rec.memAddr = addr >>> 0;
      rec.memValue = rd;
      break;
    }
    case 'sb':
    case 'sh':
    case 'sw': {
      const addr = (a + i.imm) | 0;
      if (i.op === 'sb') {
        s.mem.write8(addr, b);
        rec.memValue = b & 0xff;
      } else if (i.op === 'sh') {
        s.mem.write16(addr, b);
        rec.memValue = b & 0xffff;
      } else {
        s.mem.write32(addr, b);
        rec.memValue = b;
      }
      rec.memAddr = addr >>> 0;
      break;
    }
    case 'beq':
    case 'bne':
    case 'blt':
    case 'bge':
    case 'bltu':
    case 'bgeu': {
      const taken =
        i.op === 'beq' ? a === b
        : i.op === 'bne' ? a !== b
        : i.op === 'blt' ? a < b
        : i.op === 'bge' ? a >= b
        : i.op === 'bltu' ? a >>> 0 < b >>> 0
        : a >>> 0 >= b >>> 0;
      rec.taken = taken;
      if (taken) nextPc = (pc + i.imm) | 0;
      break;
    }
    case 'jal':
      rd = nextPc;
      nextPc = (pc + i.imm) | 0;
      break;
    case 'jalr':
      rd = nextPc;
      nextPc = ((a + i.imm) & ~1) | 0;
      break;
    case 'ecall':
    case 'ebreak':
      break;
  }

  if (rd !== undefined) {
    if (i.rd !== 0) r[i.rd] = rd;
    rec.rdValue = i.rd === 0 ? 0 : rd;
  }
  s.pc = nextPc;
  rec.nextPc = nextPc;
  return rec;
}
