// Number formatting for a shared screen: few digits, no false precision.

/** 0.4133 -> "41%", 0.0413 -> "4.1%", 0.004125 -> "0.4%", 0.0002 -> "0.02%". */
export function pct(x: number): string {
  const v = x * 100;
  if (v === 0) return '0%';
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 0.1) return `${trimZero(v.toFixed(1))}%`;
  return `${trimZero(v.toFixed(2))}%`;
}

/** Rounds to `digits` significant figures: 759.49 -> 760, 100.19 -> 100. */
export function roundSig(x: number, digits = 2): number {
  if (x === 0) return 0;
  const scale = 10 ** (digits - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * scale) / scale;
}

/** The N in "1 in N": whole numbers when small (7.58 -> 8), two significant figures when large (759.5 -> 760). */
export function oneIn(n: number): number {
  return n < 20 ? Math.round(n) : roundSig(n, 2);
}

export function money(x: number, cents = true): string {
  return x.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export function count(x: number): string {
  return x.toLocaleString('en-US');
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}
