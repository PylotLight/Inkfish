/** Human, locale-light relative time: "now", "12m", "3h", "Yesterday", "Mon", "7 Oct". */
export function when(ms: number, now = Date.now()): string {
  const d = Math.max(0, now - ms);
  const min = Math.floor(d / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const then = new Date(ms);
  const today = new Date(now);
  const sameDay = then.toDateString() === today.toDateString();
  if (sameDay) return `${Math.floor(min / 60)}h`;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (then.toDateString() === y.toDateString()) return 'Yesterday';
  if (d < 6 * 86400000) return then.toLocaleDateString(undefined, { weekday: 'short' });
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Thursday 8 October" */
export function longDate(d = new Date()): string {
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Folder label for a vault-relative path (`work/2026-…md` → `work`). */
export function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : 'Vault';
}
