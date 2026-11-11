/**
 * Out-of-order core with register renaming, a reorder buffer, a unified
 * issue queue, wakeup/select, in-order commit and branch prediction with
 * mispredict recovery.
 *
 * The model is a teaching model. Each cycle it records a snapshot of every
 * structure and a list of events: the decisions the hardware took, each
 * with a plain-language reason. Event text may contain references that the
 * UI turns into interactive chips:
 *
 *   {#12}  dynamic instruction (uop) 12
 *   {p7}   physical register 7
 *
 * Pipeline, one cycle (stages run back to front so each sees the state the
 * previous cycle left behind):
 *
 *   commit -> writeback (wakeup, branch resolution) -> issue (select)
 *          -> rename/dispatch -> decode -> fetch (with prediction)
 *
 * Values are real: instructions execute on physical register values, loads
 * read memory merged with older in-flight stores (store-to-load
 * forwarding), stores write memory when they commit. The committed stream
 * and final state match the functional interpreter, which the golden tests
 * check.
 */
import { initialState, execute, type ArchState, type HaltReason } from './interpreter';
import { Memory } from './memory';
import type { Program } from './assembler';
import { destReg, formatInstr, hex, opClass, regName, sourceRegs, type Instr, type OpClass } from './isa';
import { validateMachine, type MachineDesc, type PortDesc } from './machine';

// ---------------------------------------------------------------------------
// Public types

export type Stage = 'fetch' | 'decode' | 'rename' | 'issue' | 'writeback' | 'commit';

export type EventKind =
  | 'fetch' | 'predict' | 'fetch-stall'
  | 'decode'
  | 'rename' | 'rename-stall'
  | 'issue' | 'wait' | 'port-conflict' | 'mem-wait' | 'forward'
  | 'writeback' | 'wakeup' | 'resolve' | 'mispredict' | 'flush'
  | 'commit' | 'commit-stall' | 'train' | 'free'
  | 'halt';

export interface CoreEvent {
  stage: Stage;
  kind: EventKind;
  /** Plain-language explanation, with {#n} and {pN} references. */
  text: string;
  /** Uops this event is about; the first is the subject. */
  uops: number[];
  /** Physical registers this event is about. */
  pregs: number[];
  /** True for "why nothing happened" notes (waiting, stalls). */
  why?: boolean;
}

export type PredictionKind =
  | 'seq' //       not a control transfer: next PC is PC + 4
  | 'direct' //    JAL: target known from the instruction itself
  | 'predicted' // conditional branch or return, predicted
  | 'stall' //     no prediction possible: fetch waits for resolution
  | 'halt'; //     ECALL/EBREAK: fetch stops

export interface Prediction {
  kind: PredictionKind;
  /** Predicted next fetch PC (meaningless when kind is 'stall' or 'halt'). */
  next: number;
  taken?: boolean;
  /** Pattern history table index used (bimodal, gshare). */
  phtIndex?: number;
  /** Counter value read from the PHT. */
  counter?: number;
  /** Global history used for the prediction (gshare). */
  ghr?: number;
  /** Return address stack used for a return. */
  fromRas?: boolean;
  reason: string;
}

export type UopStatus = 'fetched' | 'decoded' | 'waiting' | 'executing' | 'done' | 'committed' | 'flushed';

/** Cycle at which a uop reached each stage. */
export interface UopTimes {
  fetch: number;
  decode?: number;
  rename?: number;
  issue?: number;
  /** Writeback: result visible, dependents woken, branch resolved. */
  complete?: number;
  commit?: number;
  flush?: number;
}

/** One dynamic instruction. Fixed facts plus a timeline; status is derived per cycle. */
export interface Uop {
  id: number;
  pc: number;
  instr: Instr;
  text: string;
  cls: OpClass;
  pred: Prediction;
  srcArch: number[];
  psrc: number[];
  dstArch: number | null;
  pdst: number | null;
  oldPdst: number | null;
  port: string | null;
  result?: number;
  memAddr?: number;
  memValue?: number;
  /** Uops a load took bytes from, by store-to-load forwarding. */
  forwardedFrom?: number[];
  taken?: boolean;
  actualNext?: number;
  mispredicted?: boolean;
  /** Position in the committed instruction stream. */
  retireSeq?: number;
  t: UopTimes;
}

export interface PortView {
  name: string;
  classes: OpClass[];
  /** Uop issued to this port this cycle. */
  issued: number | null;
  /** Non-pipelined unit busy until this cycle (exclusive). */
  busyUntil: number;
}

export interface Counters {
  /** Arm PMU-style names. */
  CPU_CYCLES: number;
  INST_RETIRED: number;
  INST_SPEC: number;
  BR_RETIRED: number;
  BR_MIS_PRED_RETIRED: number;
  /** Rename slots left empty because the front end had nothing to give. */
  STALL_SLOT_FRONTEND: number;
  /** Rename slots left empty because the back end was full. */
  STALL_SLOT_BACKEND: number;
  /** Uops thrown away by mispredict flushes. */
  UOPS_FLUSHED: number;
}

export interface PredictorView {
  kind: MachineDesc['branchPredictor']['kind'];
  pht: number[] | null;
  ghr: number;
  historyBits: number;
  ras: number[];
}

/** Everything visible in the machine at the end of one cycle. */
export interface Snapshot {
  cycle: number;
  fetchPc: number;
  /** One-line state of the fetch unit. */
  fetchState: string;
  fetchQ: number[];
  decodeQ: number[];
  /** ROB contents, oldest (head) first. */
  rob: number[];
  /** Issue queue contents, oldest first. */
  iq: number[];
  /** Uops issued and not yet written back. */
  executing: number[];
  /** Speculative (front-end) register alias table: arch reg -> phys reg. */
  rat: number[];
  /** Retirement (committed) RAT. */
  rrat: number[];
  freeList: number[];
  prfValue: number[];
  prfReady: boolean[];
  ports: PortView[];
  predictor: PredictorView;
  events: CoreEvent[];
  counters: Counters;
  halted: HaltReason | null;
}

