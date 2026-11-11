import { useMemo, useState } from 'react';
import { simulate, type MachineDesc, type Program, type SimResult } from '../core';
import { buildMachine, MachinePicker, MAX_UI_CYCLES, type MachineChoice } from './picker';
import { PipelineDiagram } from './panels';
import { related, ViewContext, type Focus, type View } from './view';

interface Props {
  program: Program;
  a: MachineChoice;
  b: MachineChoice;
  setA: (c: MachineChoice) => void;
  setB: (c: MachineChoice) => void;
}

/** Level 1 top-down from rename slots: where each slot of width went. */
export function topDown(r: SimResult) {
  const c = r.counters;
  const slots = c.CPU_CYCLES * r.machine.width.rename || 1;
  const retiring = c.INST_RETIRED;
  const badSpec = c.INST_SPEC - c.INST_RETIRED;
  const fe = c.STALL_SLOT_FRONTEND;
  const be = c.STALL_SLOT_BACKEND;
  const rest = Math.max(0, slots - retiring - badSpec - fe - be);
  return { slots, parts: [
    { key: 'retiring', label: 'Retiring', v: retiring, d: 'slots that held an instruction which went on to retire: useful work' },
    { key: 'badspec', label: 'Bad speculation', v: badSpec, d: 'slots spent renaming wrong-path instructions that a mispredict threw away' },
    { key: 'frontend', label: 'Front-end bound', v: fe + rest, d: 'slots left empty because fetch and decode had nothing to deliver (branches, redirects)' },
    { key: 'backend', label: 'Back-end bound', v: be, d: 'slots left empty because the ROB, issue queue or free list was full, usually waiting on long-latency work' },
  ] };
}

const PARAMS: { label: string; get: (m: MachineDesc) => string | number; why: string }[] = [
  { label: 'Width (fetch/rename/commit)', get: (m) => `${m.width.fetch}/${m.width.rename}/${m.width.commit}`, why: 'The peak number of instructions per cycle. Cost grows faster than linearly: rename must compare every instruction in a group against the others, and the RAT needs more ports.' },
  { label: 'ROB entries', get: (m) => m.rob, why: 'How far ahead of the oldest unfinished instruction the core can look for independent work. It is what hides a slow load or divide.' },
  { label: 'Issue queue entries', get: (m) => m.iq, why: 'How many waiting instructions wakeup/select can watch. Every entry compares its tags with every result each cycle, so this is one of the most power-hungry structures.' },
  { label: 'Physical registers', get: (m) => m.physRegs, why: 'Bounds how many results can be in flight: physRegs - 32 renamed writers at once.' },
  { label: 'Execution ports', get: (m) => m.ports.map((p) => p.name).join(' '), why: 'How many instructions can start per cycle, and of which kind.' },
  { label: 'Branch predictor', get: (m) => `${m.branchPredictor.kind}${m.branchPredictor.kind === 'bimodal' || m.branchPredictor.kind === 'gshare' ? `, ${1 << m.branchPredictor.tableBits} counters` : ''}${m.branchPredictor.kind === 'gshare' ? `, ${m.branchPredictor.historyBits}-bit history` : ''}`, why: 'A wide, deep core fetches far ahead, so it loses more on every mispredict and needs a stronger predictor. Bigger tables also take longer to warm up.' },
  { label: 'Redirect penalty', get: (m) => `${m.redirectPenalty} cycles`, why: 'Extra front-end bubbles after a mispredict. Deeper pipelines (needed for high clock speeds) pay more.' },
  { label: 'Latencies (mul/div/load)', get: (m) => `${m.latency.mul}/${m.latency.div}/${m.latency.load}`, why: 'Cycles before a dependent instruction can use the result.' },
];

