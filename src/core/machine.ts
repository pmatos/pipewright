/**
 * Machine description: the JSON-serialisable shape of a core.
 *
 * Every timing model reads one of these. Keep the schema stable and
 * documented (see docs/machine-description.md); later phases extend it
 * with new optional fields rather than changing existing ones.
 */
import type { OpClass } from './isa';

export type Policy = 'ooo';

export type PredictorKind =
  /** No prediction: fetch stops at every branch until it resolves. */
  | 'none'
  /** Always predict not taken. */
  | 'not-taken'
  /** Backward taken, forward not taken (good for loops). */
  | 'btfn'
  /** Table of 2-bit saturating counters indexed by PC. */
  | 'bimodal'
  /** 2-bit counters indexed by PC XOR global history. */
  | 'gshare';

export interface PredictorDesc {
  kind: PredictorKind;
  /** log2 of the pattern history table size (bimodal, gshare). */
  tableBits: number;
  /** Global history length in bits (gshare). */
  historyBits: number;
  /** Return address stack depth; 0 disables it. */
  rasDepth: number;
}

export interface PortDesc {
  name: string;
  classes: OpClass[];
}

export interface MachineDesc {
  name: string;
  /** One-paragraph description of the design point (shown in the UI). */
  description?: string;
  policy: Policy;
  width: {
    /** Instructions fetched per cycle. */
    fetch: number;
    /** Instructions renamed and dispatched per cycle. */
    rename: number;
    /** Instructions retired per cycle. */
    commit: number;
  };
  /** Reorder buffer entries. */
  rob: number;
  /** Unified issue queue (reservation station) entries. */
  iq: number;
  /**
   * Physical registers. 32 of them hold the committed architectural
   * state, so physRegs - 32 can be in flight at once.
   */
  physRegs: number;
  /** Fetch buffer / decode queue entries. */
  fetchBuffer: number;
  /** Execution ports. Each issues at most one instruction per cycle. */
  ports: PortDesc[];
  /** Execution latency in cycles, per class. */
  latency: Record<OpClass, number>;
  /** False means the unit is busy for the whole latency (e.g. a divider). */
  pipelined: Record<OpClass, boolean>;
  branchPredictor: PredictorDesc;
  /** Extra fetch bubble cycles after a mispredict redirect. */
  redirectPenalty: number;
}

const CLASSES: OpClass[] = ['alu', 'mul', 'div', 'load', 'store', 'branch', 'jump', 'system'];

/** A small out-of-order core whose structures fit on screen. */
export const TEACHING: MachineDesc = {
  name: 'teaching',
  description: 'Two-wide with a 16-entry ROB and 48 physical registers: big enough to show out-of-order execution, small enough that every structure fits on screen.',
  policy: 'ooo',
  width: { fetch: 2, rename: 2, commit: 2 },
  rob: 16,
  iq: 8,
  physRegs: 48,
  fetchBuffer: 4,
  ports: [
    { name: 'ALU0', classes: ['alu', 'branch', 'jump', 'system'] },
    { name: 'ALU1', classes: ['alu', 'mul', 'div'] },
    { name: 'LSU', classes: ['load', 'store'] },
  ],
  latency: { alu: 1, mul: 3, div: 10, load: 3, store: 1, branch: 1, jump: 1, system: 1 },
  pipelined: { alu: true, mul: true, div: false, load: true, store: true, branch: true, jump: true, system: true },
  branchPredictor: { kind: 'bimodal', tableBits: 4, historyBits: 4, rasDepth: 4 },
  redirectPenalty: 0,
};

/** One-wide, tiny window: shows how little a narrow core can overlap. */
export const NARROW: MachineDesc = {
  ...TEACHING,
  name: 'narrow',
  description: 'One instruction per cycle and an 8-entry window: the smallest machine that still renames and executes out of order.',
  width: { fetch: 1, rename: 1, commit: 1 },
  rob: 8,
  iq: 4,
  physRegs: 40,
  fetchBuffer: 2,
  ports: [
    { name: 'ALU0', classes: ['alu', 'mul', 'div', 'branch', 'jump', 'system'] },
    { name: 'LSU', classes: ['load', 'store'] },
  ],
};

/**
 * A phone-class core: out of order but modest, loosely in the spirit of a
 * mid-size mobile core. Every structure is sized for energy per instruction.
 */
