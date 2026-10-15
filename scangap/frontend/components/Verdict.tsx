import type { Finding, Results } from "@/lib/types";
import { Chip } from "./Chip";

const BAR = {
  high: "border-sev-high bg-sev-high/10",
  review: "border-sev-review bg-sev-review/10",
  pass: "border-sev-pass bg-sev-pass/10",
  info: "border-line bg-panel",
};

export function Verdict({ results, onJump }: { results: Results; onJump: (f: Finding) => void }) {
  const v = results.verdict;
  const top = results.findings.filter((f) => f.severity === "high" || f.severity === "review").slice(0, 6);
  const more = results.findings.filter((f) => f.severity === "high" || f.severity === "review").length - top.length;
  return (
    <section id="verdict" aria-label="Verdict" className={`rounded-md border-l-4 ${BAR[v.level]} border border-line p-3 sm:p-4`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-muted">QA verdict</div>
          <h2 className="mt-0.5 text-lg font-semibold leading-snug sm:text-xl">{v.headline}</h2>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(["high", "review", "info", "pass"] as const).map((s) => (
            <Chip key={s} severity={s}>
              {s.toUpperCase()} <span className="num">{v.counts[s] ?? 0}</span>
            </Chip>
          ))}
        </div>
      </div>
      {top.length > 0 && (
        <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
          {top.map((f, i) => (
            <li key={i}>
              <button
                onClick={() => onJump(f)}
                className="flex w-full items-start gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-panel"
              >
                <Chip severity={f.severity} />
                <span className="leading-snug">{f.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {more > 0 && <div className="mt-1 pl-1 text-xs text-muted">+{more} more under Findings</div>}
    </section>
  );
}
