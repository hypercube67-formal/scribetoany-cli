/** stdout carries results only; everything else goes to stderr. */

let quiet = false;

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function log(message: string): void {
  if (!quiet) process.stderr.write(`${message}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

export const isTty = () => Boolean(process.stderr.isTTY) && !quiet;

/** A one-line progress indicator on a TTY; silent otherwise. */
export function progress(label: string) {
  let last = 0;
  return {
    update(fraction: number) {
      if (!isTty()) return;
      const now = Date.now();
      if (now - last < 100 && fraction < 1) return;
      last = now;
      const pct = Math.min(100, Math.round(fraction * 100));
      process.stderr.write(`\r${label} ${String(pct).padStart(3)}%`);
    },
    done() {
      if (isTty()) process.stderr.write('\n');
    },
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(sec: number | null): string {
  if (sec === null || sec === undefined) return '';
  const total = Math.round(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