export interface SimOptions {
  /** Stop after this many cycles. Default 100,000. */
  maxCycles?: number;
  /** Record a snapshot per cycle. Default true. */
  snapshots?: boolean;
}

export interface SimResult {
  machine: MachineDesc;
  /** snapshots[0] is the reset state (cycle 0); snapshots[c] is the end of cycle c. */
  snapshots: Snapshot[];
  /** Every uop ever fetched, indexed by id (wrong-path ones included). */
  uops: Uop[];
  /** Committed architectural state. */
  state: ArchState;
  halt: HaltReason;
  cycles: number;
  retired: number;
  counters: Counters;
}

// ---------------------------------------------------------------------------
// Helpers

const u = (id: number) => `{#${id}}`;
const p = (n: number) => `{p${n}}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** Counters start weakly taken: most branches are loop back-edges. */
const PHT_INIT = 2;
const COUNTER_NAMES = ['strongly not taken', 'weakly not taken', 'weakly taken', 'strongly taken'];

function memSize(op: string): number {
  return op === 'lb' || op === 'lbu' || op === 'sb' ? 1 : op === 'lh' || op === 'lhu' || op === 'sh' ? 2 : 4;
}

const CLASS_WORDS: Record<OpClass, string> = {
  alu: 'ALU',
  mul: 'multiply',
  div: 'divide',
  load: 'load',
  store: 'store',
  branch: 'branch',
  jump: 'jump',
  system: 'system',
};

/** Replace {#n} and {pN} references with plain text (for logs and tests). */
export function plainText(text: string, uops: readonly Uop[]): string {
  return text
    .replace(/\{#(\d+)\}/g, (_, n) => {
      const x = uops[Number(n)];
      return x ? `#${n} (${x.text})` : `#${n}`;
    })
    .replace(/\{p(\d+)\}/g, 'p$1');
}

// ---------------------------------------------------------------------------
// The core

interface Internal {
  ratCheckpoint?: number[];
  ghrAfter?: number;
  rasAfter?: number[];
  ghrBefore?: number;
  doneCycle?: number;
}

export class OoOCore {
  readonly machine: MachineDesc;
  readonly uops: Uop[] = [];
  cycle = 0;
  halted: HaltReason | null = null;

  private readonly internal = new Map<number, Internal>();
  private readonly mem: Memory;
  private readonly textEnd: number;

  private fetchPc: number;
  private fetchStopped = false; // fetched an ECALL/EBREAK on this path
  private fetchBlockedBy: number | null = null; // unpredicted branch we wait for
  private fetchResume = 0; // first cycle fetch may run after a redirect
  private fetchState = 'ready';

  private fetchQ: number[] = [];
  private decodeQ: number[] = [];
  private rob: number[] = [];
  private iq: number[] = [];
  private executing: number[] = [];

  private rat: number[];
  private rrat: number[];
  private freeList: number[];
  private prfValue: Int32Array;
  private prfReady: boolean[];
  /** Uop that will write each physical register (while in flight). */
  private producer = new Map<number, number>();

  private ports: PortView[];
  private pht: number[] | null;
  private ghr = 0;
  private ras: number[] = [];

  private retired = 0;
  private events: CoreEvent[] = [];
  private counters: Counters = {
    CPU_CYCLES: 0,
    INST_RETIRED: 0,
    INST_SPEC: 0,
    BR_RETIRED: 0,
    BR_MIS_PRED_RETIRED: 0,
    STALL_SLOT_FRONTEND: 0,
    STALL_SLOT_BACKEND: 0,
    UOPS_FLUSHED: 0,
  };

  constructor(readonly program: Program, machine: MachineDesc) {
    const errs = validateMachine(machine);
    if (errs.length) throw new Error(`invalid machine '${machine.name}': ${errs.join('; ')}`);
    this.machine = machine;
    const init = initialState(program);
    this.mem = init.mem;
    this.fetchPc = init.pc;
    this.textEnd = program.textBase + 4 * program.instrs.length;
    // Physical registers 0..31 start out holding x0..x31; the rest are free.
    this.prfValue = new Int32Array(machine.physRegs);
    this.prfValue.set(init.regs);
    this.prfReady = Array.from({ length: machine.physRegs }, () => true);
    this.rat = Array.from({ length: 32 }, (_, i) => i);
    this.rrat = this.rat.slice();
    this.freeList = Array.from({ length: machine.physRegs - 32 }, (_, i) => 32 + i);
    this.ports = machine.ports.map((pd: PortDesc) => ({ name: pd.name, classes: pd.classes.slice(), issued: null, busyUntil: 0 }));
    const bp = machine.branchPredictor;
    this.pht = bp.kind === 'bimodal' || bp.kind === 'gshare' ? new Array<number>(1 << bp.tableBits).fill(PHT_INIT) : null;
  }

  // ---- public API ----

  /** Advance one cycle. Returns false once halted. */
  step(): boolean {
    if (this.halted) return false;
    this.cycle++;
    this.events = [];
    for (const port of this.ports) port.issued = null;
    this.counters.CPU_CYCLES++;

    this.commit();
    if (!this.halted) {
      this.writeback();
      this.issue();
      this.rename();
      this.decode();
      this.fetch();
      this.checkEnd();
    }
    return !this.halted;
  }

