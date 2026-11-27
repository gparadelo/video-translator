import type { ButtonHTMLAttributes, ReactNode } from "react";
import { STATUS, type Job } from "@/lib/jobs";

const TONES = {
  idle: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  busy: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  action: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  good: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  bad: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

export function Pill({ tone, children }: { tone: keyof typeof TONES; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${TONES[tone]}`}>{children}</span>;
}

export const StatusPill = ({ status }: { status: Job["status"] }) => (
  <Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>
);

const BUTTON_KINDS = {
  primary:
    "bg-neutral-900 text-white shadow-sm hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white",
  plain:
    "border border-neutral-300 bg-surface shadow-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800",
  danger:
    "border border-red-300 bg-surface text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950",
};

/** Button styles, also for links that look like buttons. */
export const buttonClass = (kind: keyof typeof BUTTON_KINDS = "primary") =>
  `inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 ${BUTTON_KINDS[kind]}`;

export function Button({
  kind = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: keyof typeof BUTTON_KINDS }) {
  return (
    <button
      {...props}
      className={`${buttonClass(kind)} ${className}`}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`rounded-2xl border border-neutral-200/80 bg-surface p-5 shadow-sm dark:border-neutral-800 dark:shadow-none ${className}`}>{children}</section>;
}

export function Notice({ tone, children }: { tone: "action" | "bad" | "idle"; children: ReactNode }) {
  return <div className={`rounded-lg px-4 py-3 text-sm ${TONES[tone]}`}>{children}</div>;
}

/** Page title with an optional line under it. */
export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {sub && <p className="mt-1 text-sm text-neutral-500">{sub}</p>}
    </div>
  );
}

export function Bar({ fraction }: { fraction: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(fraction * 100)}%` }} />
    </div>
  );
}
