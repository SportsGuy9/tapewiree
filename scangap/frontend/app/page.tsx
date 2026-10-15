"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Chip, Empty } from "@/components/Chip";
import ProjectView from "@/components/ProjectView";
import { STATIC_DEMO, client } from "@/lib/api";
import type { Health, Severity } from "@/lib/types";

interface Row {
  id: string;
  name: string;
  created: string;
  verdict: { level: Severity; headline: string; counts: Record<Severity, number> } | null;
}

function Projects() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => client.projects().then(setRows).catch((e) => setErr(`Cannot reach the local ScanGap service: ${e.message}`));
  useEffect(() => {
    load();
    client.health().then(setHealth).catch(() => null);
  }, []);

  const go = (id: string) => (window.location.href = `project/?id=${encodeURIComponent(id)}`);
  const act = async (label: string, f: () => Promise<{ id: string }>) => {
    setBusy(label);
    setErr(null);
    try {
      go((await f()).id);
    } catch (e) {
      setErr(String((e as Error).message));
      setBusy(null);
    }
  };
  const ro = health?.readonly ?? false;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-5">
      <section>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Field registration tools tell you whether the scans stitched. ScanGap checks whether you captured what the client asked for, at the accuracy they asked for, before you leave site or deliver. Works on E57/LAS/LAZ from any scanner and runs on this machine; client data stays local.
        </p>
      </section>
      {err && <div className="rounded border border-sev-high/40 bg-sev-high/10 p-2 text-sm text-sev-high">{err}</div>}
      {!ro && (
        <section className="card flex flex-wrap items-end gap-2 p-3">
          <div className="min-w-[14rem] flex-1">
            <label className="label" htmlFor="pname">New project</label>
            <input id="pname" className="input" placeholder="e.g. 410 Main St — Level 2" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn-primary" disabled={!!busy} onClick={() => act("new", () => client.createProject(name))}>Create</button>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Your projects</h2>
        {rows == null ? <p className="text-sm text-muted">Loading…</p> : rows.length === 0 ? <Empty>No projects yet. Create one, or build a demo below.</Empty> : (
          <ul className="divide-y divide-line rounded border border-line bg-panel">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/project/?id=${encodeURIComponent(r.id)}`} className="flex flex-wrap items-center justify-between gap-2 p-3 hover:bg-surface">
                  <div className="min-w-0">
                    <div className="font-medium">{r.name}</div>
                    <div className="num text-xs text-muted">{r.created}</div>
                  </div>
                  {r.verdict ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm">{r.verdict.headline}</span>
                      {r.verdict.counts.high > 0 && <Chip severity="high">HIGH {r.verdict.counts.high}</Chip>}
                      {r.verdict.counts.review > 0 && <Chip severity="review">REVIEW {r.verdict.counts.review}</Chip>}
                    </div>
                  ) : <span className="text-xs text-muted">not analysed</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {!ro && (
        <section className="grid gap-3 md:grid-cols-2">
          <div className="card p-3">
            <h3 className="font-semibold">Synthetic office demo</h3>
            <p className="mt-1 text-sm text-muted">6-room floor simulated with occlusion and range falloff. Known answers: Mech 104 never scanned, east corridor thin, planned S7/S9 missed, one long-chain link over tolerance, scope without a validation method.</p>
            <button className="btn mt-2" disabled={!!busy} onClick={() => act("synthetic", () => client.buildDemo("synthetic"))}>{busy === "synthetic" ? "Simulating ~3M points…" : "Build synthetic demo"}</button>
          </div>
          <div className="card p-3">
            <h3 className="font-semibold">Real file: Edinburgh “Synthetic building”</h3>
            <p className="mt-1 text-sm text-muted">
              Valero, E. (2021). Synthetic building [dataset]. Cyberbuild Lab, The University of Edinburgh.{" "}
              <a className="underline" href="https://doi.org/10.7488/ds/2893" target="_blank" rel="noreferrer">doi:10.7488/ds/2893</a>, CC BY 4.0. Downloads the 49 MB E57 once, the only time ScanGap goes online.
            </p>
            <button className="btn mt-2" disabled={!!busy} onClick={() => act("edinburgh", () => client.buildDemo("edinburgh"))}>{busy === "edinburgh" ? "Downloading & reading…" : "Load Edinburgh demo"}</button>
          </div>
        </section>
      )}
      <footer className="text-xs text-muted">
        {health && <>Scope extraction: {health.llm_available ? `Claude (${health.model}) via server-side key` : "offline rules (no API key set)"} · v{health.version}</>}
      </footer>
    </div>
  );
}

export default function Home() {
  // The hosted read-only demo opens straight into the synthetic project.
  if (STATIC_DEMO) return <ProjectView id="demo-synthetic" />;
  return <Projects />;
}
