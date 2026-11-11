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

/** A wide core in the spirit of a modern big core, scaled down. */
export const BIG: MachineDesc = {
  name: 'big',
  policy: 'ooo',
  width: { fetch: 6, rename: 6, commit: 6 },
  rob: 128,
  iq: 48,
  physRegs: 160,
  fetchBuffer: 12,
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
  branchPredictor: { kind: 'gshare', tableBits: 10, historyBits: 8, rasDepth: 16 },
  redirectPenalty: 2,
};

/** One-wide, tiny window: shows how little a narrow core can overlap. */
export const NARROW: MachineDesc = {
  ...TEACHING,
  name: 'narrow',
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

export const PRESETS: Record<string, MachineDesc> = { teaching: TEACHING, narrow: NARROW, big: BIG };

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
