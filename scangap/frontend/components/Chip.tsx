import type { Severity } from "@/lib/types";

const STYLE: Record<Severity, { cls: string; icon: string; label: string }> = {
  high: { cls: "border-sev-high/40 bg-sev-high/10 text-sev-high", icon: "▲", label: "HIGH" },
  review: { cls: "border-sev-review/50 bg-sev-review/15 text-sev-reviewtext", icon: "◆", label: "REVIEW" },
  info: { cls: "border-line bg-surface text-muted", icon: "●", label: "INFO" },
  pass: { cls: "border-sev-pass/40 bg-sev-pass/10 text-sev-passtext", icon: "✓", label: "PASS" },
};

export function Chip({ severity, children }: { severity: Severity; children?: React.ReactNode }) {
  const s = STYLE[severity];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold leading-none tracking-wide ${s.cls}`}
    >
      <span aria-hidden className="text-[9px]">
        {s.icon}
      </span>
      {children ?? s.label}
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded border border-dashed border-line p-4 text-sm text-muted">{children}</div>;
}