  snapshot(): Snapshot {
    const bp = this.machine.branchPredictor;
    return {
      cycle: this.cycle,
      fetchPc: this.fetchPc,
      fetchState: this.fetchState,
      fetchQ: this.fetchQ.slice(),
      decodeQ: this.decodeQ.slice(),
      rob: this.rob.slice(),
      iq: this.iq.slice(),
      executing: this.executing.slice(),
      rat: this.rat.slice(),
      rrat: this.rrat.slice(),
      freeList: this.freeList.slice(),
      prfValue: Array.from(this.prfValue),
      prfReady: this.prfReady.slice(),
      ports: this.ports.map((x) => ({ ...x, classes: x.classes.slice() })),
      predictor: { kind: bp.kind, pht: this.pht ? this.pht.slice() : null, ghr: this.ghr, historyBits: bp.historyBits, ras: this.ras.slice() },
      events: this.events.slice(),
      counters: { ...this.counters },
      halted: this.halted,
    };
  }

  /** Committed architectural state. */
  archState(): ArchState {
    const regs = new Int32Array(32);
    for (let r = 1; r < 32; r++) regs[r] = this.prfValue[this.rrat[r]!]!;
    const last = [...this.uops].reverse().find((x) => x.t.commit !== undefined);
    return { pc: last?.actualNext ?? this.program.entry, regs, mem: this.mem };
  }

  get retiredCount(): number {
    return this.retired;
  }

  getCounters(): Counters {
    return { ...this.counters };
  }

  // ---- event helpers ----

  private emit(stage: Stage, kind: EventKind, text: string, uops: number[] = [], pregs: number[] = [], why = false) {
    const e: CoreEvent = { stage, kind, text, uops, pregs };
    if (why) e.why = true;
    this.events.push(e);
  }

  private producerNote(preg: number): string {
    const pid = this.producer.get(preg);
    if (pid === undefined) return '';
    const x = this.uops[pid]!;
    const done = this.internal.get(pid)?.doneCycle;
    if (x.t.issue !== undefined && done !== undefined) return ` from ${u(pid)}, executing, result at cycle ${done}`;
    return ` from ${u(pid)}, which has not issued yet`;
  }

  // ---- commit ----

  private commit() {
    const m = this.machine;
    let n = 0;
    while (n < m.width.commit && this.rob.length > 0) {
      const id = this.rob[0]!;
      const x = this.uops[id]!;
      if (x.t.complete === undefined) {
        if (n === 0) {
          const done = this.internal.get(id)?.doneCycle;
          const state =
            x.t.issue !== undefined ? `is still executing (${CLASS_WORDS[x.cls]}, result at cycle ${done})`
            : 'has not issued yet';
          this.emit('commit', 'commit-stall', `Nothing retires: the oldest instruction ${u(id)} ${state}. Commit is in order, so everything behind it waits even if it has finished.`, [id], [], true);
        }
        break;
      }
      this.rob.shift();
      x.t.commit = this.cycle;
      x.retireSeq = this.retired++;
      n++;
      this.counters.INST_RETIRED++;
      const parts: string[] = [];
      if (x.pdst !== null && x.dstArch !== null) {
        this.rrat[x.dstArch] = x.pdst;
        this.freeList.push(x.oldPdst!);
        parts.push(`${regName(x.dstArch)} = ${x.result} is now architectural state (committed map ${regName(x.dstArch)}→${p(x.pdst)}). The previous register for ${regName(x.dstArch)}, ${p(x.oldPdst!)}, goes back on the free list: no older instruction can still need it.`);
      }
      if (x.cls === 'store') {
        const size = memSize(x.instr.op);
        if (size === 1) this.mem.write8(x.memAddr!, x.memValue!);
        else if (size === 2) this.mem.write16(x.memAddr!, x.memValue!);
        else this.mem.write32(x.memAddr!, x.memValue!);
        parts.push(`The store finally writes ${x.memValue} to memory at ${hex(x.memAddr!)}. Stores only touch memory at commit, so a mispredict can never leave a wrong value behind.`);
      }
      if (x.cls === 'branch' || x.cls === 'jump') {
        this.counters.BR_RETIRED++;
        if (x.mispredicted) this.counters.BR_MIS_PRED_RETIRED++;
      }
      if (x.cls === 'branch') this.train(x);
      this.emit('commit', 'commit', `Retired ${u(id)}.${parts.length ? ' ' + parts.join(' ') : ''}`, [id], x.pdst !== null ? [x.pdst, x.oldPdst!] : []);
      if (x.instr.op === 'ecall' || x.instr.op === 'ebreak') {
        this.halted = x.instr.op;
        this.emit('commit', 'halt', `${u(id)} retired, so the machine halts after ${plural(this.retired, 'instruction')} in ${plural(this.cycle, 'cycle')} (IPC ${(this.retired / this.cycle).toFixed(2)}).`, [id]);
        break;
      }
    }
  }

  private train(x: Uop) {
    if (!this.pht || x.pred.phtIndex === undefined) return;
    const i = x.pred.phtIndex;
    const before = this.pht[i]!;
    const after = x.taken ? Math.min(3, before + 1) : Math.max(0, before - 1);
    this.pht[i] = after;
    const how = before === after ? 'stays at' : 'moves to';
    this.emit('commit', 'train', `Predictor trained by ${u(x.id)} (${x.taken ? 'taken' : 'not taken'}): counter PHT[${i}] ${how} ${after} (${COUNTER_NAMES[after]}).`, [x.id]);
  }

  // ---- writeback, wakeup, branch resolution ----

