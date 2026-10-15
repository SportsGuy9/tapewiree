"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { STATIC_DEMO, SYNTH_AFTER_ID, SYNTH_ID, client } from "@/lib/api";
import type { Bundle, Finding, GridPayload, Health } from "@/lib/types";
import { Empty } from "./Chip";
import { CostCard } from "./CostCard";
import Heatmap from "./Heatmap";
import {
  DeliveryPanel,
  FindingsPanel,
  PlanPanel,
  RegistrationPanel,
  ReportPanel,
  ScanPanel,
  ScopePanel,
  SpecPanel,
  ZonesPanel,
} from "./Panels";
import { Verdict } from "./Verdict";

const PointViewer = dynamic(() => import("./PointViewer"), { ssr: false, loading: () => <Empty>Loading 3D viewer…</Empty> });

const TABS = [
  ["findings", "Findings"],
  ["zones", "Zones"],
  ["spec", "Spec"],
  ["scan", "Scan data"],
  ["plan", "Plan"],
  ["registration", "Registration"],
  ["scope", "Scope"],
  ["delivery", "Delivery"],
  ["3d", "3D"],
  ["report", "Report"],
] as const;
type Tab = (typeof TABS)[number][0];

function RescanToggle({
  after,
  onChange,
  before,
  now,
}: {
  after: boolean;
  busy: boolean;
  onChange: (v: boolean) => void;
  before: Bundle["results"]["verdict"] | null;
  now: Bundle["results"]["verdict"];
}) {
  return (
    <section id="rescan-toggle" aria-label="Simulate a re-scan" className={`rounded-md border p-3 ${after ? "border-accent bg-accent/5" : "border-line bg-panel"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex w-full overflow-hidden rounded border border-line sm:w-auto" role="group" aria-label="Scan state">
          <button
            onClick={() => onChange(false)}
            aria-pressed={!after}
            className={`min-h-[44px] flex-1 px-4 text-sm font-medium sm:flex-none ${!after ? "bg-ink text-panel" : "bg-panel text-ink hover:bg-surface"}`}
          >
            As scanned
          </button>
          <button
            onClick={() => onChange(true)}
            aria-pressed={after}
            className={`min-h-[44px] flex-1 px-4 text-sm font-medium sm:flex-none ${after ? "bg-accent text-white" : "bg-panel text-ink hover:bg-surface"}`}
          >
            Simulate re-scan: add S7 + S9
          </button>
        </div>
        {after && before && (
          <span className="num text-sm">
            HIGH {before.counts.high} → <strong>{now.counts.high}</strong> · REVIEW {before.counts.review} → <strong>{now.counts.review}</strong>
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        {after ? (
          <>
            <strong className="text-accent">SIMULATED.</strong> The point cloud was re-generated with the two missed setups (S7 in Mech 104, S9 in the east corridor) added. This is not field data. The registration report, scope and delivery package are unchanged, so their findings remain.
          </>
        ) : (
          "What changes if the crew shoots the two missed setups before leaving site?"
        )}
      </p>
    </section>
  );
}

const MODULE_TAB: Record<string, Tab> = {
  spec: "spec", scan: "scan", coverage: "zones", plan: "plan", registration: "registration",
  validation: "registration", scope: "scope", manifest: "delivery",
};

export default function ProjectView({ id }: { id: string }) {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [grid, setGrid] = useState<GridPayload | null>(null);
  const [floor, setFloor] = useState(0);
  const [tab, setTab] = useState<Tab>("findings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selZone, setSelZone] = useState<string | null>(null);
  // "Fix it in the field": the synthetic demo has a baked twin where S7 + S9 were shot (simulated).
  const canRescan = id === SYNTH_ID;
  const [after, setAfter] = useState(false);
  const [beforeCounts, setBeforeCounts] = useState<Bundle["results"]["verdict"] | null>(null);
  const activeId = canRescan && after ? SYNTH_AFTER_ID : id;

  useEffect(() => {
    client
      .project(activeId)
      .then((b) => {
        setBundle(b);
        if (activeId === id) setBeforeCounts(b.results.verdict);
      })
      .catch((e) => {
        setError(String(e.message ?? e));
        if (activeId !== id) setAfter(false);
      });
  }, [activeId, id]);

  useEffect(() => {
    client.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  const gridKey = bundle ? JSON.stringify(bundle.results.grids ?? null) + bundle.results.cloud?.path : "";
  useEffect(() => {
    if (!bundle?.results.grids?.length) {
      setGrid(null);
      return;
    }
    client.grid(activeId, Math.min(floor, bundle.results.grids.length - 1)).then(setGrid).catch((e) => setError(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, floor, gridKey]);

  const editable = !STATIC_DEMO && !(health?.readonly ?? false) && !(bundle?.project.readonly ?? false);

  const run = useCallback(async (p: Promise<Bundle>) => {
    setBusy(true);
    setError(null);
    try {
      setBundle(await p);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const jump = (f: Finding) => {
    setTab(MODULE_TAB[f.module] ?? "findings");
    if (f.module === "coverage" && f.ref) setSelZone(f.ref);
    document.getElementById("detail")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  if (error && !bundle) return <div className="mx-auto max-w-6xl p-4"><Empty>Could not load project: {error}</Empty></div>;
  if (!bundle) return <div className="mx-auto max-w-6xl p-4 text-sm text-muted">Loading…</div>;
  const { project, results } = bundle;
  const minDensity = (() => {
    const ds = Array.from(new Set(project.zones.map((z) => z.min_density).filter((d): d is number => d != null)));
    return ds.length === 1 ? ds[0] : project.settings.default_min_density;
  })();
  const props = { bundle, editable, run };

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          {!STATIC_DEMO && <Link href="/" className="text-xs text-muted hover:underline">← Projects</Link>}
          <h1 className="truncate text-xl font-semibold sm:text-2xl">{project.name}</h1>
          <div className="text-xs text-muted">
            {project.spec.client && <>{project.spec.client} · </>}analysed <span className="num">{results.analyzed_at}</span>
            {results.cloud && <> · <span className="num">{results.cloud.file}</span></>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {busy && <span className="text-sm text-muted">Working…</span>}
          {!editable && <span className="rounded border border-line px-2 py-0.5 text-xs text-muted">READ-ONLY</span>}
          {editable && <button className="btn" disabled={busy} onClick={() => run(client.analyze(project.id))}>↻ Re-run checks</button>}
          <a className="btn" href={client.reportUrl(project.id, "pdf")} target="_blank" rel="noreferrer">⇩ PDF</a>
        </div>
      </header>
      {error && <div className="rounded border border-sev-high/40 bg-sev-high/10 p-2 text-sm text-sev-high">{error}</div>}

      <Verdict results={results} onJump={jump} />

      <CostCard />

      {canRescan && (
        <RescanToggle
          after={after}
          busy={busy}
          onChange={(v) => {
            setError(null);
            setSelZone(null);
            setAfter(v);
          }}
          before={beforeCounts}
          now={results.verdict}
        />
      )}

      <section className="card p-3 sm:p-4" aria-label="Coverage heatmap">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Coverage — top-down density, 0.5–2.0 m above floor</h2>
          {(results.grids?.length ?? 0) > 1 && (
            <select className="input w-auto" value={floor} onChange={(e) => setFloor(Number(e.target.value))} aria-label="Floor">
              {results.grids!.map((g) => <option key={g.floor} value={g.floor}>Floor {g.floor + 1} @ {g.z.toFixed(2)} m</option>)}
            </select>
          )}
        </div>
        {grid ? (
          <Heatmap
            grid={grid}
            zones={project.zones}
            zoneResults={results.zones ?? []}
            setups={results.setups}
            planRows={results.plan?.rows ?? []}
            minDensity={minDensity}
            editable={editable}
            selectedZone={selZone}
            onSelectZone={(z) => { setSelZone(z); }}
            onSaveZones={async (z) => run(client.putZones(project.id, z))}
          />
        ) : (
          <Empty>{results.cloud ? "Loading grid…" : "Load a point cloud (Scan data tab) to see coverage."}</Empty>
        )}
      </section>

      <section id="detail" className="card scroll-mt-4" aria-label="Details">
        <nav className="flex overflow-x-auto border-b border-line" role="tablist">
          {TABS.map(([t, label]) => {
            const n = results.findings.filter((f) => MODULE_TAB[f.module] === t && (f.severity === "high" || f.severity === "review")).length;
            return (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t ? "border-accent font-semibold text-ink" : "border-transparent text-muted hover:text-ink"}`}
              >
                {label}
                {n > 0 && <span className="num ml-1 rounded bg-surface px-1 text-xs">{n}</span>}
              </button>
            );
          })}
        </nav>
        <div className="p-3 sm:p-4">
          {tab === "findings" && <FindingsPanel {...props} />}
          {tab === "zones" && <ZonesPanel {...props} onSelect={(z) => { setSelZone(z); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}
          {tab === "spec" && <SpecPanel {...props} />}
          {tab === "scan" && <ScanPanel {...props} />}
          {tab === "plan" && <PlanPanel {...props} />}
          {tab === "registration" && <RegistrationPanel {...props} />}
          {tab === "scope" && <ScopePanel {...props} llm={health?.llm_available ?? false} />}
          {tab === "delivery" && <DeliveryPanel {...props} />}
          {tab === "3d" && (results.cloud ? <PointViewer projectId={project.id} setups={results.setups} floorZ={results.cloud.floors[0] ?? 0} /> : <Empty>No point cloud.</Empty>)}
          {tab === "report" && <ReportPanel {...props} />}
        </div>
      </section>

      <footer className="pb-6 text-xs text-muted">
        <p>ScanGap is a QA aid, not a certification. Candidate gaps are “possible gap — review”: a closed door, furniture or out-of-scope area can look the same. LOA compliance requires independent validation data.</p>
        {project.credit && <p className="mt-1">{project.credit.split(/(https:\/\/\S+)/).map((s, i) => (s.startsWith("https://") ? <a key={i} className="underline" href={s.replace(/[.,]$/, "")} target="_blank" rel="noreferrer">{s}</a> : s))}</p>}
      </footer>
    </div>
  );
}
