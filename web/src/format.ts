export const shortPeerId = (peerId: string) =>
  peerId.length > 16 ? `${peerId.slice(0, 8)}…${peerId.slice(-6)}` : peerId;

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function formatLastSeen(ts: number): string {
  const delta = Math.max(0, Date.now() - ts);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return formatDate(ts);
}

const ordinal = (day: number): string => {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
};

/** e.g. "11th July 2026" */
export function formatDate(input: string | number | Date): string {
  const d = new Date(input);
  const month = d.toLocaleString('en-GB', { month: 'long' });
  return `${ordinal(d.getDate())} ${month} ${d.getFullYear()}`;
}

/** e.g. "11th July 2026, 14:32:05" */
export function formatDateTime(input: string | number | Date): string {
  const d = new Date(input);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatDate(d)}, ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A performance figure, e.g. "85 ms" or "54.2 tok/s", or "—" when absent. */
export function formatFigure(value: number | undefined | null, unit: 'ms' | 'tok/s'): string {
  if (value == null) return '—';
  return unit === 'ms'
    ? `${Math.round(value).toLocaleString('en-GB')} ms`
    : `${value.toLocaleString('en-GB', { maximumFractionDigits: 1 })} tok/s`;
}

/** Hover text for a cross-node figure: its spread and how many nodes reported it. */
export function rangeTitle(range: { min: number; max: number; nodes: number } | null | undefined, unit: 'ms' | 'tok/s'): string | undefined {
  if (!range) return undefined;
  return `${formatFigure(range.min, unit)} – ${formatFigure(range.max, unit)} across ${range.nodes} node${range.nodes === 1 ? '' : 's'} (self-reported)`;
}