  private writeback() {
    const finishing = this.executing.filter((id) => this.internal.get(id)!.doneCycle === this.cycle).sort((a, b) => a - b);
    for (const id of finishing) {
      const x = this.uops[id]!;
      if (x.t.flush !== undefined) continue; // squashed by an older mispredict this cycle
      this.executing = this.executing.filter((e) => e !== id);
      x.t.complete = this.cycle;
      if (x.pdst !== null) {
        this.prfValue[x.pdst] = x.result!;
        this.prfReady[x.pdst] = true;
        this.producer.delete(x.pdst);
        const woken = this.iq.filter((c) => this.uops[c]!.psrc.includes(x.pdst!));
        const wake = woken.length
          ? ` The tag ${p(x.pdst)} is broadcast to the issue queue, so ${woken.map(u).join(', ')} ${woken.length === 1 ? 'sees' : 'see'} that operand become ready.`
          : ' No instruction in the issue queue was waiting for it.';
        this.emit('writeback', woken.length ? 'wakeup' : 'writeback', `${u(id)} finished: ${p(x.pdst)} = ${x.result}.${wake}`, [id, ...woken], [x.pdst]);
      } else if (x.cls === 'store') {
        this.emit('writeback', 'writeback', `${u(id)} has its address (${hex(x.memAddr!)}) and data (${x.memValue}). It waits in the ROB and writes memory when it retires.`, [id]);
      } else if (x.cls !== 'branch' && x.cls !== 'jump') {
        this.emit('writeback', 'writeback', `${u(id)} finished.`, [id]);
      }
      if (x.cls === 'branch' || x.cls === 'jump') this.resolve(x);
    }
  }

  private resolve(x: Uop) {
    const m = this.machine;
    const int = this.internal.get(x.id)!;
    const hmask = (1 << m.branchPredictor.historyBits) - 1;
    const outcome = x.cls === 'branch' ? (x.taken ? 'taken' : 'not taken') : `jumps to ${hex(x.actualNext!)}`;
    if (x.cls === 'branch') int.ghrAfter = ((int.ghrBefore! << 1) | (x.taken ? 1 : 0)) & hmask;

    if (x.pred.kind === 'stall') {
      if (this.fetchBlockedBy === x.id) {
        this.fetchBlockedBy = null;
        this.fetchPc = x.actualNext!;
        this.fetchResume = this.cycle + 1;
        if (x.cls === 'branch') this.ghr = int.ghrAfter!;
      }
      this.emit('writeback', 'resolve', `${u(x.id)} resolved: ${outcome}. Fetch was waiting for this and restarts at ${hex(x.actualNext!)} next cycle.`, [x.id]);
      return;
    }
    if (x.pred.kind === 'direct') {
      const ret = x.pdst !== null ? ` and wrote the return address ${p(x.pdst)} = ${x.result}` : '';
      this.emit('writeback', 'resolve', `${u(x.id)} finished${ret}. Its target was already known at fetch, so there is nothing to check.`, [x.id], x.pdst !== null ? [x.pdst] : []);
      return;
    }
    if (x.actualNext === x.pred.next) {
      this.emit('writeback', 'resolve', `${u(x.id)} resolved: ${outcome}, as predicted. Nothing to undo; the instructions fetched after it were on the right path.`, [x.id]);
      return;
    }
    x.mispredicted = true;
    const victims = this.flush(x);
    this.emit(
      'writeback',
      'mispredict',
      `${u(x.id)} resolved: ${outcome}, but fetch had guessed ${x.pred.taken === undefined ? hex(x.pred.next) : x.pred.taken ? 'taken' : 'not taken'}. Mispredict! ` +
        (victims.length
          ? `The ${plural(victims.length, 'younger instruction')} fetched down the wrong path ${victims.length === 1 ? 'is' : 'are'} squashed: ${victims.map(u).join(', ')}. `
          : 'Nothing younger had been fetched yet. ') +
        `The RAT is restored from the checkpoint taken when ${u(x.id)} was renamed, their physical registers return to the free list, and fetch restarts at ${hex(x.actualNext!)}` +
        (m.redirectPenalty ? ` after ${plural(m.redirectPenalty, 'bubble cycle')}.` : ' next cycle.'),
      [x.id, ...victims],
    );
  }

  /** Squash everything younger than `br` and recover. Returns the squashed uop ids. */
  private flush(br: Uop): number[] {
    const int = this.internal.get(br.id)!;
    const younger = (id: number) => id > br.id;
    const victims = new Set<number>();
    for (const q of [this.fetchQ, this.decodeQ, this.rob, this.iq, this.executing]) for (const id of q) if (younger(id)) victims.add(id);
    // Return physical registers, youngest first, to the head of the free list
    // so the list ends up exactly as it was before the wrong path renamed.
    const robVictims = this.rob.filter(younger).reverse();
    const freed: number[] = [];
    for (const id of robVictims) {
      const x = this.uops[id]!;
      if (x.pdst !== null) {
        this.freeList.unshift(x.pdst);
        this.prfReady[x.pdst] = true;
        this.producer.delete(x.pdst);
        freed.push(x.pdst);
      }
    }
    this.fetchQ = this.fetchQ.filter((i) => !younger(i));
    this.decodeQ = this.decodeQ.filter((i) => !younger(i));
    this.rob = this.rob.filter((i) => !younger(i));
    this.iq = this.iq.filter((i) => !younger(i));
    this.executing = this.executing.filter((i) => !younger(i));
    for (const id of victims) this.uops[id]!.t.flush = this.cycle;
    // Unit occupancy of squashed non-pipelined ops is released.
    for (const id of victims) {
      const x = this.uops[id]!;
      if (x.port && !this.machine.pipelined[x.cls]) {
        const port = this.ports.find((pp) => pp.name === x.port)!;
        if (port.busyUntil === this.internal.get(id)?.doneCycle) port.busyUntil = 0;
      }
    }
    this.counters.UOPS_FLUSHED += victims.size;
    this.rat = int.ratCheckpoint!.slice();
    // A conditional branch restores the history including its own real outcome.
    // A jump has no outcome bit, so the history goes back to what it was when
    // the jump was fetched, which drops everything the wrong path shifted in.
    const ghrRestored = int.ghrAfter ?? int.ghrBefore;
    if (ghrRestored !== undefined) this.ghr = ghrRestored;
    this.ras = int.rasAfter!.slice();
    this.fetchPc = br.actualNext!;
    this.fetchStopped = false;
    this.fetchBlockedBy = null;
    this.fetchResume = this.cycle + 1 + this.machine.redirectPenalty;
    if (freed.length) this.emit('writeback', 'free', `Recovered physical registers ${freed.map(p).join(', ')} from squashed instructions.`, [br.id], freed);
    return [...victims].sort((a, b) => a - b);
  }

