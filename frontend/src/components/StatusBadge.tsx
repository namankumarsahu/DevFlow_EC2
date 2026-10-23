const colors: Record<string, string> = {
  QUEUED: 'bg-slate-700 text-slate-200',
  BUILDING: 'bg-amber-500/20 text-amber-300 animate-pulse',
  DEPLOYING: 'bg-sky-500/20 text-sky-300 animate-pulse',
  SUCCESS: 'bg-emerald-500/20 text-emerald-300',
  FAILED: 'bg-rose-500/20 text-rose-300',
  CANCELLED: 'bg-slate-600/40 text-slate-400',
};

export default function StatusBadge({ status }: { status: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[status] ?? ''}`}>{status}</span>;
}
