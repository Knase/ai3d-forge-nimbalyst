import { parseWeights, WEIGHT_DIMS } from './config';
import type { Scored } from './types';

export const DIM_LABEL: Record<string, string> = Object.fromEntries(WEIGHT_DIMS.map((d) => [d.id, d.label]));

/** 0-100, the same formula as the Prism dashboards; null until all five dimensions are scored. */
export function total(s: Scored, weights: string | undefined) {
  const w = parseWeights(weights ?? '');
  const sc = s.scores ?? {};
  let sum = 0, wsum = 0;
  for (const d of WEIGHT_DIMS) {
    const v = sc[d.id];
    if (typeof v !== 'number') return null;
    sum += w[d.id] * (v - 1) / 4;
    wsum += w[d.id];
  }
  return wsum ? Math.round(100 * sum / wsum) : null;
}

export function ScoreBar({ value }: { value: number | null }) {
  if (value == null) return <span className="a3d-muted">not scored</span>;
  return (
    <span className="a3d-scorebar" title={`${value} of 100`}>
      <span className="a3d-track"><i style={{ width: `${value}%` }} /></span>
      <b>{value}</b>
    </span>
  );
}

export function ScoreDims({ s }: { s: Scored }) {
  const est = new Set(s.estimated ?? []);
  return (
    <dl className="a3d-dims">
      {WEIGHT_DIMS.map((d) => {
        const v = s.scores?.[d.id];
        return (
          <div key={d.id}>
            <dt>{d.label}{est.has(d.id) ? <span className="a3d-muted" title="estimated, no source"> ~</span> : null}</dt>
            <dd>
              <span className="a3d-dimbar" aria-hidden="true">{[1, 2, 3, 4, 5].map((n) => <i key={n} className={typeof v === 'number' && n <= v ? 'on' : ''} />)}</span>
              <span>{typeof v === 'number' ? `${v} / 5` : '–'}</span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
