"use client";

import { useState } from "react";

const HOURS_PER_DAY = 8;

const FIELDS = [
  { key: "rate", label: "Day rate per person ($)", placeholder: "$ / day", decimal: true },
  { key: "crew", label: "Crew size", placeholder: "people", decimal: false },
  { key: "travel", label: "Travel hours (round trip)", placeholder: "hours", decimal: true },
  { key: "days", label: "Days on site to re-mobilize", placeholder: "days", decimal: true },
] as const;
type Key = (typeof FIELDS)[number]["key"];

/** Pure client-side estimate of a return trip's labour cost. Blank until the viewer fills it in. */
export function CostCard() {
  const [v, setV] = useState<Record<Key, string>>({ rate: "", crew: "", travel: "", days: "" });
  const n = (k: Key) => {
    const x = Number(v[k].replace(/[,$\s]/g, ""));
    return v[k].trim() !== "" && Number.isFinite(x) && x >= 0 ? x : null;
  };
  const rate = n("rate"), crew = n("crew"), travel = n("travel"), days = n("days");
  const ready = rate != null && crew != null && travel != null && days != null;
  const personDays = ready ? crew! * (days! + travel! / HOURS_PER_DAY) : 0;
  const cost = ready ? rate! * personDays : 0;
  return (
    <section id="cost-card" aria-label="Return-trip cost" className="card p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">What would a return trip cost?</h2>
        <span className="text-xs text-muted">Your numbers; nothing is pre-filled or sent anywhere.</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        {FIELDS.map((f) => (
          <div key={f.key} className="flex min-w-0 flex-col justify-end">
            <label className="label" htmlFor={`cost-${f.key}`}>{f.label}</label>
            <input
              id={`cost-${f.key}`}
              className="input num min-h-[44px] text-base"
              inputMode={f.decimal ? "decimal" : "numeric"}
              pattern={f.decimal ? "[0-9]*[.,]?[0-9]*" : "[0-9]*"}
              autoComplete="off"
              placeholder={f.placeholder}
              value={v[f.key]}
              onChange={(e) => setV({ ...v, [f.key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <div className="mt-3 min-h-[2.5rem]" aria-live="polite">
        {ready ? (
          <>
            <div className="text-lg font-semibold">
              Estimated cost of a return trip: <span className="num">${Math.round(cost).toLocaleString("en-US")}</span>
            </div>
            <div className="num text-xs text-muted">
              {crew} × ${rate!.toLocaleString("en-US")} × ({days} d + {travel} h ÷ {HOURS_PER_DAY} h/d) = {personDays.toFixed(2)} person-days. Labour only; excludes equipment, mileage and lodging.
            </div>
          </>
        ) : (
          <div className="text-sm text-muted">Fill in all four to see the estimate.</div>
        )}
      </div>
    </section>
  );
}
