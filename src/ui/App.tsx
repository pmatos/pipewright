import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AssemblerError,
  assemble,
  formatInstr,
  simulate,
  type MachineDesc,
  type Program,
  type SimResult,
} from '../core';
import { EXAMPLES } from './examples';
import { buildMachine, MachinePicker, MAX_UI_CYCLES, type MachineChoice } from './picker';
import { Compare } from './compare';
import { CountersPanel, FrontEnd, Inspector, IssuePanel, Narration, PipelineDiagram, PredictorPanel, ProgramListing, RegFilePanel, RenamePanel, RobPanel } from './panels';
import { related, Rich, ViewContext, type Focus, type View } from './view';

type Built = { kind: 'ok'; program: Program; sim: SimResult } | { kind: 'error'; message: string };

function build(source: string, machine: MachineDesc): Built {
  try {
    const program = assemble(source);
    const sim = simulate(program, machine, { maxCycles: MAX_UI_CYCLES });
    return { kind: 'ok', program, sim };
  } catch (e) {
    if (e instanceof AssemblerError) return { kind: 'error', message: e.message };
    return { kind: 'error', message: String(e) };
  }
}

export function App() {
  const [mode, setMode] = useState<'step' | 'compare'>('step');
  const [exampleId, setExampleId] = useState(EXAMPLES[0]!.id);
  const [source, setSource] = useState(EXAMPLES[0]!.source);
  const [draft, setDraft] = useState(source);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<MachineChoice>({ preset: 'teaching', predictor: 'preset', width: null });
  const [cmpA, setCmpA] = useState<MachineChoice>({ preset: 'mobile', predictor: 'preset', width: null });
  const [cmpB, setCmpB] = useState<MachineChoice>({ preset: 'server', predictor: 'preset', width: null });

  const example = EXAMPLES.find((e) => e.id === exampleId);
  const machine = useMemo(() => buildMachine(choice), [choice]);
  const built = useMemo(() => build(source, machine), [source, machine]);

  const pickExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)!;
    setExampleId(id);
    setSource(ex.source);
    setDraft(ex.source);
  };

  return (
    <main>
      <header>
        <div className="title">
          <h1>Pipewright</h1>
          <p>Watch an out-of-order CPU run your assembly, one cycle and one decision at a time.</p>
        </div>
        <nav className="tabs">
          <button className={mode === 'step' ? 'on' : ''} onClick={() => setMode('step')}>
            Step through
          </button>
          <button className={mode === 'compare' ? 'on' : ''} onClick={() => setMode('compare')}>
            Compare two cores
          </button>
        </nav>
      </header>

      <section className="toolbar">
        <label>
          program{' '}
          <select value={editing || source !== example?.source ? 'custom' : exampleId} onChange={(e) => e.target.value !== 'custom' && pickExample(e.target.value)}>
            {EXAMPLES.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
            <option value="custom" disabled>
              your own code
            </option>
          </select>
        </label>
        <button className="ghost" onClick={() => setEditing(!editing)}>
          {editing ? 'Hide source' : 'Edit source'}
        </button>
        {mode === 'step' && <MachinePicker value={choice} onChange={setChoice} />}
      </section>

      {editing && (
        <section className="editor">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} rows={16} />
          <div>
            <button onClick={() => setSource(draft)}>Assemble and load</button>{' '}
            <span className="muted">RV32IM subset; the program halts at <code>ecall</code>.</span>
          </div>
        </section>
      )}

      {example && source === example.source && (
        <p className="hint">
          <b>What to look for:</b> <Rich text={example.hint} />
        </p>
      )}

      {built.kind === 'error' ? (
        <pre className="error">{built.message}</pre>
      ) : mode === 'step' ? (
        <Stepper key={`${source}|${JSON.stringify(machine)}`} sim={built.sim} program={built.program} />
      ) : (
        <Compare program={built.program} a={cmpA} b={cmpB} setA={setCmpA} setB={setCmpB} />
      )}
    </main>
  );
}

