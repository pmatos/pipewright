import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assemble,
  SERVER,
  NARROW,
  plainText,
  PRESETS,
  runProgram,
  simulate,
  TEACHING,
  type MachineDesc,
  type PredictorKind,
  type Program,
} from '../src/core';

const dir = join(__dirname, '..', 'programs');
const files = readdirSync(dir).filter((f) => f.endsWith('.s'));
const load = (name: string) => assemble(readFileSync(join(dir, name), 'utf8'));

const PREDICTORS: PredictorKind[] = ['none', 'not-taken', 'btfn', 'bimodal', 'gshare'];

function withPredictor(m: MachineDesc, kind: PredictorKind): MachineDesc {
  return { ...m, name: `${m.name}/${kind}`, branchPredictor: { ...m.branchPredictor, kind } };
}

/** The golden check: same committed stream and final state as the interpreter. */
function golden(program: Program, machine: MachineDesc) {
  const ref = runProgram(program, { trace: true });
  const sim = simulate(program, machine, { snapshots: false, maxCycles: 2_000_000 });
  expect(sim.halt).toBe(ref.halt);
  expect(sim.retired).toBe(ref.retired);
  const committed = sim.uops.filter((x) => x.t.commit !== undefined).sort((a, b) => a.retireSeq! - b.retireSeq!);
  expect(committed.map((x) => x.pc)).toEqual(ref.trace.map((r) => r.pc));
  expect(Array.from(sim.state.regs)).toEqual(Array.from(ref.state.regs));
  expect(sim.state.mem.nonZeroBytes()).toEqual(ref.state.mem.nonZeroBytes());
  expect(sim.state.pc).toBe(ref.state.pc);
  return sim;
}

describe('out-of-order core: golden tests against the interpreter', () => {
  for (const f of files) {
    for (const preset of Object.values(PRESETS)) {
      it(`${f} on ${preset.name}`, () => {
        golden(load(f), preset);
      });
    }
    for (const kind of PREDICTORS) {
      it(`${f} on teaching with predictor ${kind}`, () => {
        golden(load(f), withPredictor(TEACHING, kind));
      });
    }
  }

  it('a tiny machine (minimum registers, 1-entry queues) still runs correctly', () => {
    const tiny: MachineDesc = { ...NARROW, name: 'tiny', rob: 1, iq: 1, physRegs: 33, fetchBuffer: 1 };
    for (const f of files) golden(load(f), tiny);
  });

  it('a program that falls off the end halts with "end"', () => {
    golden(assemble('li a0, 1\naddi a0, a0, 2'), TEACHING);
  });
});

describe('out-of-order core: behaviour', () => {
  it('renaming lets independent work overtake a slow multiply', () => {
    const sim = simulate(load('rename_demo.s'), TEACHING);
    const byText = (t: string) => sim.uops.find((x) => x.text === t && x.t.commit !== undefined)!;
    const mul = byText('mul t0, a1, a2');
    const li7 = byText('addi t0, zero, 7');
    expect(li7.t.issue!).toBeLessThan(mul.t.complete!);
    expect(li7.pdst).not.toBe(mul.pdst);
    // But it still retires in order.
    expect(li7.t.commit!).toBeGreaterThanOrEqual(mul.t.commit!);
    const renameText = sim.snapshots.flatMap((s) => s.events).filter((e) => e.kind === 'rename' && e.uops[0] === li7.id)[0]!.text;
    expect(renameText).toContain('gets the free register');
  });

  it('a dependent chain does not speed up with width; independent adds do', () => {
    const chainNarrow = simulate(load('dependent_chain.s'), NARROW, { snapshots: false });
    const chainBig = simulate(load('dependent_chain.s'), SERVER, { snapshots: false });
    const indNarrow = simulate(load('independent_adds.s'), NARROW, { snapshots: false });
    const indBig = simulate(load('independent_adds.s'), SERVER, { snapshots: false });
    const ipc = (r: { retired: number; cycles: number }) => r.retired / r.cycles;
    expect(ipc(indBig) / ipc(indNarrow)).toBeGreaterThan(1.8);
    expect(ipc(chainBig) / ipc(chainNarrow)).toBeLessThan(ipc(indBig) / ipc(indNarrow));
    expect(ipc(indBig)).toBeGreaterThan(1.5);
  });

  it('mispredicts flush the wrong path and recover', () => {
    const sim = simulate(load('branchy.s'), withPredictor(TEACHING, 'not-taken'));
    expect(sim.counters.BR_MIS_PRED_RETIRED).toBeGreaterThan(0);
    expect(sim.counters.UOPS_FLUSHED).toBeGreaterThan(0);
    const events = sim.snapshots.flatMap((s) => s.events);
    const mp = events.find((e) => e.kind === 'mispredict')!;
    expect(plainText(mp.text, sim.uops)).toMatch(/Mispredict!.*RAT is restored/);
    expect(sim.uops.some((x) => x.t.flush !== undefined && x.t.rename !== undefined)).toBe(true);
  });

  it('a better predictor means fewer mispredicts on the loop branch', () => {
    const nt = simulate(load('branchy.s'), withPredictor(TEACHING, 'not-taken'), { snapshots: false });
    const bim = simulate(load('branchy.s'), withPredictor(TEACHING, 'bimodal'), { snapshots: false });
    expect(bim.counters.BR_MIS_PRED_RETIRED).toBeLessThan(nt.counters.BR_MIS_PRED_RETIRED);
  });

  it('with no predictor fetch stalls at every branch and nothing is flushed', () => {
    const sim = simulate(load('branchy.s'), withPredictor(TEACHING, 'none'));
    expect(sim.counters.UOPS_FLUSHED).toBe(0);
    expect(sim.snapshots.flatMap((s) => s.events).some((e) => e.kind === 'fetch-stall' && e.text.includes('does not know where to go'))).toBe(true);
  });

  it('store-to-load forwarding supplies the load before the store commits', () => {
    const sim = simulate(load('store_forward.s'), TEACHING);
    const st = sim.uops.find((x) => x.instr.op === 'sw')!;
    const ld = sim.uops.find((x) => x.instr.op === 'lw')!;
    expect(ld.forwardedFrom).toEqual([st.id]);
    expect(ld.t.issue!).toBeLessThan(st.t.commit!);
    expect(ld.result).toBe(5);
  });

  it('the return address stack predicts returns', () => {
    const sim = simulate(load('factorial.s'), TEACHING);
    const rets = sim.uops.filter((x) => x.instr.op === 'jalr' && x.t.commit !== undefined);
    expect(rets.length).toBeGreaterThan(0);
    expect(rets.some((x) => x.pred.fromRas && !x.mispredicted)).toBe(true);
  });

  it('snapshots are self-consistent every cycle', () => {
    const sim = simulate(load('collatz.s'), TEACHING, { maxCycles: 3000 });
    for (const s of sim.snapshots) {
      expect(s.rob.length).toBeLessThanOrEqual(TEACHING.rob);
      expect(s.iq.length).toBeLessThanOrEqual(TEACHING.iq);
      // Every physical register is exactly one of: free, mapped in the committed
      // RAT, or the destination of an in-flight ROB entry.
      const inFlight = s.rob.map((id) => sim.uops[id]!.pdst).filter((p): p is number => p !== null);
      const all = [...s.freeList, ...new Set(s.rrat), ...inFlight].sort((a, b) => a - b);
      expect(all).toEqual(Array.from({ length: TEACHING.physRegs }, (_, i) => i));
    }
  });
});