  // ---- issue (select) and execute ----

  private srcsReady(x: Uop): boolean {
    return x.psrc.every((r) => this.prfReady[r]);
  }

  /** For a load: older stores whose address is not known yet. */
  private unknownOlderStores(x: Uop): number[] {
    return this.rob.filter((id) => id < x.id && this.uops[id]!.cls === 'store' && this.uops[id]!.memAddr === undefined);
  }

  private issue() {
    const m = this.machine;
    const chosen = new Set<number>();
    const lostTo = new Map<number, string>();
    for (const port of this.ports) {
      if (port.busyUntil > this.cycle) continue;
      for (const id of this.iq) {
        if (chosen.has(id)) continue;
        const x = this.uops[id]!;
        if (!port.classes.includes(x.cls) || x.t.rename! >= this.cycle) continue;
        if (!this.srcsReady(x)) continue;
        if (x.cls === 'load' && this.unknownOlderStores(x).length) continue;
        chosen.add(id);
        port.issued = id;
        this.execute(x, port);
        if (!m.pipelined[x.cls]) port.busyUntil = this.cycle + m.latency[x.cls];
        break;
      }
      // Ready instructions this port could have taken but did not.
      if (port.issued !== null) {
        for (const id of this.iq) {
          const x = this.uops[id]!;
          if (!chosen.has(id) && id > port.issued && port.classes.includes(x.cls) && x.t.rename! < this.cycle && this.srcsReady(x) && !lostTo.has(id))
            lostTo.set(id, `${port.name} went to the older ${u(port.issued)}`);
        }
      }
    }
    this.iq = this.iq.filter((id) => !chosen.has(id));

    // Explain everything still waiting.
    for (const id of this.iq) {
      const x = this.uops[id]!;
      if (x.t.rename! >= this.cycle) continue; // just arrived; can issue next cycle at the earliest
      const notReady = x.psrc.filter((r) => !this.prfReady[r]);
      if (notReady.length) {
        const uniq = [...new Set(notReady)];
        const why = uniq.map((r) => `${p(r)}${this.producerNote(r)}`).join('; ');
        this.emit('issue', 'wait', `${u(id)} waits in the issue queue: ${uniq.length === 1 ? 'operand' : 'operands'} ${why} ${uniq.length === 1 ? 'is' : 'are'} not ready.`, [id, ...notReady.map((r) => this.producer.get(r)).filter((v): v is number => v !== undefined)], notReady, true);
        continue;
      }
      if (x.cls === 'load') {
        const st = this.unknownOlderStores(x);
        if (st.length) {
          this.emit('issue', 'mem-wait', `${u(id)} is ready but waits: older store ${st.map(u).join(', ')} has not computed its address, so the load cannot know whether it must take its data from that store.`, [id, ...st], [], true);
          continue;
        }
      }
      const busy = this.ports.filter((pp) => pp.classes.includes(x.cls) && pp.busyUntil > this.cycle && pp.issued === null);
      const reason = lostTo.get(id) ?? (busy.length ? `${busy.map((b) => b.name).join('/')} is busy with a non-pipelined operation until cycle ${busy[0]!.busyUntil}` : 'every port that can run it was taken');
      this.emit('issue', 'port-conflict', `${u(id)} is ready but not selected: ${reason}. Select picks the oldest ready instruction per port.`, [id], [], true);
    }
  }

