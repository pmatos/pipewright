import type { SimResult, Snapshot, Uop } from '../core';

/** Letters for the pipeline diagram, one per cycle of a uop's life. */
export type Cell = 'F' | 'f' | 'D' | 'd' | 'R' | 'i' | 'X' | 'W' | 'c' | 'C' | 'x' | null;

export function cellAt(x: Uop, k: number): Cell {
  const t = x.t;
  if (k < t.fetch) return null;
  if (t.flush !== undefined) {
    if (k === t.flush) return 'x';
    if (k > t.flush) return null;
  }
  if (t.commit !== undefined && k > t.commit) return null;
  if (k === t.fetch) return 'F';
  if (t.decode === undefined || k < t.decode) return 'f';
  if (k === t.decode) return 'D';
  if (t.rename === undefined || k < t.rename) return 'd';
  if (k === t.rename) return 'R';
  if (t.issue === undefined || k < t.issue) return 'i';
  if (t.complete === undefined || k < t.complete) return 'X';
  if (k === t.complete) return 'W';
  if (t.commit === undefined || k < t.commit) return 'c';
  return 'C';
}

export const CELL_TITLE: Record<Exclude<Cell, null>, string> = {
  F: 'fetched',
  f: 'in the fetch buffer',
  D: 'decoded',
  d: 'in the decode queue, waiting to be renamed',
  R: 'renamed and dispatched',
  i: 'waiting in the issue queue',
  X: 'executing',
  W: 'writeback: result broadcast',
  c: 'done, waiting to retire',
  C: 'retired',
  x: 'squashed by a mispredict',
};

/** The uop that produced the value a source physical register holds. */
export function producerOf(sim: SimResult, consumer: Uop, preg: number): Uop | undefined {
  for (let i = consumer.id - 1; i >= 0; i--) {
    const x = sim.uops[i]!;
    if (x.pdst === preg && x.t.rename !== undefined && x.t.rename <= (consumer.t.rename ?? Infinity)) return x;
  }
  return undefined;
}

/** Physical registers whose state changed between two snapshots. */
export function changedPregs(prev: Snapshot | undefined, cur: Snapshot): Set<number> {
  const s = new Set<number>();
  if (!prev) return s;
  for (let i = 0; i < cur.prfReady.length; i++) {
    if (prev.prfReady[i] !== cur.prfReady[i] || prev.prfValue[i] !== cur.prfValue[i]) s.add(i);
  }
  return s;
}
