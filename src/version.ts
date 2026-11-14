/** Module version this panel was built for. Older installed skills lack scripts the panel calls. */
export const EXPECTED_MODULE = '2.2.0';
export const PANEL_VERSION = '0.11.0';

export const vkey = (v: string | null | undefined) => (v ?? '').split(/[^0-9]+/).filter(Boolean).slice(0, 3).map(Number);
export function older(a: string | null | undefined, b: string) {
  const x = vkey(a), y = vkey(b);
  for (let i = 0; i < 3; i++) { if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0); }
  return false;
}
