import { Fragment, useMemo } from 'react';
import { hex, regName, type CoreEvent, type Stage } from '../core';
import { CELL_TITLE, cellAt, changedPregs } from './model';
import { Explain, PregChip, Rich, statusOf, UopChip, useView } from './view';

// ---------------------------------------------------------------------------
// Narration: what happened this cycle, and why

const STAGE_ORDER: Stage[] = ['fetch', 'decode', 'rename', 'issue', 'writeback', 'commit'];
const STAGE_TITLE: Record<Stage, string> = {
  fetch: 'Fetch and predict',
  decode: 'Decode',
  rename: 'Rename and dispatch',
  issue: 'Issue (wakeup and select)',
  writeback: 'Writeback and branch resolution',
  commit: 'Commit (retire in order)',
};

export function Narration({ showWhy }: { showWhy: boolean }) {
  const v = useView();
  const events = v.snap.events;
  const byStage = useMemo(() => {
    const m = new Map<Stage, CoreEvent[]>();
    for (const e of events) {
      if (e.why && !showWhy) continue;
      m.set(e.stage, [...(m.get(e.stage) ?? []), e]);
    }
    return m;
  }, [events, showWhy]);

  if (v.cycle === 0)
    return (
      <div className="narration empty">
        <p>
          The program is loaded: its instructions sit in instruction memory, every architectural register <code>x0..x31</code> is mapped to
          physical registers <code>p0..p31</code>, and the rest of the physical registers are on the free list. Nothing is in flight.
        </p>
        <p>Press <kbd>→</kbd> or <b>Step</b> to run the first cycle.</p>
      </div>
    );

  const summary = summarize(events);
  return (
    <div className="narration">
      <p className="summary">{summary}</p>
      {STAGE_ORDER.filter((s) => byStage.has(s)).map((s) => (
        <section key={s} className={`stage stage-${s}`}>
          <h4>{STAGE_TITLE[s]}</h4>
          <ul>
            {byStage.get(s)!.map((e, i) => (
              <li key={i} className={`ev ev-${e.kind}${e.why ? ' why' : ''}`}>
                <Rich text={e.text} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {byStage.size === 0 && <p className="muted">Nothing visible happened this cycle.</p>}
    </div>
  );
}

function summarize(events: CoreEvent[]): string {
  const count = (k: CoreEvent['kind']) => events.filter((e) => e.kind === k).length;
  const fetched = events.filter((e) => e.kind === 'fetch').reduce((n, e) => n + e.uops.length, 0);
  const parts = [
    fetched && `fetched ${fetched}`,
    count('rename') && `renamed ${count('rename')}`,
    count('issue') && `issued ${count('issue')}`,
    count('writeback') + count('wakeup') + count('resolve') + count('mispredict') && `completed ${count('writeback') + count('wakeup') + count('resolve') + count('mispredict')}`,
    count('commit') && `retired ${count('commit')}`,
  ].filter(Boolean);
  const mp = count('mispredict') ? ' A branch was mispredicted.' : '';
  return (parts.length ? `This cycle the core ${parts.join(', ')}.` : 'No instruction moved this cycle.') + mp;
}

// ---------------------------------------------------------------------------
// Program listing with in-flight markers

export function ProgramListing({ instrs }: { instrs: { pc: number; text: string; source: string; line: number }[] }) {
  const v = useView();
  const { sim, snap } = v;
  const inflight = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const id of [...snap.fetchQ, ...snap.decodeQ, ...snap.rob]) {
      const x = sim.uops[id]!;
      m.set(x.pc, [...(m.get(x.pc) ?? []), id]);
    }
    return m;
  }, [sim, snap]);
  return (
    <div className="listing">
      {instrs.map((i) => (
        <div key={i.pc} className={`lrow${snap.fetchPc === i.pc && !snap.halted ? ' fetchpc' : ''}`} title={`line ${i.line}: ${i.source}`}>
          <span className="arrow">{snap.fetchPc === i.pc && !snap.halted ? '▶' : ''}</span>
          <span className="pc">{hex(i.pc).slice(2)}</span>
          <code>{i.text}</code>
          <span className="marks">
            {(inflight.get(i.pc) ?? []).map((id) => (
              <UopChip key={id} id={id} full={false} />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Front end: fetch buffer and decode queue

export function FrontEnd() {
  const v = useView();
  const { snap, sim } = v;
  return (
    <div className="panel">
      <h3>Front end</h3>
      <Explain>
        <b>Fetch</b> reads up to {sim.machine.width.fetch} instructions per cycle at the fetch PC. It cannot wait for branches to execute, so the{' '}
        <b>branch predictor</b> guesses the next PC and fetch carries on down the guessed path. <b>Decode</b> works out each instruction's class
        and which registers it reads and writes.
      </Explain>
      <div className="kv">
        <span>Fetch PC</span>
        <code>{hex(snap.fetchPc)}</code>
        <span>Fetch unit</span>
        <span>{snap.halted ? 'halted' : snap.fetchState}</span>
      </div>
      <QueueRow title={`Fetch buffer (${snap.fetchQ.length}/${sim.machine.fetchBuffer})`} ids={snap.fetchQ} />
      <QueueRow title={`Decode queue (${snap.decodeQ.length}/${sim.machine.fetchBuffer})`} ids={snap.decodeQ} />
    </div>
  );
}

function QueueRow({ title, ids }: { title: string; ids: number[] }) {
  return (
    <div className="queue">
      <div className="qtitle">{title}</div>
      <div className="qitems">{ids.length ? ids.map((id) => <UopChip key={id} id={id} />) : <span className="muted">empty</span>}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rename: RAT and free list

export function RenamePanel() {
  const v = useView();
  const { snap, prev, sim } = v;
  return (
    <div className="panel">
      <h3>Register alias table and free list</h3>
      <Explain>
        Architectural registers such as <code>a0</code> or <code>t0</code> are only names. The <b>register alias table (RAT)</b> maps each name to
        the <b>physical register</b> holding its newest value. Every instruction that writes a register is given a fresh physical register from
        the <b>free list</b>, so two writes to <code>t0</code> never clash and an instruction only waits for the values it really needs. The{' '}
        <b>committed RAT</b> is the same map as of the last retired instruction: the real architectural state, and what a mispredict could
        never undo. A register goes back on the free list when the next writer of the same name retires.
      </Explain>
      <table className="rat">
        <thead>
          <tr>
            <th>reg</th>
            <th>RAT (newest)</th>
            <th>committed</th>
            <th>reg</th>
            <th>RAT (newest)</th>
            <th>committed</th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 16 }, (_, row) => (
            <tr key={row}>
              {[row, row + 16].map((r) => {
                const changed = prev && prev.rat[r] !== snap.rat[r];
                const spec = snap.rat[r] !== snap.rrat[r];
                return (
                  <Fragment key={r}>
                    <td className={`rname${changed ? ' flash' : ''}`}>{regName(r)}</td>
                    <td className={spec ? 'spec' : ''}>
                      <PregChip n={snap.rat[r]!} />
                    </td>
                    <td>
                      <PregChip n={snap.rrat[r]!} />
                    </td>
                  </Fragment>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="queue">
        <div className="qtitle">
          Free list ({snap.freeList.length}/{sim.machine.physRegs - 32}), next to hand out first
        </div>
        <div className="qitems">
          {snap.freeList.length ? snap.freeList.map((n) => <PregChip key={n} n={n} />) : <span className="muted">empty: rename stalls on writers</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Physical register file

export function RegFilePanel() {
  const v = useView();
  const { snap, prev } = v;
  const changed = useMemo(() => changedPregs(prev, snap), [prev, snap]);
  const free = new Set(snap.freeList);
  return (
    <div className="panel">
      <h3>Physical register file</h3>
      <Explain>
        The values live here. Each physical register has a <b>ready bit</b>: clear while the instruction that writes it is still on its way,
        set when the result is written back. Instructions in the issue queue watch these bits (via tag broadcast) to know when they may go.
        Dim entries are free.
      </Explain>
      <div className="prf">
        {snap.prfValue.map((val, n) => {
          const cls = ['preg-cell', snap.prfReady[n] ? 'ready' : 'notready'];
          if (free.has(n)) cls.push('free');
          if (changed.has(n)) cls.push('flash');
          if (v.hlPregs.has(n)) cls.push('hl');
          return (
            <div key={n} className={cls.join(' ')} onMouseEnter={() => v.setHover({ kind: 'preg', n })} onMouseLeave={() => v.setHover(null)} onClick={() => v.togglePin({ kind: 'preg', n })}>
              <span className="pn">p{n}</span>
              <span className="pv">{free.has(n) ? '' : snap.prfReady[n] ? val : '…'}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROB

export function RobPanel() {
  const v = useView();
  const { snap, sim, cycle } = v;
  return (
    <div className="panel">
      <h3>
        Reorder buffer ({snap.rob.length}/{sim.machine.rob})
      </h3>
      <Explain>
        The <b>reorder buffer (ROB)</b> holds every in-flight instruction in program order. Instructions execute out of order, but they{' '}
        <b>retire from the head in order</b>, up to {sim.machine.width.commit} per cycle. Retiring is when a result becomes architectural state
        and a store writes memory. That is what makes it safe to execute speculatively: anything still in the ROB can be thrown away.
      </Explain>
      <table className="rob">
        <thead>
          <tr>
            <th></th>
            <th>instruction</th>
            <th>dest</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {snap.rob.map((id, k) => {
            const x = sim.uops[id]!;
            const st = statusOf(x, cycle);
            return (
              <tr key={id} className={`${v.hlUops.has(id) ? 'hl' : ''} ${x.t.rename === cycle ? 'new' : ''}`}>
                <td className="muted">{k === 0 ? 'head' : k}</td>
                <td>
                  <UopChip id={id} />
                </td>
                <td>
                  {x.dstArch !== null && x.pdst !== null ? (
                    <>
                      {regName(x.dstArch)}→<PregChip n={x.pdst} />
                      <span className="muted"> (was </span>
                      <PregChip n={x.oldPdst!} />
                      <span className="muted">)</span>
                    </>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td>
                  <span className={`pill st-${st}`}>{robState(st)}</span>
                  {st === 'done' && x.mispredicted && <span className="pill bad">mispredicted</span>}
                </td>
              </tr>
            );
          })}
          {snap.rob.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                empty
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function robState(st: string): string {
  return st === 'waiting' ? 'waiting to issue' : st === 'executing' ? 'executing' : st === 'done' ? 'done' : st;
}

// ---------------------------------------------------------------------------
// Issue queue and ports

export function IssuePanel() {
  const v = useView();
  const { snap, sim, cycle } = v;
  const m = sim.machine;
  return (
    <div className="panel">
      <h3>
        Issue queue ({snap.iq.length}/{m.iq}) and execution ports
      </h3>
      <Explain>
        Renamed instructions wait in the <b>issue queue</b> (reservation stations) with the tags of the physical registers they read. When an
        instruction writes back, it <b>broadcasts its tag</b> and every waiting entry compares it with its own sources: this is <b>wakeup</b>.
        Each cycle every port then <b>selects</b> the oldest entry whose sources are all ready. Results are visible to dependents in the cycle
        they are written back, so a chain of 1-cycle adds runs back to back.
      </Explain>
      <table className="iq">
        <thead>
          <tr>
            <th>instruction</th>
            <th>sources (● ready, ○ waiting)</th>
            <th>can use</th>
          </tr>
        </thead>
        <tbody>
          {snap.iq.map((id) => {
            const x = sim.uops[id]!;
            return (
              <tr key={id} className={`${v.hlUops.has(id) ? 'hl' : ''} ${x.t.rename === cycle ? 'new' : ''}`}>
                <td>
                  <UopChip id={id} />
                </td>
                <td>
                  {x.psrc.filter((r, k) => r !== 0 && x.psrc.indexOf(r) === k).map((r) => (
                    <span key={r} className="src">
                      {snap.prfReady[r] ? '●' : '○'} <PregChip n={r} />
                    </span>
                  ))}
                  {x.psrc.filter((r) => r !== 0).length === 0 && <span className="muted">none</span>}
                </td>
                <td className="muted">{m.ports.filter((p) => p.classes.includes(x.cls)).map((p) => p.name).join(', ')}</td>
              </tr>
            );
          })}
          {snap.iq.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                empty
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="ports">
        {snap.ports.map((p) => {
          const inUnit = snap.executing.filter((id) => sim.uops[id]!.port === p.name);
          return (
            <div key={p.name} className={`port${p.issued !== null ? ' active' : ''}`}>
              <div className="pname">
                {p.name} <span className="muted">{p.classes.filter((c) => c !== 'system').join(' ')}</span>
              </div>
              {inUnit.map((id) => {
                const x = sim.uops[id]!;
                const done = x.t.issue! + m.latency[x.cls];
                return (
                  <div key={id} className="inunit">
                    <UopChip id={id} />
                    <span className="muted">{done - cycle > 0 ? `${done - cycle} more` : 'writes back next'}</span>
                  </div>
                );
              })}
              {p.busyUntil > cycle && <div className="muted">not pipelined: busy until cycle {p.busyUntil}</div>}
              {inUnit.length === 0 && <div className="muted">idle</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch predictor

export function PredictorPanel() {
  const v = useView();
  const { snap, sim } = v;
  const pr = snap.predictor;
  const used = new Set<number>();
  for (const e of snap.events) if (e.kind === 'predict' || e.kind === 'train') for (const id of e.uops) {
    const i = sim.uops[id]?.pred.phtIndex;
    if (i !== undefined) used.add(i);
  }
  return (
    <div className="panel">
      <h3>Branch predictor: {pr.kind}</h3>
      <Explain>
        {pr.kind === 'none' && 'With no predictor, fetch stops at every branch until it executes: correct, but the front end sits idle.'}
        {pr.kind === 'not-taken' && 'Static: assume every branch falls through. Loop branches, which are usually taken, mispredict every iteration.'}
        {pr.kind === 'btfn' && 'Static: backward branches (loops) predicted taken, forward ones not taken.'}
        {(pr.kind === 'bimodal' || pr.kind === 'gshare') && (
          <>
            A <b>pattern history table (PHT)</b> of 2-bit saturating counters: 0 and 1 predict not taken, 2 and 3 predict taken. A branch moves
            its counter one step toward what it actually did when it retires, so one odd outcome does not flip a strong prediction.{' '}
            {pr.kind === 'bimodal'
              ? 'Bimodal indexes the table with the branch address only.'
              : 'Gshare XORs the branch address with the global history register (the last outcomes of all branches), so the same branch can learn different predictions in different contexts.'}
          </>
        )}{' '}
        The <b>return address stack</b> remembers where each call came from so returns can be predicted. On a mispredict, the history and the
        stack are restored from the state saved with the branch.
      </Explain>
      {pr.pht && (
        <div className="pht">
          {pr.pht.map((c, i) => (
            <span key={i} className={`ctr c${c}${used.has(i) ? ' used' : ''}`} title={`PHT[${i}] = ${c}`}>
              {c}
            </span>
          ))}
        </div>
      )}
      <div className="kv">
        {pr.kind === 'gshare' && (
          <>
            <span>Global history</span>
            <code>{pr.ghr.toString(2).padStart(pr.historyBits, '0')}</code>
          </>
        )}
        <span>Return stack</span>
        <span>{pr.ras.length ? pr.ras.map((a) => hex(a)).reverse().join(' · ') : <span className="muted">empty</span>}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Counters

export function CountersPanel() {
  const v = useView();
  const c = v.snap.counters;
  const m = v.sim.machine;
  const ipc = c.CPU_CYCLES ? c.INST_RETIRED / c.CPU_CYCLES : 0;
  const rows: [string, string | number, string][] = [
    ['CPU_CYCLES', c.CPU_CYCLES, 'cycles so far'],
    ['INST_RETIRED', c.INST_RETIRED, 'instructions retired (architecturally executed)'],
    ['IPC', ipc.toFixed(2), `retired per cycle; this machine can retire at most ${m.width.commit}`],
    ['INST_SPEC', c.INST_SPEC, 'instructions renamed, including ones later squashed'],
    ['BR_RETIRED', c.BR_RETIRED, 'branches and jumps retired'],
    ['BR_MIS_PRED_RETIRED', c.BR_MIS_PRED_RETIRED, 'retired branches and returns that had been mispredicted'],
    ['UOPS_FLUSHED', c.UOPS_FLUSHED, 'wrong-path instructions thrown away'],
    ['STALL_SLOT_FRONTEND', c.STALL_SLOT_FRONTEND, 'rename slots empty because the front end had nothing'],
    ['STALL_SLOT_BACKEND', c.STALL_SLOT_BACKEND, 'rename slots empty because the ROB, issue queue or free list was full'],
  ];
  return (
    <div className="panel">
      <h3>Counters</h3>
      <table className="counters">
        <tbody>
          {rows.map(([k, val, d]) => (
            <tr key={k} title={d}>
              <td>
                <code>{k}</code>
              </td>
              <td className="num">{val}</td>
              <td className="muted">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline diagram (Konata-style)

export function PipelineDiagram() {
  const v = useView();
  const { sim, cycle } = v;
  const before = 22;
  const after = 3;
  const lo = Math.max(1, cycle - before);
  const hi = cycle + after;
  const rows = useMemo(() => {
    // Everything still in flight is always shown, however old (a load stuck
    // at the ROB head is the instruction to look at). Only finished history
    // (retired or squashed) is trimmed to the most recent rows.
    const live = (x: (typeof sim.uops)[number]) => {
      const end = x.t.commit ?? x.t.flush;
      return end === undefined || end > cycle;
    };
    const visible = sim.uops.filter((x) => x.t.fetch <= cycle && (x.t.commit ?? x.t.flush ?? Infinity) >= lo);
    const history = visible.filter((x) => !live(x)).slice(-16);
    const keep = new Set([...history, ...visible.filter(live)]);
    return visible.filter((x) => keep.has(x));
  }, [sim, cycle, lo]);
  const cols = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return (
    <div className="panel wide">
      <h3>Pipeline diagram</h3>
      <Explain>
        One row per instruction (wrong-path ones included), one column per cycle. <b>F</b> fetch, <b>D</b> decode, <b>R</b> rename and dispatch,{' '}
        <b>·</b> waiting in the issue queue, <b>X</b> executing, <b>W</b> writeback, <b>-</b> done and waiting to retire, <b>C</b> commit,{' '}
        <b>✕</b> squashed. Gaps between R and X are the instruction waiting for operands or a port; gaps between W and C are it waiting for
        older instructions to retire. Click a column to go to that cycle.
      </Explain>
      <div className="pipe-scroll">
        <table className="pipe">
          <thead>
            <tr>
              <th className="lbl"></th>
              {cols.map((k) => (
                <th key={k} className={k === cycle ? 'now' : k > cycle ? 'future' : ''} onClick={() => k <= sim.cycles && v.goto(k)}>
                  {k}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id} className={`${v.hlUops.has(x.id) ? 'hl' : ''}${x.t.flush !== undefined && x.t.flush <= cycle ? ' squashed' : ''}`}>
                <td className="lbl">
                  <UopChip id={x.id} />
                </td>
                {cols.map((k) => {
                  const c = k <= cycle ? cellAt(x, k) : null;
                  return (
                    <td key={k} className={`cell ${c ? 'c-' + (c === 'x' ? 'sq' : c) : ''}${k === cycle ? ' now' : ''}`} title={c ? `cycle ${k}: ${CELL_TITLE[c]}` : ''} onClick={() => k <= sim.cycles && v.goto(k)}>
                      {c === 'x' ? '✕' : c === 'i' ? '·' : c === 'c' ? '-' : c === 'f' || c === 'd' ? '' : c}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector: the life of one instruction

export function Inspector() {
  const v = useView();
  const { sim, cycle } = v;
  const f = v.focus;
  const story = useMemo(() => {
    if (!f || f.kind !== 'uop') return [];
    const out: { cycle: number; e: CoreEvent }[] = [];
    for (let c = 1; c <= cycle && c < sim.snapshots.length; c++)
      for (const e of sim.snapshots[c]!.events) if (e.uops[0] === f.id) out.push({ cycle: c, e });
    return out;
  }, [f, sim, cycle]);

  if (!f)
    return (
      <div className="panel inspector">
        <h3>Inspector</h3>
        <p className="muted">Hover or click any instruction chip (#n) or physical register (pN) to follow it through the machine. Click again to unpin.</p>
      </div>
    );
  if (f.kind === 'preg') {
    const n = f.n;
    const snap = v.snap;
    const archNow = snap.rat.map((p, r) => (p === n ? regName(r) : null)).filter(Boolean);
    const archCommitted = snap.rrat.map((p, r) => (p === n ? regName(r) : null)).filter(Boolean);
    const writer = [...snap.rob].map((id) => sim.uops[id]!).find((x) => x.pdst === n);
    const readers = [...snap.rob].map((id) => sim.uops[id]!).filter((x) => x.psrc.includes(n));
    return (
      <div className="panel inspector">
        <h3>
          Physical register <PregChip n={n} />
        </h3>
        <div className="kv">
          <span>Value</span>
          <span>{snap.freeList.includes(n) ? 'free (no meaningful value)' : snap.prfReady[n] ? snap.prfValue[n] : 'not produced yet'}</span>
          <span>Newest copy of</span>
          <span>{archNow.length ? archNow.join(', ') : <span className="muted">no register</span>}</span>
          <span>Committed copy of</span>
          <span>{archCommitted.length ? archCommitted.join(', ') : <span className="muted">no register</span>}</span>
          <span>Written by</span>
          <span>{writer ? <UopChip id={writer.id} /> : <span className="muted">no in-flight instruction</span>}</span>
          <span>Read by</span>
          <span>{readers.length ? readers.map((x) => <UopChip key={x.id} id={x.id} />) : <span className="muted">no in-flight instruction</span>}</span>
        </div>
      </div>
    );
  }
  const x = sim.uops[f.id];
  if (!x) return null;
  const t = x.t;
  const steps: [string, number | undefined][] = [
    ['fetch', t.fetch],
    ['decode', t.decode],
    ['rename', t.rename],
    ['issue', t.issue],
    ['writeback', t.complete],
    ['retire', t.commit],
    ['squashed', t.flush],
  ];
  return (
    <div className="panel inspector">
      <h3>
        <UopChip id={x.id} />
      </h3>
      <div className="kv">
        <span>Address</span>
        <code>{hex(x.pc)}</code>
        <span>Source line</span>
        <code>
          {x.instr.line}: {x.instr.source}
        </code>
        <span>Status</span>
        <span className={`pill st-${statusOf(x, cycle)}`}>{statusOf(x, cycle)}</span>
        <span>Timeline</span>
        <span className="timeline">
          {steps
            .filter(([, c]) => c !== undefined && c <= cycle)
            .map(([s, c]) => (
              <button key={s} className="tl" onClick={() => v.goto(c!)}>
                {s} @{c}
              </button>
            ))}
        </span>
        {x.pred.reason && (
          <>
            <span>Prediction</span>
            <span>{x.pred.reason}</span>
          </>
        )}
        {t.complete !== undefined && t.complete <= cycle && x.result !== undefined && (
          <>
            <span>Result</span>
            <span>{x.result}</span>
          </>
        )}
      </div>
      <h4>Its story so far</h4>
      <ol className="story">
        {story.map(({ cycle: c, e }, i) => (
          <li key={i}>
            <button className="tl" onClick={() => v.goto(c)}>
              @{c}
            </button>{' '}
            <Rich text={e.text} />
          </li>
        ))}
      </ol>
    </div>
  );
}
