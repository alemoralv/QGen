"use client";

interface Props {
  label: string;
  value: number;
  total: number;
  hint?: string;
}

export default function ProgressBar({ label, value, total, hint }: Props) {
  const safeTotal = Math.max(1, total);
  const pct = Math.max(0, Math.min(100, (value / safeTotal) * 100));

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="truncate text-sm font-medium text-slate-800">{label}</p>
        <p className="text-xs text-slate-500">
          {Math.min(value, total)} / {total}
        </p>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-brand-600 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
