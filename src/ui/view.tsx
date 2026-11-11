import { createContext, useContext, type ReactNode } from 'react';
import { uopStatus, type SimResult, type Snapshot, type Uop } from '../core';
import { producerOf } from './model';

export type Focus = { kind: 'uop'; id: number } | { kind: 'preg'; n: number } | null;

export interface View {
  sim: SimResult;
  cycle: number;
  snap: Snapshot;
  prev: Snapshot | undefined;
  focus: Focus;
  pinned: Focus;
  setHover: (f: Focus) => void;
  togglePin: (f: Focus) => void;
  goto: (cycle: number) => void;
  /** Uops and registers related to the focus, for highlighting. */
  hlUops: Set<number>;
  hlPregs: Set<number>;
}

export const ViewContext = createContext<View | null>(null);

export function useView(): View {
  const v = useContext(ViewContext);
  if (!v) throw new Error('ViewContext missing');
  return v;
}

export function related(sim: SimResult, snap: Snapshot, focus: Focus): { uops: Set<number>; pregs: Set<number> } {
  const uops = new Set<number>();
  const pregs = new Set<number>();
  if (!focus) return { uops, pregs };
  if (focus.kind === 'uop') {
    const x = sim.uops[focus.id];
    if (!x) return { uops, pregs };
    uops.add(x.id);
    if (x.t.rename !== undefined && x.t.rename <= snap.cycle) {
      for (const r of x.psrc) {
        if (r === 0) continue;
        pregs.add(r);
        const pr = producerOf(sim, x, r);
        if (pr) uops.add(pr.id);
      }
      if (x.pdst !== null) pregs.add(x.pdst);
    }
  } else {
    pregs.add(focus.n);
    const live = [...snap.fetchQ, ...snap.decodeQ, ...snap.rob];
    for (const id of live) {
      const x = sim.uops[id]!;
      if (x.pdst === focus.n || x.psrc.includes(focus.n)) uops.add(id);
    }
  }
  return { uops, pregs };
}

const STATUS_LABEL: Record<string, string> = {
  fetched: 'fetched',
  decoded: 'decoded',
  waiting: 'in issue queue',
  executing: 'executing',
  done: 'done',
  committed: 'retired',
  flushed: 'squashed',
};

export function statusOf(x: Uop, cycle: number) {
  return uopStatus(x, cycle) ?? 'future';
}

export function UopChip({ id, full = true }: { id: number; full?: boolean }) {
  const v = useView();
  const x = v.sim.uops[id];
  if (!x) return <span className="chip">#{id}</span>;
  const st = statusOf(x, v.cycle);
  const cls = ['chip', 'uop', `st-${st}`];
  if (v.focus?.kind === 'uop' && v.focus.id === id) cls.push('focus');
  else if (v.hlUops.has(id)) cls.push('hl');
  if (v.pinned?.kind === 'uop' && v.pinned.id === id) cls.push('pinned');
  return (
    <span
      className={cls.join(' ')}
      title={`#${id} ${x.text} (${STATUS_LABEL[st] ?? st}). Click to pin.`}
      onMouseEnter={() => v.setHover({ kind: 'uop', id })}
      onMouseLeave={() => v.setHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        v.togglePin({ kind: 'uop', id });
      }}
    >
      <b>#{id}</b>
      {full && <code>{x.text}</code>}
    </span>
  );
}

export function PregChip({ n, ready }: { n: number; ready?: boolean }) {
  const v = useView();
  const isReady = ready ?? v.snap.prfReady[n];
  const cls = ['chip', 'preg', isReady ? 'ready' : 'notready'];
  if (v.focus?.kind === 'preg' && v.focus.n === n) cls.push('focus');
  else if (v.hlPregs.has(n)) cls.push('hl');
  if (v.pinned?.kind === 'preg' && v.pinned.n === n) cls.push('pinned');
  return (
    <span
      className={cls.join(' ')}
      title={`physical register p${n} = ${v.snap.prfValue[n]} (${isReady ? 'ready' : 'not ready yet'}). Click to pin.`}
      onMouseEnter={() => v.setHover({ kind: 'preg', n })}
      onMouseLeave={() => v.setHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        v.togglePin({ kind: 'preg', n });
      }}
    >
      p{n}
    </span>
  );
}

/** Render core event text, turning {#n} and {pN} into chips. */
export function Rich({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const re = /\{#(\d+)\}|\{p(\d+)\}|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<UopChip key={k++} id={Number(m[1])} />);
    else if (m[2] !== undefined) out.push(<PregChip key={k++} n={Number(m[2])} />);
    else out.push(<code key={k++}>{m[3]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

export function Explain({ children }: { children: ReactNode }) {
  return (
    <details className="explain">
      <summary>What is this?</summary>
      <div>{children}</div>
    </details>
  );
}
