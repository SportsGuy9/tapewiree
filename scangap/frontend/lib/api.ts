import type { Bundle, GridPayload, Health, Requirement, Settings, Spec, Zone } from "./types";

/** Static demo: the UI reads baked JSON from ./demo/ and never writes. */
export const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === "1";
const BASE = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");
export const DEMO_DIR = "demo";
/** Synthetic demo project and its simulated "after re-scan" twin. */
export const SYNTH_ID = "demo-synthetic";
export const SYNTH_AFTER_ID = "demo-synthetic-after";
/** Static demo: the "after" bundle is baked under demo/after/. */
const sdir = (id: string) => (id === SYNTH_AFTER_ID ? `${DEMO_DIR}/after` : DEMO_DIR);

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.detail) msg = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* not json */
    }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const api = (path: string, init?: RequestInit) => fetch(`${BASE}/api${path}`, init).then((r) => j<any>(r));
const send = (method: string, path: string, body: unknown) =>
  api(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const client = {
  health: (): Promise<Health> => (STATIC_DEMO ? fetch(`${DEMO_DIR}/health.json`).then((r) => j<Health>(r)) : api("/health")),
  projects: () => api("/projects"),
  createProject: (name: string) => send("POST", "/projects", { name }),
  deleteProject: (id: string) => api(`/projects/${id}`, { method: "DELETE" }),
  project: (id: string): Promise<Bundle> =>
    STATIC_DEMO ? fetch(`${sdir(id)}/project.json`).then((r) => j<Bundle>(r)) : api(`/projects/${id}`),
  analyze: (id: string): Promise<Bundle> => send("POST", `/projects/${id}/analyze`, {}),
  putSpec: (id: string, spec: Spec): Promise<Bundle> => send("PUT", `/projects/${id}/spec`, spec),
  putSettings: (id: string, s: Settings): Promise<Bundle> => send("PUT", `/projects/${id}/settings`, s),
  putZones: (id: string, zones: Zone[]): Promise<Bundle> => send("PUT", `/projects/${id}/zones`, zones),
  putSignoff: (id: string, s: { reviewer: string; date: string }) => send("PUT", `/projects/${id}/signoff`, s),
  putRequirements: (id: string, r: Requirement[]): Promise<Bundle> => send("PUT", `/projects/${id}/requirements`, r),
  applyRequirements: (id: string): Promise<Bundle> => send("POST", `/projects/${id}/requirements/apply`, {}),
  putDeliverables: (id: string, body: unknown): Promise<Bundle> => send("PUT", `/projects/${id}/deliverables`, body),
  manifestFolder: (id: string, path: string): Promise<Bundle> => send("POST", `/projects/${id}/manifest/folder`, { path }),
  removeInput: (id: string, kind: string): Promise<Bundle> => api(`/projects/${id}/inputs/${kind}`, { method: "DELETE" }),
  upload: (id: string, kind: string, file: File): Promise<Bundle> => {
    const fd = new FormData();
    fd.append("file", file);
    return api(`/projects/${id}/inputs/${kind}`, { method: "POST", body: fd });
  },
  cloudFromPath: (id: string, path: string): Promise<Bundle> => {
    const fd = new FormData();
    fd.append("path", path);
    return api(`/projects/${id}/cloud`, { method: "POST", body: fd });
  },
  cloudUpload: (id: string, file: File): Promise<Bundle> => {
    const fd = new FormData();
    fd.append("file", file);
    return api(`/projects/${id}/cloud`, { method: "POST", body: fd });
  },
  grid: async (id: string, floor: number): Promise<GridPayload> => {
    if (STATIC_DEMO) {
      const all = await fetch(`${sdir(id)}/grids.json`).then((r) => j<GridPayload[]>(r));
      return all[floor];
    }
    return api(`/projects/${id}/grid/${floor}`);
  },
  points: async (id: string): Promise<Float32Array> => {
    if (STATIC_DEMO) {
      const { b64 } = await fetch(`${sdir(id)}/points.json`).then((r) => j<{ b64: string }>(r));
      return decodeDensity(b64);
    }
    const buf = await fetch(`${BASE}/api/projects/${id}/points.bin?n=150000`).then((r) => r.arrayBuffer());
    return new Float32Array(buf);
  },
  buildDemo: (which: "synthetic" | "edinburgh") => send("POST", `/demo/${which}`, {}),
  reportUrl: (id: string, kind: "pdf" | "csv") =>
    STATIC_DEMO ? `${sdir(id)}/report.${kind}` : `${BASE}/api/projects/${id}/report.${kind}`,
};

/** base64 → Float32Array (density grids, point samples) */
export function decodeDensity(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export const fmt = {
  int: (n: number | null | undefined) => (n == null ? "—" : Math.round(n).toLocaleString("en-US")),
  m: (n: number | null | undefined, d = 2) => (n == null ? "—" : `${n.toFixed(d)} m`),
  mm: (n: number | null | undefined, d = 1) => (n == null ? "—" : `${n.toFixed(d)} mm`),
  pct: (n: number | null | undefined, d = 1) => (n == null ? "—" : `${n.toFixed(d)}%`),
  bytes: (n: number | null | undefined) => {
    if (n == null) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  },
};