function Stepper({ sim, program }: { sim: SimResult; program: Program }) {
  const [cycle, setCycle] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [showWhy, setShowWhy] = useState(true);
  const [hover, setHover] = useState<Focus>(null);
  const [pinned, setPinned] = useState<Focus>(null);
  const last = sim.snapshots.length - 1;

  const goto = useCallback((c: number) => setCycle(Math.max(0, Math.min(last, c))), [last]);

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setCycle((c) => {
        if (c >= last) {
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, 1000 / speed);
    return () => clearInterval(t);
  }, [playing, speed, last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
      if (e.key === 'ArrowRight') goto(cycle + 1);
      else if (e.key === 'ArrowLeft') goto(cycle - 1);
      else if (e.key === 'Home') goto(0);
      else if (e.key === 'End') goto(last);
      else if (e.key === ' ') setPlaying((p) => !p);
      else if (e.key === 'Escape') setPinned(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle, goto, last]);

  const mispredictCycles = useMemo(
    () => sim.snapshots.filter((s) => s.events.some((e) => e.kind === 'mispredict')).map((s) => s.cycle),
    [sim],
  );
  const nextMp = mispredictCycles.find((c) => c > cycle);
  const prevMp = [...mispredictCycles].reverse().find((c) => c < cycle);

  const snap = sim.snapshots[cycle]!;
  const focus = hover ?? pinned;
  const rel = useMemo(() => related(sim, snap, focus), [sim, snap, focus]);
  const view: View = {
    sim,
    cycle,
    snap,
    prev: sim.snapshots[cycle - 1],
    focus,
    pinned,
    setHover,
    togglePin: (f) => setPinned((p) => (p && f && p.kind === f.kind && (p.kind === 'uop' ? p.id === (f as { id: number }).id : p.n === (f as { n: number }).n) ? null : f)),
    goto,
    hlUops: rel.uops,
    hlPregs: rel.pregs,
  };

  const instrs = useMemo(() => program.instrs.map((i) => ({ pc: i.pc, text: formatInstr(i), source: i.source, line: i.line })), [program]);

  return (
    <ViewContext.Provider value={view}>
      <section className="transport">
        <button onClick={() => goto(0)} title="Reset (Home)">
          ⏮
        </button>
        <button onClick={() => goto(cycle - 1)} disabled={cycle === 0} title="Step back (←)">
          ◀ Back
        </button>
        <button onClick={() => goto(cycle + 1)} disabled={cycle === last} title="Step one cycle (→)">
          Step ▶
        </button>
        <button onClick={() => setPlaying(!playing)} title="Play or pause (space)">
          {playing ? '⏸ Pause' : '⏵ Play'}
        </button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="cycles per second">
          {[1, 2, 4, 8, 20, 60].map((s) => (
            <option key={s} value={s}>
              {s}/s
            </option>
          ))}
        </select>
        <button onClick={() => goto(last)} title="Go to the end (End)">
          ⏭
        </button>
        <input type="range" min={0} max={last} value={cycle} onChange={(e) => goto(Number(e.target.value))} />
        <span className="cycle">
          cycle <b>{cycle}</b> / {last}
        </span>
        <button className="ghost" disabled={prevMp === undefined} onClick={() => prevMp !== undefined && goto(prevMp)}>
          ◀ mispredict
        </button>
        <button className="ghost" disabled={nextMp === undefined} onClick={() => nextMp !== undefined && goto(nextMp)}>
          Next mispredict ▶
        </button>
      </section>
      {sim.halt === 'limit' && (
        <p className="warn">
          This run is longer than {MAX_UI_CYCLES} cycles, so the stepper stops there. The Compare view runs programs to completion.
        </p>
      )}
      {sim.machine.description && <p className="muted machine-desc">{sim.machine.description}</p>}

      <div className="layout" onClick={() => undefined}>
        <div className="col-left">
          <div className="panel">
            <h3>Program</h3>
            <ProgramListing instrs={instrs} />
          </div>
          <Inspector />
        </div>
        <div className="col-mid">
          <div className="panel narr">
            <h3>
              Cycle {cycle}: what the hardware did, and why
              <label className="toggle">
                <input type="checkbox" checked={showWhy} onChange={(e) => setShowWhy(e.target.checked)} /> show waits and stalls
              </label>
            </h3>
            <Narration showWhy={showWhy} />
          </div>
          <PipelineDiagram />
        </div>
        <div className="col-right">
          <FrontEnd />
          <RobPanel />
          <IssuePanel />
        </div>
      </div>
      <div className="layout2">
        <RenamePanel />
        <RegFilePanel />
        <PredictorPanel />
        <CountersPanel />
      </div>
    </ViewContext.Provider>
  );
}