  private execute(x: Uop, port: PortView) {
    const m = this.machine;
    const lat = m.latency[x.cls];
    x.port = port.name;
    x.t.issue = this.cycle;
    const done = this.cycle + lat;
    this.internal.get(x.id)!.doneCycle = done;
    this.executing.push(x.id);
    const vals = x.psrc.map((r) => this.prfValue[r]!);
    const a = vals[0] ?? 0;
    const b = vals[1] ?? 0;
    const operands = x.psrc.length ? ` Read ${x.srcArch.flatMap((r, k) => (x.srcArch.indexOf(r) === k ? [`${regName(r)}=${p(x.psrc[k]!)}=${vals[k]}`] : [])).join(', ')}.` : '';
    let detail = '';

    if (x.cls === 'load') {
      const addr = (a + x.instr.imm) | 0;
      const size = memSize(x.instr.op);
      const olderStores = this.rob.filter((id) => id < x.id && this.uops[id]!.cls === 'store').reverse(); // youngest first
      let raw = 0;
      const from = new Set<number>();
      for (let k = 0; k < size; k++) {
        const ba = (addr + k) >>> 0;
        let byte: number | undefined;
        for (const sid of olderStores) {
          const s = this.uops[sid]!;
          const off = (ba - s.memAddr!) >>> 0;
          if (off < memSize(s.instr.op)) {
            byte = (s.memValue! >>> (8 * off)) & 0xff;
            from.add(sid);
            break;
          }
        }
        raw |= (byte ?? this.mem.read8(ba)) << (8 * k);
      }
      const op = x.instr.op;
      x.result = op === 'lb' ? (raw << 24) >> 24 : op === 'lh' ? (raw << 16) >> 16 : op === 'lw' ? raw | 0 : raw;
      x.memAddr = addr >>> 0;
      x.memValue = x.result;
      if (from.size) {
        x.forwardedFrom = [...from].sort((q, r) => q - r);
        detail = ` Address ${hex(addr)}: an older store to the same place has not written memory yet, so the value is forwarded from ${x.forwardedFrom.map(u).join(', ')}.`;
      } else detail = ` Address ${hex(addr)}; the data comes from memory.`;
    } else if (x.cls === 'store') {
      x.memAddr = ((a + x.instr.imm) | 0) >>> 0;
      const size = memSize(x.instr.op);
      x.memValue = size === 1 ? b & 0xff : size === 2 ? b & 0xffff : b;
    } else {
      const regs = new Int32Array(32);
      if (x.srcArch[0] !== undefined) regs[x.instr.rs1] = a;
      if (x.srcArch[1] !== undefined) regs[x.instr.rs2] = b;
      regs[0] = 0;
      const scratch: ArchState = { pc: x.pc, regs, mem: new Memory() };
      const rec = execute(x.instr, scratch, 0);
      if (rec.rdValue !== undefined && x.pdst !== null) x.result = rec.rdValue;
      x.actualNext = rec.nextPc;
      if (rec.taken !== undefined) x.taken = rec.taken;
    }
    if (x.actualNext === undefined) x.actualNext = (x.pc + 4) | 0;

    const why = x.psrc.length ? 'its operands are ready and it is the oldest ready instruction this port can take' : 'it has no register operands to wait for and is the oldest one this port can take';
    this.emit('issue', 'issue', `Selected ${u(x.id)} for ${port.name}: ${why}.${operands}${detail} ${m.pipelined[x.cls] ? '' : `The ${CLASS_WORDS[x.cls]} unit is not pipelined, so ${port.name} is blocked until cycle ${done}. `}Result at cycle ${done}.`, [x.id], x.psrc.slice());
    if (x.forwardedFrom) this.emit('issue', 'forward', `Store-to-load forwarding: ${u(x.id)} takes its data from ${x.forwardedFrom.map(u).join(', ')} instead of memory.`, [x.id, ...x.forwardedFrom], [], false);
  }

  // ---- rename and dispatch ----

  private rename() {
    const m = this.machine;
    let n = 0;
    let stall: string | null = null;
    let frontEmpty = false;
    while (n < m.width.rename) {
      const id = this.decodeQ[0];
      if (id === undefined || this.uops[id]!.t.decode! >= this.cycle) {
        frontEmpty = true;
        break;
      }
      const x = this.uops[id]!;
      if (this.rob.length >= m.rob) {
        stall = `the ROB is full (${m.rob} entries); the oldest instruction ${u(this.rob[0]!)} must retire first`;
        break;
      }
      if (this.iq.length >= m.iq) {
        stall = `the issue queue is full (${m.iq} entries); nothing can enter until an instruction issues`;
        break;
      }
      if (x.dstArch !== null && this.freeList.length === 0) {
        stall = `there is no free physical register for ${regName(x.dstArch)}; one is freed only when an instruction that overwrote a register retires`;
        break;
      }
      this.decodeQ.shift();
      n++;
      this.counters.INST_SPEC++;
      x.t.rename = this.cycle;
      x.psrc = x.srcArch.map((r) => this.rat[r]!);
      const srcText = x.srcArch.flatMap((r, k) => {
        const pr = x.psrc[k]!;
        if (x.srcArch.indexOf(r) !== k) return [];
        if (r === 0) return `zero is hard-wired (${p(0)})`;
        return `${regName(r)} is in ${p(pr)} (${this.prfReady[pr] ? 'ready' : `not ready yet${this.producerNote(pr)}`})`;
      });
      let dstText = '';
      if (x.dstArch !== null) {
        const pd = this.freeList.shift()!;
        x.pdst = pd;
        x.oldPdst = this.rat[x.dstArch]!;
        this.rat[x.dstArch] = pd;
        this.prfReady[pd] = false;
        this.producer.set(pd, id);
        dstText = ` Its result for ${regName(x.dstArch)} gets the free register ${p(pd)}, so later readers of ${regName(x.dstArch)} wait for this instruction and not for anyone else. The old copy ${p(x.oldPdst)} stays alive until this instruction retires.`;
      }
      if (x.cls === 'branch' || x.cls === 'jump') {
        const int = this.internal.get(id)!;
        int.ratCheckpoint = this.rat.slice();
      }
      this.rob.push(id);
      this.iq.push(id);
      const cp = x.cls === 'branch' || x.cls === 'jump' ? ' The RAT is checkpointed here in case this control transfer was mispredicted.' : '';
      this.emit(
        'rename',
        'rename',
        `Renamed ${u(id)}: ${srcText.length ? srcText.join('; ') + '.' : 'no register sources.'}${dstText} Dispatched to ROB entry ${this.rob.length - 1} (counting from the head) and to the issue queue.${cp}`,
        [id, ...x.psrc.map((r) => this.producer.get(r)).filter((v): v is number => v !== undefined && v !== id)],
        [...x.psrc.filter((r) => r !== 0), ...(x.pdst !== null ? [x.pdst, x.oldPdst!] : [])],
      );
    }
    const empty = m.width.rename - n;
    if (stall) {
      this.counters.STALL_SLOT_BACKEND += empty;
      this.emit('rename', 'rename-stall', `Rename stalls${n ? ` after ${n}` : ''}: ${stall}. This is a back-end stall.`, [this.decodeQ[0]!], [], true);
    } else if (frontEmpty && empty > 0) {
      this.counters.STALL_SLOT_FRONTEND += empty;
      if (n === 0 && !this.fetchStopped) this.emit('rename', 'rename-stall', `Nothing to rename: no decoded instructions are waiting (fetch: ${this.fetchState}). These empty rename slots count as a front-end stall.`, [], [], true);
    }
  }