export const MOBILE: MachineDesc = {
  name: 'mobile',
  description:
    'A phone-class core. Three-wide, a 40-entry ROB, a small bimodal predictor, two ALUs and one load/store port. Each of those structures is looked up or searched every cycle, so on a battery budget they are kept just big enough for typical code.',
  policy: 'ooo',
  width: { fetch: 3, rename: 3, commit: 3 },
  rob: 40,
  iq: 16,
  physRegs: 80,
  fetchBuffer: 6,
  ports: [
    { name: 'ALU0', classes: ['alu', 'branch', 'jump', 'system'] },
    { name: 'ALU1', classes: ['alu', 'mul', 'div'] },
    { name: 'LSU', classes: ['load', 'store'] },
  ],
  latency: { alu: 1, mul: 3, div: 12, load: 3, store: 1, branch: 1, jump: 1, system: 1 },
  pipelined: { alu: true, mul: true, div: false, load: true, store: true, branch: true, jump: true, system: true },
  branchPredictor: { kind: 'bimodal', tableBits: 6, historyBits: 6, rasDepth: 8 },
  redirectPenalty: 1,
};

/**
 * A server-class core: wide and deep, loosely in the spirit of a modern
 * datacentre core, scaled down to stay readable.
 */
export const SERVER: MachineDesc = {
  name: 'server',
  description:
    'A server-class core. Eight-wide, a 192-entry ROB, a large gshare predictor, four ALUs, two load ports and a store port. It spends area and power on looking far ahead for independent work, which pays off on code with parallelism and does nothing for a dependence chain. The deeper front end makes each mispredict cost more.',
  policy: 'ooo',
  width: { fetch: 8, rename: 8, commit: 8 },
  rob: 192,
  iq: 64,
  physRegs: 256,
  fetchBuffer: 16,
  ports: [
    { name: 'ALU0', classes: ['alu', 'branch', 'jump', 'system'] },
    { name: 'ALU1', classes: ['alu', 'branch', 'jump'] },
    { name: 'ALU2', classes: ['alu', 'mul'] },
    { name: 'ALU3', classes: ['alu', 'mul', 'div'] },
    { name: 'LD0', classes: ['load'] },
    { name: 'LD1', classes: ['load'] },
    { name: 'ST0', classes: ['store'] },
  ],
  latency: { alu: 1, mul: 3, div: 12, load: 4, store: 1, branch: 1, jump: 1, system: 1 },
  pipelined: { alu: true, mul: true, div: false, load: true, store: true, branch: true, jump: true, system: true },
  branchPredictor: { kind: 'gshare', tableBits: 12, historyBits: 10, rasDepth: 32 },
  redirectPenalty: 3,
};

export const PRESETS: Record<string, MachineDesc> = { teaching: TEACHING, narrow: NARROW, mobile: MOBILE, server: SERVER };

/** Check a description and return a list of problems (empty when valid). */
export function validateMachine(m: MachineDesc): string[] {
  const errs: string[] = [];
  const pos = (v: number, what: string, min = 1) => {
    if (!Number.isInteger(v) || v < min) errs.push(`${what} must be an integer >= ${min}`);
  };
  pos(m.width.fetch, 'width.fetch');
  pos(m.width.rename, 'width.rename');
  pos(m.width.commit, 'width.commit');
  pos(m.rob, 'rob');
  pos(m.iq, 'iq');
  pos(m.fetchBuffer, 'fetchBuffer');
  pos(m.physRegs, 'physRegs', 33);
  pos(m.redirectPenalty, 'redirectPenalty', 0);
  for (const c of CLASSES) {
    pos(m.latency[c], `latency.${c}`);
    if (!m.ports.some((p) => p.classes.includes(c))) errs.push(`no port executes class '${c}'`);
  }
  const bp = m.branchPredictor;
  if (bp.kind === 'bimodal' || bp.kind === 'gshare') {
    if (!Number.isInteger(bp.tableBits) || bp.tableBits < 1 || bp.tableBits > 16) errs.push('branchPredictor.tableBits must be 1..16');
  }
  if (bp.kind === 'gshare' && (!Number.isInteger(bp.historyBits) || bp.historyBits < 1 || bp.historyBits > 16))
    errs.push('branchPredictor.historyBits must be 1..16');
  pos(bp.rasDepth, 'branchPredictor.rasDepth', 0);
  return errs;
}
