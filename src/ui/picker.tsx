import { PRESETS, type MachineDesc, type PredictorKind } from '../core';

/** Snapshots are kept for this many cycles; longer runs are cut short in the stepper. */
export const MAX_UI_CYCLES = 4000;

const PREDICTORS: PredictorKind[] = ['none', 'not-taken', 'btfn', 'bimodal', 'gshare'];

export interface MachineChoice {
  preset: string;
  predictor: PredictorKind | 'preset';
  width: number | null;
}

export function buildMachine(c: MachineChoice): MachineDesc {
  const base = PRESETS[c.preset]!;
  let m: MachineDesc = base;
  if (c.predictor !== 'preset') m = { ...m, branchPredictor: { ...m.branchPredictor, kind: c.predictor } };
  if (c.width !== null) m = { ...m, width: { fetch: c.width, rename: c.width, commit: c.width } };
  return m;
}

export function MachinePicker({ value, onChange, label }: { value: MachineChoice; onChange: (c: MachineChoice) => void; label?: string }) {
  return (
    <span className="picker">
      {label && <b>{label}</b>}
      <label>
        machine{' '}
        <select value={value.preset} onChange={(e) => onChange({ ...value, preset: e.target.value })}>
          {Object.keys(PRESETS).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label>
        predictor{' '}
        <select value={value.predictor} onChange={(e) => onChange({ ...value, predictor: e.target.value as MachineChoice['predictor'] })}>
          <option value="preset">preset ({PRESETS[value.preset]!.branchPredictor.kind})</option>
          {PREDICTORS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label>
        width{' '}
        <select value={value.width ?? 'preset'} onChange={(e) => onChange({ ...value, width: e.target.value === 'preset' ? null : Number(e.target.value) })}>
          <option value="preset">preset ({PRESETS[value.preset]!.width.fetch})</option>
          {[1, 2, 3, 4, 6, 8].map((w) => (
            <option key={w}>{w}</option>
          ))}
        </select>
      </label>
    </span>
  );
}

