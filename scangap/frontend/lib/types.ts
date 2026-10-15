export type Severity = "high" | "review" | "info" | "pass";

export interface Finding {
  module: string;
  severity: Severity;
  title: string;
  detail: string;
  ref?: string | null;
}

export interface Zone {
  id: string;
  name: string;
  polygon: [number, number][];
  floor: number;
  loa?: string | null;
  min_density?: number | null;
  in_scope: boolean;
}

export interface Spec {
  project_name: string;
  client: string;
  site: string;
  intended_use: string | null;
  default_loa: string | null;
  lod: string | null;
  validation_method: string | null;
  coordinate_system: string | null;
  units: string | null;
  notes: string;
}

export interface Settings {
  cell_size: number;
  slice_min: number;
  slice_max: number;
  default_min_density: number;
  min_zone_coverage_pct: number;
  wall_band: number;
  min_gap_length: number;
  plan_tolerance: number;
  registration_tolerance_mm: number;
  long_chain_links: number;
  floor_override: number[] | null;
}

export interface Requirement {
  id: string;
  category: string;
  text: string;
  value: string | null;
  zone: string | null;
  source_quote: string;
  quote_verified: boolean;
  status: "proposed" | "accepted" | "rejected";
}

export interface Project {
  id: string;
  name: string;
  created: string;
  spec: Spec;
  settings: Settings;
  zones: Zone[];
  requirements: Requirement[];
  scope: { file: string; extractor: string; note: string; not_addressed: string[]; chars: number } | null;
  deliverables: { name: string; format: string | null; pattern: string | null; source: string }[];
  naming_regex: string | null;
  signoff: { reviewer: string; date: string };
  inputs: Record<string, string>;
  credit: string;
  readonly: boolean;
}

export interface Gap {
  length_m: number;
  path: [number, number][];
  mean_density: number;
  kind: string;
}

export interface ZoneResult {
  zone: string;
  name: string;
  floor: number;
  coverage_pct: number;
  perimeter_m: number;
  evaluated_m: number;
  covered_m: number;
  min_density: number;
  median_wall_density: number;
  slice_points: number;
  setups_inside: string[];
  gaps: Gap[];
  openings: { length_m: number; at: [number, number] }[];
  samples: [number, number, string, number][];
  loa: string | null;
  loa_range: string | null;
  in_scope: boolean;
  severity: Severity;
}

export interface PlanRow {
  label: string;
  x: number;
  y: number;
  zones: string[];
  zone_names: string[];
  status: "matched" | "missing";
  actual: string | null;
  offset_m: number | null;
  label_agrees?: boolean;
  nearest?: { label: string; distance_m: number } | null;
}

export interface Results {
  analyzed_at: string;
  credit: string;
  verdict: { level: Severity; headline: string; counts: Record<Severity, number> };
  findings: Finding[];
  spec_loa: { zone: string; name: string; loa: string | null; range: string | null }[];
  loa_label: string | null;
  loa_table: { code: string; lower_mm: number | null; upper_mm: number | null; label: string }[];
  cloud?: {
    file: string;
    path: string;
    format: string;
    reader: string;
    points: number;
    scans: number;
    scans_with_pose: number;
    floors: number[];
    floors_detected: number[];
    floor_source: string;
    bounds: [number[], number[]];
    read: Record<string, string>;
    absent: string[];
    notes: string[];
    coordinate_metadata: string | null;
    units: string | null;
    slice: string;
    cell: number;
    file_size: number;
    setup_source: string;
    scan_list: { name: string; points: number; position: number[] | null }[];
  };
  zones?: ZoneResult[];
  grids?: { floor: number; z: number; origin: [number, number]; cell: number; shape: [number, number] }[];
  setups: { label: string; x: number; y: number }[];
  plan?: { rows: PlanRow[]; unplanned: { label: string; x: number; y: number }[]; tolerance_m: number; matched: number; missing: string[] };
  registration?: {
    links: { id: string; a: string; b: string; error_mm: number; overlap_pct: number | null; type: string }[];
    targets: { id: string; error_mm: number; type: string }[];
    chains: { scans: string[]; links: number; unconstrained: boolean; rss_mm: number; sum_mm: number; link_ids: string[] }[];
    tolerance_mm: number;
    loa: { code: string; label: string; lower_mm: number; upper_mm: number | null } | null;
    stats: { n: number; max_mm: number | null; mean_mm: number | null };
    findings: Finding[];
  };
  validation?: { n: number; rmse_r_mm: number; rmse_z_mm: number; h95_mm: number; v95_mm: number; p95_3d_mm: number; loa_estimate: string; points: { id: string; dx_mm: number; dy_mm: number; dz_mm: number }[]; findings: Finding[] };
  manifest?: {
    files: { name: string; ext: string; size: number | null; status: "listed" | "inspected"; detail: string; naming_ok: boolean | null; declares_crs: boolean | null; matches: string[]; valid?: boolean | null }[];
    deliverables: { deliverable: string; format: string | null; files: string[]; status: string }[];
    naming_regex: string | null;
  };
}

export interface Bundle {
  project: Project;
  results: Results;
}

export interface GridPayload {
  floor: number;
  z: number;
  origin: [number, number];
  cell: number;
  nx: number;
  ny: number;
  slice: [number, number];
  density_b64: string;
  p99: number;
}

export interface Health {
  ok: boolean;
  version?: string;
  llm_available: boolean;
  model?: string | null;
  readonly: boolean;
  loa: { code: string; label: string; lower_mm: number | null; upper_mm: number | null }[];
}
