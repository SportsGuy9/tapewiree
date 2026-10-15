"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeDensity, fmt } from "@/lib/api";
import type { GridPayload, PlanRow, Zone, ZoneResult } from "@/lib/types";

// Sequential blue ramp, light = low (validated reference palette)
const RAMP = ["#e8f1fc", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
const WARN = [250, 178, 25];

function hex(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const RAMP_RGB = RAMP.map(hex);

function rampAt(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t)) * (RAMP_RGB.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = RAMP_RGB[i];
  const b = RAMP_RGB[Math.min(i + 1, RAMP_RGB.length - 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

type Tool = "select" | "rect" | "poly";
type Pt = [number, number];

interface Props {
  grid: GridPayload;
  zones: Zone[];
  zoneResults: ZoneResult[];
  setups: { label: string; x: number; y: number }[];
  planRows: PlanRow[];
  minDensity: number;
  editable: boolean;
  onSaveZones?: (z: Zone[]) => Promise<void>;
  selectedZone?: string | null;
  onSelectZone?: (id: string | null) => void;
}

const SEV_STROKE: Record<string, string> = {
  high: "stroke-sev-high",
  review: "stroke-sev-review",
  pass: "stroke-sev-pass",
  info: "stroke-muted",
};

export default function Heatmap(props: Props) {
  const { grid, zoneResults, setups, planRows, minDensity, editable } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [pxWidth, setPxWidth] = useState(800);
  const [mode, setMode] = useState<"density" | "threshold">("density");
  const [layers, setLayers] = useState({ zones: true, gaps: true, setups: true, plan: true });
  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<Pt[] | null>(null);
  const [dragStart, setDragStart] = useState<Pt | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; d: number; sx: number; sy: number } | null>(null);
  const [zones, setZones] = useState<Zone[]>(props.zones);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<Pt[] | null>(null);
  const [newName, setNewName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [localSel, setLocalSel] = useState<string | null>(null);
  const selected = props.selectedZone !== undefined ? props.selectedZone : localSel;
  const select = (id: string | null) => (props.onSelectZone ? props.onSelectZone(id) : setLocalSel(id));

  useEffect(() => {
    setZones(props.zones);
    setDirty(false);
  }, [props.zones]);

  const dens = useMemo(() => decodeDensity(grid.density_b64), [grid.density_b64]);
  const x0 = grid.origin[0];
  const y0 = grid.origin[1];
  const W = grid.nx * grid.cell;
  const H = grid.ny * grid.cell;
  const k = W / Math.max(pxWidth, 1); // world units per screen px

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPxWidth(el.clientWidth));
    ro.observe(el);
    setPxWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // paint density
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.width = grid.nx;
    c.height = grid.ny;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(grid.nx, grid.ny);
    const zeroVar = getComputedStyle(document.documentElement).getPropertyValue("--heat-zero").trim() || "255 255 255";
    const zero = zeroVar.split(/\s+/).map(Number);
    const vmax = Math.max(grid.p99, 1);
    const vmin = Math.max(vmax / 1000, 1);
    const lmin = Math.log(vmin);
    const lrange = Math.log(vmax) - lmin;
    for (let iy = 0; iy < grid.ny; iy++) {
      const row = grid.ny - 1 - iy;
      for (let ix = 0; ix < grid.nx; ix++) {
        const d = dens[iy * grid.nx + ix];
        const o = (row * grid.nx + ix) * 4;
        let rgb: number[];
        if (d <= 0) rgb = zero;
        else if (mode === "threshold") rgb = d >= minDensity ? RAMP_RGB[5] : WARN;
        else rgb = rampAt((Math.log(Math.max(d, vmin)) - lmin) / lrange);
        img.data[o] = rgb[0];
        img.data[o + 1] = rgb[1];
        img.data[o + 2] = rgb[2];
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [dens, grid, mode, minDensity]);

  const toWorld = useCallback(
    (e: { clientX: number; clientY: number }): Pt => {
      const r = svgRef.current!.getBoundingClientRect();
      return [x0 + ((e.clientX - r.left) / r.width) * W, y0 + H - ((e.clientY - r.top) / r.height) * H];
    },
    [x0, y0, W, H],
  );

  const densityAt = (x: number, y: number) => {
    const ix = Math.floor((x - x0) / grid.cell);
    const iy = Math.floor((y - y0) / grid.cell);
    if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) return 0;
    return dens[iy * grid.nx + ix];
  };

  const snap = (v: number) => Math.round(v / 0.05) * 0.05;

  const onDown = (e: React.PointerEvent) => {
    if (!editable) return;
    const p = toWorld(e);
    if (tool === "rect") {
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDragStart([snap(p[0]), snap(p[1])]);
      setDraft([[snap(p[0]), snap(p[1])]]);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const p = toWorld(e);
    const r = svgRef.current!.getBoundingClientRect();
    setHover({ x: p[0], y: p[1], d: densityAt(p[0], p[1]), sx: e.clientX - r.left, sy: e.clientY - r.top });
    if (tool === "rect" && dragStart) {
      const q: Pt = [snap(p[0]), snap(p[1])];
      setDraft([dragStart, [q[0], dragStart[1]], q, [dragStart[0], q[1]]]);
    }
  };
  const onUp = () => {
    if (tool === "rect" && dragStart && draft && draft.length === 4) {
      const w = Math.abs(draft[2][0] - draft[0][0]);
      const h = Math.abs(draft[2][1] - draft[0][1]);
      if (w > 0.3 && h > 0.3) {
        const xs = [draft[0][0], draft[2][0]].sort((a, b) => a - b);
        const ys = [draft[0][1], draft[2][1]].sort((a, b) => a - b);
        setPending([[xs[0], ys[0]], [xs[1], ys[0]], [xs[1], ys[1]], [xs[0], ys[1]]]);
      }
      setDraft(null);
    }
    setDragStart(null);
  };
  const onClick = (e: React.MouseEvent) => {
    if (!editable || tool !== "poly") return;
    const p = toWorld(e);
    const q: Pt = [snap(p[0]), snap(p[1])];
    const cur = draft ?? [];
    if (cur.length >= 3 && Math.hypot(q[0] - cur[0][0], q[1] - cur[0][1]) < 12 * k) {
      setPending(cur);
      setDraft(null);
      return;
    }
    setDraft([...cur, q]);
  };
  const onDouble = () => {
    if (tool === "poly" && draft && draft.length >= 3) {
      setPending(draft);
      setDraft(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft(null);
        setPending(null);
      }
      if (e.key === "Enter" && tool === "poly" && draft && draft.length >= 3) {
        setPending(draft);
        setDraft(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool, draft]);

  const addPending = () => {
    if (!pending) return;
    let n = zones.length + 1;
    while (zones.some((z) => z.id === `Z${n}`)) n++;
    const z: Zone = {
      id: `Z${n}`,
      name: newName.trim() || `Zone ${n}`,
      polygon: pending.map(([a, b]) => [Number(a.toFixed(3)), Number(b.toFixed(3))]) as [number, number][],
      floor: grid.floor,
      loa: null,
      min_density: null,
      in_scope: true,
    };
    setZones([...zones, z]);
    setPending(null);
    setNewName("");
    setDirty(true);
    select(z.id);
  };

  const save = async () => {
    if (!props.onSaveZones) return;
    setSaving(true);
    setErr(null);
    try {
      await props.onSaveZones(zones);
      setDirty(false);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  const zr = useMemo(() => Object.fromEntries(zoneResults.map((r) => [r.zone, r])), [zoneResults]);
  const sel = zones.find((z) => z.id === selected);
  const fs = 11 * k;
  const poly = (pts: Pt[]) => pts.map(([a, b]) => `${a},${-b}`).join(" ");
  const floorZones = zones.filter((z) => (z.floor ?? 0) === grid.floor);

  return (
    <div>
      {/* toolbar */}
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <div className="inline-flex overflow-hidden rounded border border-line" role="group" aria-label="Colour mode">
          {(["density", "threshold"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-2.5 py-1 ${mode === m ? "bg-ink text-panel" : "bg-panel text-ink hover:bg-surface"}`}
            >
              {m === "density" ? "Density" : `≥ ${fmt.int(minDensity)} pts/m²`}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {(Object.keys(layers) as (keyof typeof layers)[]).map((l) => (
            <label key={l} className="inline-flex cursor-pointer items-center gap-1">
              <input
                type="checkbox"
                checked={layers[l]}
                onChange={(e) => setLayers({ ...layers, [l]: e.target.checked })}
              />
              {l === "plan" ? "planned" : l}
            </label>
          ))}
        </div>
        {editable && (
          <div className="ml-auto inline-flex overflow-hidden rounded border border-line" role="group" aria-label="Zone tools">
            {(
              [
                ["select", "Select"],
                ["rect", "▭ Rectangle"],
                ["poly", "⬠ Polygon"],
              ] as const
            ).map(([t, label]) => (
              <button
                key={t}
                onClick={() => {
                  setTool(t);
                  setDraft(null);
                }}
                className={`px-2.5 py-1 ${tool === t ? "bg-accent text-white" : "bg-panel text-ink hover:bg-surface"}`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {editable && tool === "poly" && (
        <p className="mb-1 text-xs text-muted">Click to add vertices; click the first vertex, double-click or press Enter to close. Esc cancels.</p>
      )}

      <div ref={boxRef} className="relative w-full select-none overflow-hidden rounded border border-line bg-panel" style={{ aspectRatio: `${grid.nx} / ${grid.ny}` }}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" style={{ imageRendering: "pixelated" }} aria-hidden />
        <svg
          ref={svgRef}
          role="img"
          aria-label="Top-down coverage heatmap with zones and scan positions"
          className={`absolute inset-0 h-full w-full ${tool !== "select" ? "cursor-crosshair" : ""}`}
          viewBox={`${x0} ${-(y0 + H)} ${W} ${H}`}
          preserveAspectRatio="none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setHover(null)}
          onClick={onClick}
          onDoubleClick={onDouble}
        >
          {layers.zones &&
            floorZones.map((z) => {
              const r = zr[z.id];
              const isSel = z.id === selected;
              return (
                <g key={z.id}>
                  <polygon
                    points={poly(z.polygon)}
                    className={`${r ? SEV_STROKE[r.severity] : "stroke-muted"} ${isSel ? "fill-accent/10" : "fill-transparent"}`}
                    strokeWidth={isSel ? 2.5 : 1.5}
                    strokeDasharray={r ? undefined : "4 3"}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: tool === "select" ? "pointer" : undefined }}
                    onClick={(e) => {
                      if (tool === "select") {
                        e.stopPropagation();
                        select(isSel ? null : z.id);
                      }
                    }}
                  />
                </g>
              );
            })}
          {layers.gaps &&
            zoneResults
              .filter((r) => r.floor === grid.floor)
              .flatMap((r) =>
                r.gaps.map((g, i) => (
                  <polyline
                    key={`${r.zone}-${i}`}
                    points={poly(g.path)}
                    fill="none"
                    className="stroke-sev-high"
                    strokeWidth={4}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`Possible gap — review: ${g.length_m} m, ${g.kind} (${r.name})`}</title>
                  </polyline>
                )),
              )}
          {layers.zones &&
            floorZones.map((z) => {
              const r = zr[z.id];
              const xs = z.polygon.map((p) => p[0]);
              const ys = z.polygon.map((p) => p[1]);
              const lx = Math.min(...xs) + 6 * k;
              const ty = Math.max(...ys) - 6 * k;
              const text = `${z.name}${r ? `  ${r.coverage_pct.toFixed(0)}%` : ""}`;
              return (
                <g key={`l-${z.id}`} pointerEvents="none">
                  <rect x={lx - 3 * k} y={-ty - 2 * k} width={(text.length * 6.3 + 6) * k} height={fs * 1.45} rx={2 * k} className="fill-panel/90" />
                  <text x={lx} y={-ty + fs} fontSize={fs} className="fill-ink" style={{ fontFamily: "var(--font-sans)" }}>
                    {text}
                  </text>
                </g>
              );
            })}
          {layers.plan &&
            planRows.map((p) =>
              p.status === "missing" ? (
                <g key={`p-${p.label}`} pointerEvents="none">
                  <path
                    d={`M${p.x - 6 * k},${-p.y - 6 * k}L${p.x + 6 * k},${-p.y + 6 * k}M${p.x - 6 * k},${-p.y + 6 * k}L${p.x + 6 * k},${-p.y - 6 * k}`}
                    className="stroke-sev-high"
                    strokeWidth={3}
                    vectorEffect="non-scaling-stroke"
                  />
                  <text x={p.x + 8 * k} y={-p.y + 4 * k} fontSize={fs} fontWeight={600} className="fill-sev-high">
                    {p.label} planned · missing
                  </text>
                </g>
              ) : (
                <circle key={`p-${p.label}`} cx={p.x} cy={-p.y} r={6 * k} className="fill-none stroke-muted" strokeWidth={1.2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
              ),
            )}
          {layers.setups &&
            setups.map((s) => (
              <g key={`s-${s.label}`} pointerEvents="none">
                <circle cx={s.x} cy={-s.y} r={3.5 * k} className="fill-ink stroke-panel" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
                <text x={s.x + 5 * k} y={-s.y - 5 * k} fontSize={fs * 0.9} className="fill-ink" style={{ fontFamily: "var(--font-mono)" }}>
                  {s.label}
                </text>
              </g>
            ))}
          {draft && draft.length > 0 && (
            <polyline
              points={poly(tool === "poly" && hover ? [...draft, [hover.x, hover.y]] : draft.length === 4 ? [...draft, draft[0]] : draft)}
              fill="none"
              className="stroke-accent"
              strokeWidth={2}
              strokeDasharray="5 3"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {pending && <polygon points={poly(pending)} className="fill-accent/15 stroke-accent" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        </svg>
        {hover && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-line bg-panel/95 px-2 py-1 text-xs shadow-sm"
            style={{ left: Math.min(hover.sx + 12, pxWidth - 170), top: Math.max(hover.sy - 40, 4) }}
          >
            <div className="num text-muted">
              x {hover.x.toFixed(2)} · y {hover.y.toFixed(2)}
            </div>
            <div className="num">
              {hover.d > 0 ? `${fmt.int(hover.d)} pts/m²` : "no returns"}
              {hover.d > 0 && (
                <span className={hover.d >= minDensity ? "text-sev-passtext" : "text-sev-reviewtext"}>
                  {" "}
                  {hover.d >= minDensity ? "≥ min" : "< min"}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* legend */}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {mode === "density" ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="num">{fmt.int(Math.max(grid.p99 / 1000, 1))}</span>
            <span className="h-2.5 w-24 rounded-sm" style={{ background: `linear-gradient(90deg, ${RAMP.join(",")})` }} />
            <span className="num">{fmt.int(grid.p99)}</span> pts/m² (log)
          </span>
        ) : (
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: RAMP[5] }} /> ≥ min
            <span className="inline-block h-2.5 w-3 rounded-sm" style={{ background: `rgb(${WARN.join(",")})` }} /> below min
          </span>
        )}
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-ink" /> actual setup
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-bold text-sev-high">✕</span> planned, missing
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-1 w-4 rounded bg-sev-high" /> possible gap — review
        </span>
        <span className="num">
          slice {(grid.slice[0] - grid.z).toFixed(1)}–{(grid.slice[1] - grid.z).toFixed(1)} m above floor @ {grid.z.toFixed(2)} m · cell {grid.cell} m
        </span>
      </div>

      {pending && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-accent/40 bg-accent/5 p-2">
          <div className="min-w-[12rem] flex-1">
            <label className="label" htmlFor="zone-name">New zone name</label>
            <input id="zone-name" autoFocus className="input" value={newName} placeholder="e.g. Mech 104" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addPending()} />
          </div>
          <button className="btn-primary" onClick={addPending}>Add zone</button>
          <button className="btn" onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      {editable && sel && !pending && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded border border-line p-2">
          <div className="min-w-[10rem] flex-1">
            <label className="label" htmlFor="sel-name">Zone name</label>
            <input
              id="sel-name"
              className="input"
              value={sel.name}
              onChange={(e) => {
                setZones(zones.map((z) => (z.id === sel.id ? { ...z, name: e.target.value } : z)));
                setDirty(true);
              }}
            />
          </div>
          <button
            className="btn"
            onClick={() => {
              setZones(zones.filter((z) => z.id !== sel.id));
              setDirty(true);
              select(null);
            }}
          >
            Delete zone
          </button>
        </div>
      )}
      {editable && dirty && (
        <div className="mt-2 flex items-center gap-2">
          <button className="btn-primary" disabled={saving} onClick={save}>
            {saving ? "Recomputing…" : "Save zones & recompute"}
          </button>
          <button className="btn" onClick={() => { setZones(props.zones); setDirty(false); }}>Discard</button>
          {err && <span className="text-sm text-sev-high">{err}</span>}
        </div>
      )}
    </div>
  );
}
