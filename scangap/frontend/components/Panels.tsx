"use client";

import { useEffect, useRef, useState } from "react";
import { client, fmt } from "@/lib/api";
import type { Bundle, Finding, Requirement, Severity, Spec, Zone } from "@/lib/types";
import { Chip, Empty } from "./Chip";

export interface PanelProps {
  bundle: Bundle;
  editable: boolean;
  run: (p: Promise<Bundle>) => Promise<void>;
}

const MODULE_LABEL: Record<string, string> = {
  spec: "Spec",
  scan: "Scan data",
  coverage: "Coverage",
  plan: "Plan vs actual",
  registration: "Registration",
  validation: "Validation",
  scope: "Scope",
  manifest: "Delivery",
};

function Upload({ label, accept, onFile, disabled }: { label: string; accept: string; onFile: (f: File) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={ref} type="file" accept={accept} className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
      <button className="btn" disabled={disabled} onClick={() => ref.current?.click()}>
        ⇪ {label}
      </button>
    </>
  );
}

function SectionHead({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function FindingList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <Empty>No findings.</Empty>;
  return (
    <ul className="divide-y divide-line rounded border border-line">
      {findings.map((f, i) => (
        <li key={i} className="flex gap-2 p-2">
          <Chip severity={f.severity} />
          <div className="min-w-0">
            <div className="text-sm font-medium leading-snug">{f.title}</div>
            {f.detail && <div className="mt-0.5 text-sm text-muted">{f.detail}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- findings */

export function FindingsPanel({ bundle }: PanelProps) {
  const [mod, setMod] = useState<string>("all");
  const [hidePass, setHidePass] = useState(true);
  const f = bundle.results.findings.filter((x) => (mod === "all" || x.module === mod) && (!hidePass || x.severity !== "pass"));
  const mods = Array.from(new Set(bundle.results.findings.map((x) => x.module)));
  return (
    <div>
      <SectionHead title="Findings">
        <select className="input w-auto" value={mod} onChange={(e) => setMod(e.target.value)} aria-label="Filter by section">
          <option value="all">All sections</option>
          {mods.map((m) => (
            <option key={m} value={m}>{MODULE_LABEL[m] ?? m}</option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 text-sm text-muted">
          <input type="checkbox" checked={hidePass} onChange={(e) => setHidePass(e.target.checked)} /> hide passes
        </label>
      </SectionHead>
      <FindingList findings={f} />
    </div>
  );
}

/* ---------------------------------------------------------------- zones */

export function ZonesPanel({ bundle, editable, run, onSelect }: PanelProps & { onSelect: (id: string) => void }) {
  const { project, results } = bundle;
  const [zones, setZones] = useState<Zone[]>(project.zones);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setZones(project.zones);
    setDirty(false);
  }, [project.zones]);
  const zr = Object.fromEntries((results.zones ?? []).map((r) => [r.zone, r]));
  const loaCodes = results.loa_table.map((l) => l.code);
  const upd = (id: string, patch: Partial<Zone>) => {
    setZones(zones.map((z) => (z.id === id ? { ...z, ...patch } : z)));
    setDirty(true);
  };
  return (
    <div>
      <SectionHead title="Zones & coverage">
        {editable && <Upload label="Import zones JSON" accept=".json" onFile={(f) => run(client.upload(project.id, "zones", f))} />}
        <button
          className="btn"
          onClick={() => {
            const blob = new Blob([JSON.stringify(project.zones, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = "zones.json";
            a.click();
          }}
        >
          ⇩ Export zones
        </button>
      </SectionHead>
      <p className="mb-2 text-sm text-muted">
        Coverage = share of each zone&apos;s perimeter whose walls were captured at the minimum density inside the slice (
        <span className="num">{results.cloud?.slice ?? "0.5–2.0 m"}</span>). Short openings with near-zero returns (doors, glazing) are excluded and listed. Draw zones to the interior wall face.
      </p>
      {!zones.length ? (
        <Empty>No zones yet. Draw rectangles or polygons on the heatmap, or import zones JSON.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th">Zone</th>
                <th className="th">LOA</th>
                <th className="th text-right">Min pts/m²</th>
                <th className="th text-right">Coverage</th>
                <th className="th text-right">Perimeter ok</th>
                <th className="th">Setups</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => {
                const r = zr[z.id];
                return (
                  <tr key={z.id} className={z.in_scope ? "" : "opacity-60"}>
                    <td className="td">
                      <button className="text-left font-medium hover:underline" onClick={() => onSelect(z.id)}>{z.name}</button>
                      {editable && (
                        <label className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                          <input type="checkbox" checked={z.in_scope} onChange={(e) => upd(z.id, { in_scope: e.target.checked })} /> in scope
                        </label>
                      )}
                      {r?.gaps.length ? <div className="text-xs text-sev-high">{r.gaps.length} possible gap{r.gaps.length > 1 ? "s" : ""} — review</div> : null}
                    </td>
                    <td className="td">
                      {editable ? (
                        <select className="input num w-[7rem]" value={z.loa ?? ""} onChange={(e) => upd(z.id, { loa: e.target.value || null })}>
                          <option value="">default ({project.spec.default_loa ?? "none"})</option>
                          {loaCodes.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <span className="num">{r?.loa ?? z.loa ?? "—"}</span>
                      )}
                      {r?.loa_range && <div className="num mt-0.5 text-xs text-muted">{r.loa_range.split(": ")[1]}</div>}
                    </td>
                    <td className="td text-right">
                      {editable ? (
                        <input
                          className="input num w-24 text-right"
                          type="number"
                          min={1}
                          placeholder={String(project.settings.default_min_density)}
                          value={z.min_density ?? ""}
                          onChange={(e) => upd(z.id, { min_density: e.target.value ? Number(e.target.value) : null })}
                        />
                      ) : (
                        <span className="num">{fmt.int(r?.min_density ?? z.min_density)}</span>
                      )}
                    </td>
                    <td className="td num text-right">{r ? fmt.pct(r.coverage_pct) : "—"}</td>
                    <td className="td num text-right text-muted">{r ? `${r.covered_m.toFixed(1)}/${r.evaluated_m.toFixed(1)} m` : "—"}</td>
                    <td className="td num text-xs">{r ? r.setups_inside.join(", ") || "none" : "—"}</td>
                    <td className="td">{r ? <Chip severity={r.severity} /> : <span className="text-xs text-muted">no data</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editable && dirty && (
        <div className="mt-2 flex gap-2">
          <button className="btn-primary" onClick={() => run(client.putZones(project.id, zones))}>Save & recompute</button>
          <button className="btn" onClick={() => { setZones(project.zones); setDirty(false); }}>Discard</button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- spec */

export function SpecPanel({ bundle, editable, run }: PanelProps) {
  const { project, results } = bundle;
  const [s, setS] = useState<Spec>(project.spec);
  useEffect(() => setS(project.spec), [project.spec]);
  const flags = results.findings.filter((f) => f.module === "spec");
  const missing = (v: string | null) => !v || !String(v).trim();
  const field = (k: keyof Spec, label: string, critical: boolean, ph: string, area = false) => (
    <div>
      <label className="label flex items-center gap-2" htmlFor={`spec-${k}`}>
        {label} {critical && missing(s[k] as string | null) && <Chip severity="review" />}
      </label>
      {area ? (
        <textarea id={`spec-${k}`} className="input min-h-[60px]" disabled={!editable} value={(s[k] as string) ?? ""} placeholder={ph} onChange={(e) => setS({ ...s, [k]: e.target.value || null })} />
      ) : (
        <input id={`spec-${k}`} className="input" disabled={!editable} value={(s[k] as string) ?? ""} placeholder={ph} onChange={(e) => setS({ ...s, [k]: e.target.value || null })} />
      )}
    </div>
  );
  const changed = JSON.stringify(s) !== JSON.stringify(project.spec);
  return (
    <div>
      <SectionHead title="Project spec — define accuracy before field work" />
      <div className="grid gap-3 md:grid-cols-2">
        {field("intended_use", "Intended use", true, "e.g. renovation design, MEP coordination", true)}
        {field("validation_method", "Validation method", true, "e.g. 20 total-station check points, NSSDA 95%", true)}
        <div>
          <label className="label flex items-center gap-2" htmlFor="spec-loa">
            Required LOA (default) {missing(s.default_loa) && <Chip severity="review" />}
          </label>
          <select id="spec-loa" className="input num" disabled={!editable} value={s.default_loa ?? ""} onChange={(e) => setS({ ...s, default_loa: e.target.value || null })}>
            <option value="">— not defined —</option>
            {results.loa_table.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted">USIBD measured accuracy, stated at 95% confidence. Per-zone LOA is set in Zones.</p>
        </div>
        {field("lod", "Model LOD", false, "e.g. LOD 300")}
        {field("coordinate_system", "Coordinate system", false, "e.g. EPSG:2272 / local site grid")}
        {field("units", "Units", false, "m, ft, US survey ft")}
        {field("client", "Client", false, "")}
        {field("site", "Site", false, "")}
      </div>
      <div className="mt-4">
        <div className="label">USIBD LOA reference (95% confidence)</div>
        <div className="flex flex-wrap gap-1.5">
          {results.loa_table.map((l) => (
            <span key={l.code} className={`num rounded border px-2 py-0.5 text-xs ${s.default_loa === l.code ? "border-accent text-accent" : "border-line text-muted"}`}>{l.label}</span>
          ))}
        </div>
      </div>
      {editable && changed && (
        <div className="mt-3 flex gap-2">
          <button className="btn-primary" onClick={() => run(client.putSpec(project.id, s))}>Save spec</button>
          <button className="btn" onClick={() => setS(project.spec)}>Discard</button>
        </div>
      )}
      <div className="mt-4">
        <FindingList findings={flags} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- scan data */

export function ScanPanel({ bundle, editable, run }: PanelProps) {
  const { project, results } = bundle;
  const c = results.cloud;
  const [path, setPath] = useState("");
  const [settings, setSettings] = useState(project.settings);
  useEffect(() => setSettings(project.settings), [project.settings]);
  const sChanged = JSON.stringify(settings) !== JSON.stringify(project.settings);
  const num = (k: keyof typeof settings, label: string, step = 0.05) => (
    <div>
      <label className="label" htmlFor={`set-${k}`}>{label}</label>
      <input id={`set-${k}`} className="input num" type="number" step={step} disabled={!editable} value={settings[k] as number} onChange={(e) => setSettings({ ...settings, [k]: Number(e.target.value) })} />
    </div>
  );
  return (
    <div>
      <SectionHead title="Scan data">
        {editable && <Upload label="Poses CSV" accept=".csv,.txt" onFile={(f) => run(client.upload(project.id, "poses", f))} />}
      </SectionHead>
      {editable && (
        <div className="mb-4 rounded border border-line p-3">
          <div className="label">Load point cloud (E57, LAS, LAZ)</div>
          <div className="flex flex-wrap gap-2">
            <input className="input num min-w-[16rem] flex-1" placeholder="/path/on/this/laptop/job.e57 — read in place, not copied" value={path} onChange={(e) => setPath(e.target.value)} />
            <button className="btn-primary" disabled={!path} onClick={() => run(client.cloudFromPath(project.id, path))}>Read from path</button>
            <Upload label="Upload file" accept=".e57,.las,.laz" onFile={(f) => run(client.cloudUpload(project.id, f))} />
          </div>
          <p className="mt-1 text-xs text-muted">Files are streamed in chunks; nothing leaves this machine.</p>
        </div>
      )}
      {!c ? (
        <Empty>No point cloud loaded.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="label">Read from file</div>
            <table className="w-full">
              <tbody>
                <tr><td className="td text-muted">File</td><td className="td num break-all">{c.file} <span className="text-muted">({fmt.bytes(c.file_size)}, {c.format}, {c.reader})</span></td></tr>
                {Object.entries(c.read).map(([k, v]) => (
                  <tr key={k}><td className="td text-muted">{k}</td><td className="td num break-words">{v}</td></tr>
                ))}
                <tr><td className="td text-muted">Floors</td><td className="td num">{c.floors.map((z) => `${z.toFixed(2)} m`).join(", ")} <span className="text-muted">({c.floor_source})</span></td></tr>
                <tr><td className="td text-muted">Extent</td><td className="td num">{(c.bounds[1][0] - c.bounds[0][0]).toFixed(1)} × {(c.bounds[1][1] - c.bounds[0][1]).toFixed(1)} × {(c.bounds[1][2] - c.bounds[0][2]).toFixed(1)} m</td></tr>
                <tr><td className="td text-muted">Setup positions</td><td className="td">{c.setup_source}</td></tr>
              </tbody>
            </table>
          </div>
          <div>
            <div className="label">Absent from file</div>
            {c.absent.length ? (
              <ul className="mb-3 flex flex-wrap gap-1.5">
                {c.absent.map((a) => <li key={a} className="num rounded border border-dashed border-line px-2 py-0.5 text-xs text-muted">{a}</li>)}
              </ul>
            ) : <p className="mb-3 text-sm text-muted">Nothing expected was missing.</p>}
            {c.notes.map((n) => <p key={n} className="mb-1 text-sm text-muted">• {n}</p>)}
            <div className="label mt-3">Scans</div>
            <div className="max-h-56 overflow-auto rounded border border-line">
              <table className="w-full">
                <thead><tr><th className="th">Scan</th><th className="th text-right">Points</th><th className="th text-right">Position (x, y, z)</th></tr></thead>
                <tbody>
                  {c.scan_list.map((s) => (
                    <tr key={s.name}><td className="td num">{s.name}</td><td className="td num text-right">{fmt.int(s.points)}</td><td className="td num text-right text-muted">{s.position ? s.position.map((v) => v.toFixed(2)).join(", ") : "absent"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      <div className="mt-4">
        <div className="label">Analysis settings</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {num("cell_size", "Cell size (m)")}
          {num("slice_min", "Slice from (m above floor)")}
          {num("slice_max", "Slice to (m above floor)")}
          {num("default_min_density", "Default min pts/m²", 50)}
          {num("min_zone_coverage_pct", "Zone target %", 1)}
          {num("wall_band", "Wall band (m)")}
          {num("plan_tolerance", "Plan tolerance (m)", 0.1)}
          {num("registration_tolerance_mm", "Link tolerance (mm)", 0.5)}
        </div>
        {editable && sChanged && (
          <div className="mt-2 flex gap-2">
            <button className="btn-primary" onClick={() => run(client.putSettings(project.id, settings))}>Apply settings (re-grids if cell/slice changed)</button>
            <button className="btn" onClick={() => setSettings(project.settings)}>Discard</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- plan */

export function PlanPanel({ bundle, editable, run }: PanelProps) {
  const { project, results } = bundle;
  const p = results.plan;
  const f = results.findings.filter((x) => x.module === "plan");
  return (
    <div>
      <SectionHead title="Scan plan vs actual">
        {editable && <Upload label={p ? "Replace plan CSV" : "Import plan CSV"} accept=".csv,.txt" onFile={(fl) => run(client.upload(project.id, "plan", fl))} />}
      </SectionHead>
      <p className="mb-2 text-sm text-muted">CSV columns: <span className="num">label,x,y[,zone]</span>. Planned setups are matched to actual positions ({results.cloud?.setup_source ?? "none"}) one-to-one within the tolerance.</p>
      {!p ? <Empty>No scan plan imported.</Empty> : (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-sm">
            <span>Matched <span className="num font-semibold">{p.matched}/{p.rows.length}</span></span>
            <span>Tolerance <span className="num">{p.tolerance_m} m</span></span>
            <span>Unplanned <span className="num">{p.unplanned.length}</span></span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead><tr><th className="th">Planned</th><th className="th text-right">x, y</th><th className="th">Status</th><th className="th">Actual</th><th className="th text-right">Offset</th><th className="th">Meant to cover</th></tr></thead>
              <tbody>
                {p.rows.map((r) => (
                  <tr key={r.label}>
                    <td className="td num font-medium">{r.label}</td>
                    <td className="td num text-right text-muted">{r.x.toFixed(2)}, {r.y.toFixed(2)}</td>
                    <td className="td">{r.status === "missing" ? <Chip severity="high">MISSING</Chip> : <Chip severity="pass">FOUND</Chip>}</td>
                    <td className="td num">{r.actual ?? (r.nearest ? <span className="text-muted">nearest {r.nearest.label} @ {r.nearest.distance_m} m</span> : "—")}</td>
                    <td className="td num text-right">{r.offset_m != null ? `${r.offset_m.toFixed(2)} m` : "—"}</td>
                    <td className="td text-sm">{r.zone_names.join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3"><FindingList findings={f} /></div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- registration */

export function RegistrationPanel({ bundle, editable, run }: PanelProps) {
  const { project, results } = bundle;
  const r = results.registration;
  const v = results.validation;
  const maxE = r ? Math.max(...r.links.map((l) => l.error_mm), r.tolerance_mm) * 1.1 : 1;
  return (
    <div>
      <SectionHead title="Registration report">
        {editable && <Upload label={r ? "Replace links CSV" : "Import links CSV"} accept=".csv,.txt" onFile={(f) => run(client.upload(project.id, "registration", f))} />}
        {editable && <Upload label="Check points CSV" accept=".csv,.txt" onFile={(f) => run(client.upload(project.id, "checkpoints", f))} />}
      </SectionHead>
      <p className="mb-3 rounded border border-line bg-surface p-2 text-sm text-muted">
        Link errors measure how well scans agree with each other, not accuracy. ScanGap never states LOA compliance; that needs independent check points (survey vs scan), which you can import above for a residual comparison at 95%.
      </p>
      {!r ? <Empty>No registration CSV imported. Columns: <span className="num">from,to,error_mm[,overlap_pct,type]</span>; targets: <span className="num">id,,error_mm,,target</span>.</Empty> : (
        <>
          <div className="mb-2 flex flex-wrap gap-4 text-sm">
            <span>Links <span className="num">{r.stats.n}</span></span>
            <span>Max <span className="num">{fmt.mm(r.stats.max_mm)}</span></span>
            <span>Mean <span className="num">{fmt.mm(r.stats.mean_mm)}</span></span>
            <span>Tolerance <span className="num">{fmt.mm(r.tolerance_mm, 1)}</span></span>
            {r.loa && <span className="text-muted">Target for context: <span className="num">{r.loa.label}</span></span>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead><tr><th className="th">Link</th><th className="th">Error</th><th className="th text-right">Overlap</th><th className="th">Status</th></tr></thead>
              <tbody>
                {r.links.map((l) => {
                  const over = l.error_mm > r.tolerance_mm;
                  return (
                    <tr key={l.id}>
                      <td className="td num">{l.id}</td>
                      <td className="td">
                        <div className="flex items-center gap-2">
                          <div className="relative h-2.5 w-32 rounded-sm bg-surface sm:w-48" aria-hidden>
                            <div className={`absolute inset-y-0 left-0 rounded-sm ${over ? "bg-sev-high" : "bg-accent"}`} style={{ width: `${(l.error_mm / maxE) * 100}%` }} />
                            <div className="absolute inset-y-[-3px] w-px bg-ink" style={{ left: `${(r.tolerance_mm / maxE) * 100}%` }} title="tolerance" />
                          </div>
                          <span className="num text-sm">{l.error_mm.toFixed(1)} mm</span>
                        </div>
                      </td>
                      <td className="td num text-right text-muted">{l.overlap_pct != null ? `${l.overlap_pct}%` : "—"}</td>
                      <td className="td">{over ? <Chip severity="review">OVER TOL</Chip> : <Chip severity="pass">OK</Chip>}</td>
                    </tr>
                  );
                })}
                {r.targets.map((t) => (
                  <tr key={t.id}>
                    <td className="td num">{t.id} <span className="text-muted">target</span></td>
                    <td className="td num">{t.error_mm.toFixed(1)} mm</td>
                    <td className="td" />
                    <td className="td">{t.error_mm > r.tolerance_mm ? <Chip severity="review">OVER TOL</Chip> : <Chip severity="pass">OK</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="label mt-4">Chains (sequences without loop closure)</div>
          <ul className="space-y-1 text-sm">
            {r.chains.filter((c) => c.links >= 2).map((c) => (
              <li key={c.scans.join("-")} className="flex flex-wrap items-center gap-2">
                {c.unconstrained && c.links >= project.settings.long_chain_links ? <Chip severity="high">LONG CHAIN</Chip> : <Chip severity="info">{c.unconstrained ? "OPEN" : "IN LOOP"}</Chip>}
                <span className="num">{c.scans.join(" – ")}</span>
                <span className="num text-muted">{c.links} links · RSS {c.rss_mm} mm · sum {c.sum_mm} mm</span>
              </li>
            ))}
          </ul>
          <div className="mt-3"><FindingList findings={r.findings.filter((x) => x.severity !== "pass")} /></div>
        </>
      )}
      {v && v.n > 0 && (
        <div className="mt-4">
          <div className="label">Validation against check points</div>
          <div className="mb-2 flex flex-wrap gap-4 text-sm">
            <span>n <span className="num">{v.n}</span></span>
            <span>H95 <span className="num">{fmt.mm(v.h95_mm)}</span></span>
            <span>V95 <span className="num">{fmt.mm(v.v95_mm)}</span></span>
            <span>RMSEr <span className="num">{fmt.mm(v.rmse_r_mm)}</span></span>
            <span>RMSEz <span className="num">{fmt.mm(v.rmse_z_mm)}</span></span>
          </div>
          <FindingList findings={v.findings} />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- scope */

const CAT_LABEL: Record<string, string> = {
  intended_use: "Intended use", loa: "LOA", lod: "LOD", validation: "Validation", coordinate_system: "Coordinate system",
  units: "Units", deliverable: "Deliverable", naming: "Naming", area: "Area", schedule: "Schedule", other: "Other",
};

export function ScopePanel({ bundle, editable, run, llm }: PanelProps & { llm: boolean }) {
  const { project, results } = bundle;
  const [reqs, setReqs] = useState<Requirement[]>(project.requirements);
  useEffect(() => setReqs(project.requirements), [project.requirements]);
  const dirty = JSON.stringify(reqs) !== JSON.stringify(project.requirements);
  const sc = project.scope;
  const setStatus = (id: string, status: Requirement["status"]) => setReqs(reqs.map((r) => (r.id === id ? { ...r, status } : r)));
  const accepted = project.requirements.filter((r) => r.status === "accepted").length;
  return (
    <div>
      <SectionHead title="Scope document → requirements">
        {editable && <Upload label={sc ? "Replace scope" : "Upload scope PDF/TXT"} accept=".pdf,.txt,.md" onFile={(f) => run(client.upload(project.id, "scope", f))} />}
      </SectionHead>
      <p className="mb-3 text-sm text-muted">
        {llm ? "Extraction uses Claude (server-side key) into a fixed schema" : "Extraction uses offline keyword rules (no API key, or offline mode)"}. Every requirement carries a verbatim quote that is checked against the document; anything whose quote cannot be found is rejected. Nothing feeds the checks until you accept it.
      </p>
      {!sc ? <Empty>No scope document yet.</Empty> : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="num">{sc.file}</span>
            <Chip severity="info">{sc.extractor === "llm" ? "LLM" : "OFFLINE RULES"}</Chip>
            {sc.not_addressed.map((n) => (
              <Chip key={n} severity={["intended_use", "loa", "validation"].includes(n) ? "review" : "info"}>NOT IN SCOPE DOC: {CAT_LABEL[n]?.toUpperCase() ?? n}</Chip>
            ))}
          </div>
          {sc.note && <p className="mb-2 text-sm text-muted">{sc.note}</p>}
          <ul className="divide-y divide-line rounded border border-line">
            {reqs.map((r) => (
              <li key={r.id} className={`p-2 ${r.status === "rejected" ? "opacity-60" : ""}`}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-surface px-1.5 py-0.5 text-xs font-medium text-muted">{CAT_LABEL[r.category] ?? r.category}</span>
                      {r.value && <span className="num text-sm font-semibold">{r.value}</span>}
                      {r.zone && <span className="text-xs text-muted">zone: {r.zone}</span>}
                    </div>
                    <div className="mt-1 text-sm">{r.text}</div>
                    <blockquote className="mt-1 border-l-2 border-line pl-2 text-xs italic text-muted">“{r.source_quote}”{" "}
                      {r.quote_verified ? <span className="not-italic text-sev-passtext">✓ found in document</span> : <span className="not-italic text-sev-high">✕ quote not found — discarded</span>}
                    </blockquote>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {(["accepted", "rejected"] as const).map((st) => (
                      <button
                        key={st}
                        disabled={!editable || (!r.quote_verified && st === "accepted")}
                        onClick={() => setStatus(r.id, r.status === st ? "proposed" : st)}
                        className={`rounded border px-2 py-1 text-xs font-medium disabled:opacity-40 ${r.status === st ? (st === "accepted" ? "border-sev-pass bg-sev-pass/15 text-sev-passtext" : "border-sev-high bg-sev-high/10 text-sev-high") : "border-line"}`}
                      >
                        {st === "accepted" ? "Accept" : "Reject"}
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {editable && (
            <div className="mt-3 flex flex-wrap gap-2">
              {dirty && <button className="btn-primary" onClick={() => run(client.putRequirements(project.id, reqs))}>Save review</button>}
              <button className="btn" disabled={dirty || !accepted} onClick={() => run(client.applyRequirements(project.id))} title="Fills empty spec fields and deliverables from accepted requirements">
                Apply {accepted} accepted to spec & deliverables
              </button>
            </div>
          )}
          <div className="mt-3"><FindingList findings={results.findings.filter((f) => f.module === "scope")} /></div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- delivery */

export function DeliveryPanel({ bundle, editable, run }: PanelProps) {
  const { project, results } = bundle;
  const m = results.manifest;
  const [folder, setFolder] = useState("");
  const [rx, setRx] = useState(project.naming_regex ?? "");
  const [delivs, setDelivs] = useState(project.deliverables);
  useEffect(() => { setDelivs(project.deliverables); setRx(project.naming_regex ?? ""); }, [project.deliverables, project.naming_regex]);
  const dirty = JSON.stringify(delivs) !== JSON.stringify(project.deliverables) || rx !== (project.naming_regex ?? "");
  return (
    <div>
      <SectionHead title="Delivery package">
        {editable && <Upload label="Manifest (JSON/CSV/list)" accept=".json,.csv,.txt" onFile={(f) => run(client.upload(project.id, "manifest", f))} />}
      </SectionHead>
      {editable && (
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="input num min-w-[16rem] flex-1" placeholder="/path/to/delivery/folder — files are opened and inspected" value={folder} onChange={(e) => setFolder(e.target.value)} />
          <button className="btn" disabled={!folder} onClick={() => run(client.manifestFolder(project.id, folder))}>Inspect folder</button>
        </div>
      )}
      <div className="mb-4 grid gap-3 md:grid-cols-2">
        <div>
          <div className="label">Expected deliverables</div>
          {delivs.length === 0 && <p className="text-sm text-muted">None yet — accept deliverable requirements from the scope, or add one.</p>}
          <ul className="space-y-1">
            {delivs.map((d, i) => (
              <li key={i} className="flex gap-1">
                <input className="input" disabled={!editable} value={d.name} onChange={(e) => setDelivs(delivs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input className="input num w-20" disabled={!editable} value={d.format ?? ""} placeholder="ext" onChange={(e) => setDelivs(delivs.map((x, j) => (j === i ? { ...x, format: e.target.value || null } : x)))} />
                {editable && <button className="btn" aria-label="Remove" onClick={() => setDelivs(delivs.filter((_, j) => j !== i))}>✕</button>}
              </li>
            ))}
          </ul>
          {editable && <button className="btn mt-1" onClick={() => setDelivs([...delivs, { name: "New deliverable", format: null, pattern: null, source: "manual" }])}>+ Add</button>}
        </div>
        <div>
          <label className="label" htmlFor="naming-rx">Naming convention (regex)</label>
          <input id="naming-rx" className="input num" disabled={!editable} value={rx} placeholder="^PROJ_L1_[^/]+?\.[A-Za-z0-9]+$" onChange={(e) => setRx(e.target.value)} />
          {editable && dirty && (
            <div className="mt-2 flex gap-2">
              <button className="btn-primary" onClick={() => run(client.putDeliverables(project.id, { deliverables: delivs, naming_regex: rx || null }))}>Save & recheck</button>
            </div>
          )}
        </div>
      </div>
      {!m ? <Empty>No manifest or folder yet.</Empty> : (
        <>
          <div className="label">Deliverables vs package</div>
          <div className="mb-4 overflow-x-auto">
            <table className="w-full min-w-[480px]">
              <thead><tr><th className="th">Deliverable</th><th className="th">Matched files</th><th className="th">Status</th></tr></thead>
              <tbody>
                {m.deliverables.map((d) => (
                  <tr key={d.deliverable}>
                    <td className="td">{d.deliverable} <span className="num text-xs text-muted">{d.format?.toUpperCase()}</span></td>
                    <td className="td num text-xs">{d.files.join(", ") || "—"}</td>
                    <td className="td">{d.status === "missing" ? <Chip severity="high">MISSING</Chip> : d.status === "inspected" ? <Chip severity="pass">FILE INSPECTED</Chip> : <Chip severity="info">LISTED ONLY</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="label">Files</div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px]">
              <thead><tr><th className="th">File</th><th className="th text-right">Size</th><th className="th">Source</th><th className="th">Naming</th><th className="th">Detail</th></tr></thead>
              <tbody>
                {m.files.map((f) => (
                  <tr key={f.name}>
                    <td className="td num break-all">{f.name}</td>
                    <td className="td num text-right text-muted">{fmt.bytes(f.size)}</td>
                    <td className="td">{f.status === "inspected" ? <Chip severity={f.valid === false ? "high" : "pass"}>INSPECTED</Chip> : <Chip severity="info">LISTED</Chip>}</td>
                    <td className="td">{f.naming_ok == null ? "—" : f.naming_ok ? <Chip severity="pass">OK</Chip> : <Chip severity="review">BREAKS</Chip>}</td>
                    <td className="td text-xs text-muted">{f.detail || "name/size only"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3"><FindingList findings={results.findings.filter((f) => f.module === "manifest")} /></div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- report */

export function ReportPanel({ bundle, editable }: PanelProps) {
  const { project, results } = bundle;
  const [so, setSo] = useState(project.signoff);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await client.putSignoff(project.id, so);
    setSaved(true);
  };
  const counts = results.verdict.counts;
  return (
    <div>
      <SectionHead title="Report" />
      <p className="mb-3 text-sm text-muted">
        One-page PDF (spec summary, heatmap, per-zone table, plan vs actual, registration flags, open items, sign-off, timestamp) and a full CSV of every finding.
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="rev">Reviewer</label>
          <input id="rev" className="input" disabled={!editable} value={so.reviewer} onChange={(e) => { setSo({ ...so, reviewer: e.target.value }); setSaved(false); }} />
        </div>
        <div>
          <label className="label" htmlFor="rdate">Date</label>
          <input id="rdate" className="input num" type="date" disabled={!editable} value={so.date} onChange={(e) => { setSo({ ...so, date: e.target.value }); setSaved(false); }} />
        </div>
        <div className="flex items-end">
          {editable && <button className="btn" onClick={save}>{saved ? "Saved ✓" : "Save sign-off"}</button>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a className="btn-primary" href={client.reportUrl(project.id, "pdf")} target="_blank" rel="noreferrer">⇩ PDF report</a>
        <a className="btn" href={client.reportUrl(project.id, "csv")}>⇩ CSV</a>
      </div>
      <p className="mt-3 text-sm text-muted">
        Open items: <span className="num">{counts.high}</span> high, <span className="num">{counts.review}</span> review. ScanGap is a QA aid, not certification.
      </p>
    </div>
  );
}

export const SEV_ORDER: Severity[] = ["high", "review", "info", "pass"];