  // ---- decode ----

  private decode() {
    const m = this.machine;
    const moved: number[] = [];
    while (moved.length < m.width.fetch && this.fetchQ.length && this.decodeQ.length < m.fetchBuffer) {
      const id = this.fetchQ[0]!;
      if (this.uops[id]!.t.fetch >= this.cycle) break;
      this.fetchQ.shift();
      this.decodeQ.push(id);
      this.uops[id]!.t.decode = this.cycle;
      moved.push(id);
    }
    if (moved.length) {
      const desc = moved.map((id) => {
        const x = this.uops[id]!;
        const srcs = x.srcArch.filter((r) => r !== 0).map(regName);
        const what = [srcs.length ? `reads ${[...new Set(srcs)].join(', ')}` : '', x.dstArch !== null ? `writes ${regName(x.dstArch)}` : ''].filter(Boolean);
        const article = /^[aeiouAEIOU]/.test(CLASS_WORDS[x.cls]) ? 'an' : 'a';
        return `${u(id)} is ${article} ${CLASS_WORDS[x.cls]} op${what.length ? ` that ${what.join(' and ')}` : ''}`;
      });
      this.emit('decode', 'decode', `Decoded: ${desc.join('; ')}.`, moved);
    }
  }

  // ---- fetch and prediction ----

  private predict(instr: Instr, pc: number, int: Internal): Prediction {
    const m = this.machine;
    const bp = m.branchPredictor;
    const cls = opClass(instr.op);
    const hmask = (1 << bp.historyBits) - 1;
    int.ghrBefore = this.ghr;
    if (cls === 'system') return { kind: 'halt', next: pc + 4, reason: `${instr.op} halts the machine, so fetch stops here.` };
    if (instr.op === 'jal') {
      if (instr.rd === 1 && bp.rasDepth > 0) this.pushRas((pc + 4) | 0);
      return { kind: 'direct', next: (pc + instr.imm) | 0, taken: true, reason: `jal: the target ${hex(pc + instr.imm)} is in the instruction, so fetch follows it right away${instr.rd === 1 && bp.rasDepth > 0 ? ` and pushes the return address ${hex(pc + 4)} on the return stack` : ''}.` };
    }
    if (instr.op === 'jalr') {
      const isRet = instr.rd === 0 && instr.rs1 === 1 && instr.imm === 0;
      let pred: Prediction;
      if (isRet && bp.kind !== 'none' && bp.rasDepth > 0 && this.ras.length > 0) {
        const t = this.ras.pop()!;
        pred = { kind: 'predicted', next: t, fromRas: true, reason: `Return: the return address stack says it goes back to ${hex(t)}.` };
      } else {
        pred = { kind: 'stall', next: 0, reason: isRet ? 'Return, but the return address stack is empty or disabled: fetch waits until the target is computed.' : 'Indirect jump: the target comes from a register, so fetch waits until it is computed.' };
      }
      if (instr.rd === 1 && bp.rasDepth > 0) this.pushRas((pc + 4) | 0);
      return pred;
    }
    if (cls !== 'branch') return { kind: 'seq', next: (pc + 4) | 0, reason: '' };

    const target = (pc + instr.imm) | 0;
    const make = (taken: boolean, reason: string, extra: Partial<Prediction> = {}): Prediction => {
      this.ghr = ((this.ghr << 1) | (taken ? 1 : 0)) & hmask;
      return { kind: 'predicted', taken, next: taken ? target : (pc + 4) | 0, reason, ...extra };
    };
    switch (bp.kind) {
      case 'none':
        return { kind: 'stall', next: 0, reason: 'There is no branch predictor, so fetch stops until this branch is resolved in the execute stage.' };
      case 'not-taken':
        return make(false, 'Static prediction: always not taken, so fetch carries on at the next instruction.');
      case 'btfn': {
        const back = instr.imm < 0;
        return make(back, back ? 'Static prediction: backward branch (probably a loop), so predicted taken.' : 'Static prediction: forward branch, so predicted not taken.');
      }
      case 'bimodal':
      case 'gshare': {
        const mask = (1 << bp.tableBits) - 1;
        const idx = bp.kind === 'bimodal' ? (pc >>> 2) & mask : ((pc >>> 2) ^ this.ghr) & mask;
        const ctr = this.pht![idx]!;
        const taken = ctr >= 2;
        const how =
          bp.kind === 'bimodal'
            ? `PHT[${idx}] (indexed by the branch address)`
            : `PHT[${idx}] (branch address XOR global history ${this.ghr.toString(2).padStart(bp.historyBits, '0')})`;
        return make(taken, `${how} holds ${ctr}, "${COUNTER_NAMES[ctr]}", so predicted ${taken ? 'taken' : 'not taken'}.`, { phtIndex: idx, counter: ctr, ghr: this.ghr });
      }
    }
  }