export function Compare({ program, a, b, setA, setB }: Props) {
  const ma = useMemo(() => buildMachine(a), [a]);
  const mb = useMemo(() => buildMachine(b), [b]);
  const full = useMemo(() => [ma, mb].map((m) => simulate(program, m, { snapshots: false, maxCycles: 300_000 })), [program, ma, mb]);
  const stepped = useMemo(() => [ma, mb].map((m) => simulate(program, m, { maxCycles: MAX_UI_CYCLES })), [program, ma, mb]);
  const [cycle, setCycle] = useState(0);
  const last = Math.max(stepped[0]!.snapshots.length, stepped[1]!.snapshots.length) - 1;
  const [ra, rb] = full as [SimResult, SimResult];
  const ipc = (r: SimResult) => r.retired / Math.max(1, r.cycles);
  const rows: [string, (r: SimResult) => string | number][] = [
    ['Cycles', (r) => r.cycles + (r.halt === 'limit' ? '+' : '')],
    ['Instructions retired', (r) => r.retired],
    ['IPC', (r) => ipc(r).toFixed(2)],
    ['Mispredicts', (r) => r.counters.BR_MIS_PRED_RETIRED],
    ['Wrong-path instructions squashed', (r) => r.counters.UOPS_FLUSHED],
  ];
  return (
    <>
      <section className="toolbar">
        <MachinePicker label="A" value={a} onChange={setA} />
        <MachinePicker label="B" value={b} onChange={setB} />
      </section>
      <p className="hint">
        Same program, same ISA, same results: only the microarchitecture differs. B takes{' '}
        <b>{(rb.cycles / Math.max(1, ra.cycles)).toFixed(2)}×</b> the cycles of A ({rb.cycles} vs {ra.cycles}).{' '}
        {rb.cycles < ra.cycles ? 'B is faster' : rb.cycles > ra.cycles ? 'A is faster' : 'They tie'} on this program; try the dependent chain and the independent adds to see when width helps and when it cannot.
      </p>
      <div className="cmp-grid">
        <div className="panel">
          <h3>Results</h3>
          <table className="counters">
            <thead>
              <tr>
                <th></th>
                <th>A: {ma.name}</th>
                <th>B: {mb.name}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([k, f]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td className="num">{f(ra)}</td>
                  <td className="num">{f(rb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Where the rename slots went (top-down level 1)</h4>
          {[ra, rb].map((r, i) => (
            <TopDownBar key={i} r={r} label={i === 0 ? 'A' : 'B'} />
          ))}
          <p className="muted small">
            Each cycle the core has <i>width</i> rename slots. A slot either carries an instruction that retires, carries one that gets squashed,
            or stays empty because the front end starved it or the back end was full. This is the Arm/Intel top-down method at level 1.
          </p>
        </div>
        <div className="panel">
          <h3>How the two designs differ</h3>
          <table className="params">
            <thead>
              <tr>
                <th></th>
                <th>A: {ma.name}</th>
                <th>B: {mb.name}</th>
                <th>what it buys, what it costs</th>
              </tr>
            </thead>
            <tbody>
              {PARAMS.map((p) => {
                const va = p.get(ma);
                const vb = p.get(mb);
                return (
                  <tr key={p.label} className={va !== vb ? 'diff' : ''}>
                    <td>{p.label}</td>
                    <td>{va}</td>
                    <td>{vb}</td>
                    <td className="muted">{p.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {ma.description && (
            <p className="small">
              <b>A:</b> {ma.description}
            </p>
          )}
          {mb.description && (
            <p className="small">
              <b>B:</b> {mb.description}
            </p>
          )}
        </div>
      </div>
      <section className="transport">
        <button onClick={() => setCycle(Math.max(0, cycle - 1))}>◀ Back</button>
        <button onClick={() => setCycle(Math.min(last, cycle + 1))}>Step ▶</button>
        <input type="range" min={0} max={last} value={cycle} onChange={(e) => setCycle(Number(e.target.value))} />
        <span className="cycle">
          cycle <b>{cycle}</b> on both cores
        </span>
      </section>
      <div className="cmp-grid">
        {stepped.map((s, i) => (
          <Side key={i} sim={s} cycle={cycle} label={i === 0 ? 'A' : 'B'} setCycle={setCycle} />
        ))}
      </div>
    </>
  );
}

function TopDownBar({ r, label }: { r: SimResult; label: string }) {
  const td = topDown(r);
  return (
    <div className="td">
      <span className="tdl">{label}</span>
      <div className="tdbar">
        {td.parts.map((p) =>
          p.v > 0 ? (
            <div key={p.key} className={`tdseg td-${p.key}`} style={{ flexGrow: p.v }} title={`${p.label}: ${((100 * p.v) / td.slots).toFixed(0)}%. ${p.d}`}>
              {(100 * p.v) / td.slots >= 9 ? `${p.label} ${((100 * p.v) / td.slots).toFixed(0)}%` : ''}
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function Side({ sim, cycle, label, setCycle }: { sim: SimResult; cycle: number; label: string; setCycle: (c: number) => void }) {
  const [hover, setHover] = useState<Focus>(null);
  const c = Math.min(cycle, sim.snapshots.length - 1);
  const snap = sim.snapshots[c]!;
  const rel = related(sim, snap, hover);
  const view: View = { sim, cycle: c, snap, prev: sim.snapshots[c - 1], focus: hover, pinned: null, setHover, togglePin: () => undefined, goto: setCycle, hlUops: rel.uops, hlPregs: rel.pregs };
  const m = sim.machine;
  const bar = (n: number, cap: number) => (
    <span className="occ">
      <span style={{ width: `${(100 * n) / cap}%` }} />
    </span>
  );
  return (
    <ViewContext.Provider value={view}>
      <div className="side">
        <h3>
          {label}: {m.name} {c < cycle && <span className="muted">(finished at cycle {c})</span>}
        </h3>
        <div className="kv">
          <span>ROB</span>
          <span>
            {bar(snap.rob.length, m.rob)} {snap.rob.length}/{m.rob}
          </span>
          <span>Issue queue</span>
          <span>
            {bar(snap.iq.length, m.iq)} {snap.iq.length}/{m.iq}
          </span>
          <span>Free registers</span>
          <span>
            {bar(snap.freeList.length, m.physRegs - 32)} {snap.freeList.length}/{m.physRegs - 32}
          </span>
          <span>Retired</span>
          <span>
            {snap.counters.INST_RETIRED} (IPC {(snap.counters.INST_RETIRED / Math.max(1, snap.cycle)).toFixed(2)})
          </span>
        </div>
        <PipelineDiagram />
      </div>
    </ViewContext.Provider>
  );
}
