"use client";

/** Shared loading chrome. Visual only — no measurement or request logic. */

export function IndeterminateBar({
  label,
  hint,
  elapsed,
}: {
  label: string;
  hint?: string;
  elapsed?: number;
}) {
  return (
    <div className="mt-3 rounded-lg bg-slate-950/55 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-slate-200">{label}</p>
        {elapsed !== undefined && (
          <span className="font-mono tabular-nums text-xs text-slate-500">{elapsed}s</span>
        )}
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full w-1/3 animate-progress rounded-full bg-teal-400/90" />
      </div>
      {hint && <p className="mt-2 text-xs leading-relaxed text-slate-500">{hint}</p>}
    </div>
  );
}

export function DeterminateBar({
  done,
  total,
  label,
  elapsed,
}: {
  done: number;
  total: number;
  label: string;
  elapsed?: React.ReactNode;
}) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="flex min-w-[13rem] flex-1 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
        <span>
          {label}{" "}
          <span className="font-mono tabular-nums text-slate-300">
            {done}/{total}
          </span>
        </span>
        {elapsed}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-teal-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function ResultSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-hidden>
      <div className="rounded-2xl border border-slate-800/80 border-l-[3px] border-l-teal-400/50 bg-slate-900/35 px-6 py-6">
        <div className="h-2.5 w-28 animate-pulse rounded bg-slate-700/70" />
        <div className="mt-4 h-5 w-full animate-pulse rounded bg-slate-700/45" />
        <div className="mt-2 h-5 w-4/5 animate-pulse rounded bg-slate-700/35" />
      </div>
      <div className="rounded-xl bg-slate-900/25 px-5 py-4">
        <div className="h-2.5 w-40 animate-pulse rounded bg-slate-700/50" />
        <div className="mt-4 space-y-2">
          <div className="h-3 w-full animate-pulse rounded bg-slate-800/80" />
          <div className="h-3 w-11/12 animate-pulse rounded bg-slate-800/60" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-slate-800/50" />
        </div>
      </div>
    </div>
  );
}

export function Wordmark({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
    >
      <rect width="32" height="32" rx="8" fill="#0b1020" />
      <path
        d="M7 23c4.5-9 13.5-9 18 0"
        fill="none"
        stroke="#2dd4bf"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <circle cx="20.5" cy="11.5" r="3.1" fill="#eab308" />
      <circle cx="11" cy="13.5" r="2.2" fill="#ef4444" />
    </svg>
  );
}