  private pushRas(addr: number) {
    this.ras.push(addr);
    if (this.ras.length > this.machine.branchPredictor.rasDepth) this.ras.shift();
  }

  private fetch() {
    const m = this.machine;
    if (this.fetchStopped) {
      this.fetchState = 'stopped after fetching a halt instruction';
      return;
    }
    if (this.fetchBlockedBy !== null) {
      this.fetchState = `waiting for #${this.fetchBlockedBy} to resolve`;
      this.emit('fetch', 'fetch-stall', `Fetch is stalled: it does not know where to go after ${u(this.fetchBlockedBy)} until that instruction executes.`, [this.fetchBlockedBy], [], true);
      return;
    }
    if (this.cycle < this.fetchResume) {
      this.fetchState = 'redirect bubble';
      this.emit('fetch', 'fetch-stall', `No fetch this cycle: the front end is being redirected to the correct path after a mispredict, and fetch restarts in cycle ${this.fetchResume}.`, [], [], true);
      return;
    }
    const got: number[] = [];
    const startPc = this.fetchPc;
    let missing = false;
    while (got.length < m.width.fetch) {
      if (this.fetchQ.length >= m.fetchBuffer) {
        if (!got.length) this.emit('fetch', 'fetch-stall', 'Fetch is stalled: the fetch buffer is full because decode is backed up.', [], [], true);
        break;
      }
      const off = this.fetchPc - this.program.textBase;
      const instr = off >= 0 && off % 4 === 0 ? this.program.instrs[off / 4] : undefined;
      if (!instr) {
        missing = true;
        break;
      }
      const id = this.uops.length;
      const int: Internal = {};
      const pred = this.predict(instr, this.fetchPc, int);
      const srcArch = sourceRegs(instr);
      const x: Uop = {
        id,
        pc: this.fetchPc,
        instr,
        text: formatInstr(instr),
        cls: opClass(instr.op),
        pred,
        srcArch,
        psrc: [],
        dstArch: destReg(instr),
        pdst: null,
        oldPdst: null,
        port: null,
        t: { fetch: this.cycle },
      };
      if (x.cls === 'branch' || x.cls === 'jump') int.rasAfter = this.ras.slice();
      this.uops.push(x);
      this.internal.set(id, int);
      this.fetchQ.push(id);
      got.push(id);
      if (pred.kind === 'stall') {
        this.fetchBlockedBy = id;
        break;
      }
      if (pred.kind === 'halt') {
        this.fetchStopped = true;
        break;
      }
      this.fetchPc = pred.next;
      if (pred.kind !== 'seq' && pred.next !== x.pc + 4) break; // a taken branch ends the fetch group
    }
    if (got.length) {
      this.fetchState = 'fetching';
      this.emit('fetch', 'fetch', `Fetched ${got.map(u).join(', ')} from ${hex(startPc)}.`, got);
      for (const id of got) {
        const x = this.uops[id]!;
        if (x.pred.kind !== 'seq') this.emit('fetch', 'predict', `${u(id)}: ${x.pred.reason}`, [id]);
      }
    }
    if (missing) {
      this.fetchState = `no instruction at ${hex(this.fetchPc)}`;
      if (!got.length) this.emit('fetch', 'fetch-stall', `Fetch is stalled: there is no instruction at ${hex(this.fetchPc)} (possibly a wrong path; a mispredict will redirect it).`, [], [], true);
    }
  }

  /** Halt when the correct path has run off the program and nothing is in flight. */
  private checkEnd() {
    if (this.rob.length || this.fetchQ.length || this.decodeQ.length) return;
    if (this.fetchBlockedBy !== null || this.cycle < this.fetchResume || this.fetchStopped) return;
    const off = this.fetchPc - this.program.textBase;
    const has = off >= 0 && off % 4 === 0 && off / 4 < this.program.instrs.length;
    if (has) return;
    this.halted = this.fetchPc === this.textEnd ? 'end' : 'bad-pc';
    this.emit('commit', 'halt', `Nothing is left in flight and there is no instruction at ${hex(this.fetchPc)}: the program ${this.halted === 'end' ? 'ran off its end' : 'jumped outside the code'}.`);
  }
}

/** Run a program on a machine, recording a snapshot per cycle. */
export function simulate(program: Program, machine: MachineDesc, opts: SimOptions = {}): SimResult {
  const maxCycles = opts.maxCycles ?? 100_000;
  const record = opts.snapshots ?? true;
  const core = new OoOCore(program, machine);
  const snapshots: Snapshot[] = record ? [core.snapshot()] : [];
  let halt: HaltReason | null = null;
  while (core.cycle < maxCycles) {
    core.step();
    if (record) snapshots.push(core.snapshot());
    if (core.halted) {
      halt = core.halted;
      break;
    }
  }
  return {
    machine,
    snapshots,
    uops: core.uops,
    state: core.archState(),
    halt: halt ?? 'limit',
    cycles: core.cycle,
    retired: core.retiredCount,
    counters: core.getCounters(),
  };
}

/** Status of a uop at the end of a given cycle, derived from its timeline. */
export function uopStatus(x: Uop, cycle: number): UopStatus | null {
  const t = x.t;
  if (t.fetch > cycle) return null;
  if (t.flush !== undefined && t.flush <= cycle) return 'flushed';
  if (t.commit !== undefined && t.commit <= cycle) return 'committed';
  if (t.complete !== undefined && t.complete <= cycle) return 'done';
  if (t.issue !== undefined && t.issue <= cycle) return 'executing';
  if (t.rename !== undefined && t.rename <= cycle) return 'waiting';
  if (t.decode !== undefined && t.decode <= cycle) return 'decoded';
  return 'fetched';
}
