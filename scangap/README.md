# ScanGap

**Coverage and scope QA for reality-capture crews, run before you demobilize or deliver.**

Field registration tools (Cyclone FIELD 360, FARO Stream) answer *"did the scans stitch?"*
ScanGap answers *"did we capture what the client asked for, at the accuracy they asked for?"*

- Vendor-neutral: reads E57, LAS and LAZ exports from any scanner.
- Local: one Python process on the laptop serves the API and the UI. Point clouds are read in
  place, and nothing is uploaded anywhere. The only network calls are (a) optional scope
  extraction through the Anthropic API, and (b) the one-time download of the public demo file.
- Every check is deterministic code. The LLM is used only to turn a scope document into a list
  of requirements with verbatim quotes, which a person reviews before anything uses them.
- QA aid, not certification. Gaps are always worded "possible gap — review", and the tool never
  states LOA compliance.

Hosted read-only demo (synthetic project): https://claude.ai/artifact/XbMuZUpbRqGXdmkfUGZkU4
(private to its owner until shared from the page's Share menu).

---

## Architecture

```
scangap/
├── backend/                     Python 3.10+, FastAPI
│   └── scangap/
│       ├── readers/             E57 (pye57/libE57), LAS/LAZ (laspy + lazrs), PDAL fallback
│       │                        → header "read vs absent" + chunked point iterator
│       ├── cloud.py             pass 1: bounds, Z histogram, per-scan counts, viewer sample
│       │                        floor detection; pass 2: per-floor slice density grids
│       ├── coverage.py          per-zone perimeter coverage, openings, candidate gaps
│       ├── plan.py              planned setups ↔ actual poses (optimal 1:1 assignment)
│       ├── registration.py      link/target tolerance, open-chain detection, check-point residuals @95%
│       ├── scope.py             scope PDF/TXT → requirements (Claude or offline rules) + quote verification
│       ├── manifest.py          deliverables, formats, naming, duplicates, CRS; "listed" vs "inspected"
│       ├── spec.py, loa.py      project spec checks, USIBD LOA10–50 bands
│       ├── report.py            one-page PDF + CSV
│       ├── project.py           local project store and analysis pipeline (grids cached)
│       ├── synthetic.py         ray-cast office simulator (occlusion, range/incidence falloff)
│       ├── demo.py              builds the two demo projects
│       ├── api.py               REST API; serves the built UI from frontend/out
│       └── cli.py               scangap serve | demo | analyze | export-static
├── frontend/                    Next.js 15 (static export), TypeScript, Tailwind, three.js
├── demo/                        demo inputs (plan, registration, scope, zones, manifest, check points)
└── scripts/build_hosted_demo.sh read-only static build of the synthetic project
```

Data flow: the point cloud is streamed twice in 2M-point chunks. Only histograms, density grids
and a 400k-point viewer sample are kept, so file size is bounded by disk, not RAM. The grids are
cached per project. Editing zones, the spec, the plan, the registration report or the scope
re-runs every check in well under a second, without touching the point cloud again.

## Setup

Requirements: Python 3.10+, Node 20+.

```bash
cd scangap/backend
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

cd ../frontend
npm ci
npm run build            # static UI → frontend/out (served by the Python process)

cd ../backend
scangap serve            # http://127.0.0.1:8000
```

For UI development, run `NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 npm run dev` in `frontend/`
(port 3000) next to `scangap serve`.

### If `pye57` will not install

`pye57` ships prebuilt wheels for common platforms only (it installed from wheels on Linux
x86_64 / Python 3.13 during development, so no fallback was needed there). If pip tries to
compile it and fails, use PDAL from conda-forge instead:

```bash
conda create -n scangap -c conda-forge python=3.12 pdal python-pdal
conda activate scangap
pip install -e ".[dev]" --no-deps
pip install numpy scipy matplotlib pydantic fastapi uvicorn python-multipart reportlab pypdf laspy lazrs "anthropic>=1,<2" pytest httpx
```

When `import pye57` fails, `readers/open_cloud` falls back to `readers/pdal_reader.py`
automatically. PDAL merges scans, so per-scan poses are reported as absent; import a poses CSV
for plan checks. The PDAL path is coded but was not exercised in this environment.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Enables LLM scope extraction (server-side only, never sent to the browser). Without it, offline keyword rules are used. |
| `SCANGAP_MODEL` | `claude-opus-5-5` | Model for scope extraction. |
| `SCANGAP_OFFLINE` | unset | `1` forces offline extraction even with a key (no network). |
| `SCANGAP_DATA` | `~/.scangap` | Project store (specs, uploaded CSV/PDF, cached grids, results). |
| `SCANGAP_READONLY` | unset | `1` rejects every non-GET API call (shared or demo servers). |
| `SCANGAP_UI_DIR` | `frontend/out` | Where the built UI is served from. |
| `NEXT_PUBLIC_API_URL` | same origin | API base for `next dev`. |
| `NEXT_PUBLIC_STATIC_DEMO` | unset | `1` builds the read-only UI that reads baked JSON. |

## Demo walkthrough

```bash
scangap demo synthetic          # simulates ~3M points (≈20 s)
scangap demo edinburgh          # downloads the 49 MB real E57 once (DOI 10.7488/ds/2893)
scangap serve
```

Or press the two demo buttons on the Projects page.

### 1. Synthetic office (known answers)

Harbor Street Office, Level 1: a 30 × 14 m floor with six rooms and a corridor, ray-cast from
the setups that were "actually" scanned. The simulation includes occlusion and range/incidence
falloff.

| What was built in | What ScanGap reports |
|---|---|
| Mech 104 never scanned, door closed | HIGH · Possible gap — review: Mech 104 has no returns (0%) |
| East corridor seen only at grazing angles from S11 | HIGH · Possible gap — review: Corridor East coverage 30% |
| Planned S7 and S9 not set up | HIGH · Planned setup S7/S9 not found, with the zones they were meant to cover |
| S10–S11 link 7.4 mm in a 3-link open corridor chain | REVIEW link over 6 mm, plus HIGH long single chain S6–S8–S10–S11 |
| Scope with no validation method | REVIEW · Validation method not defined; scope does not address validation |
| Package: no scan location plan, a case-duplicate PDF, a badly named RVT | HIGH missing deliverable; REVIEW duplicate and naming |
| Column in Open Office 106 shadows the south wall | INFO possible gap — the zone still passes at 94% |

Walk through it in the UI:

1. **Verdict** (top): "Not ready to demobilize — 6 high-severity items". Click any item to jump
   to its tab.
2. **Heatmap**: the 0.5–2.0 m slice density shows walls as dark lines. Zone outlines are coloured
   by status, red strokes mark possible gaps, ✕ marks a missing planned setup, and dots are actual
   setups. Toggle "≥ 200 pts/m²" to see what passes the threshold, and hover for density.
   Draw a zone with Rectangle or Polygon, then "Save zones & recompute".
3. **Zones**: per-zone LOA (with its mm range), minimum density, coverage %, setups inside.
4. **Spec**: intended use, LOA, LOD, validation method, coordinate system and units. A missing
   use, LOA or validation method is flagged REVIEW.
5. **Scope**: each extracted requirement shows its verbatim quote and a "found in document"
   mark. Accept or reject, then "Apply accepted to spec & deliverables".
6. **Plan**, **Registration**, **Delivery**: tables behind the findings.
   `demo/synthetic/checkpoints_example.csv` shows the check-point format for the validation step.
7. **3D**: downsampled cloud, coloured by height.
8. **Report**: add reviewer and date, then download the one-page PDF and the CSV.

### 2. Real file: Edinburgh "Synthetic building"

Valero, Enrique (2021). *Synthetic building* [dataset]. Cyberbuild Lab, The University of
Edinburgh. https://doi.org/10.7488/ds/2893 — CC BY 4.0. Used unmodified; credited in the UI and
in reports.

What ScanGap reads: one scan of 3,427,151 points with RGB, written by CloudCompare 2.10.2. It
has no pose, no sensor data and no coordinate metadata, and the UI lists all of these as absent.
It is a merged cloud, so plan checks need a poses CSV. The floor is detected at 0.01 m.
The three spaces (zones in `demo/edinburgh/zones.json`, drawn on the interior wall faces) cover
93–97% with their openings excluded. The verdict is "Review 4 items", because the spec is empty
(no use, LOA, validation method or coordinate system). That is the point: accuracy has to be
defined up front.

## How coverage is measured

1. **Floors**: Z histogram at 2 cm. A peak is a floor when returns sit just above it (wall
   bases) and not just below it (slab, or nothing), measured beyond the surface's own thickness.
   Ceilings are the reverse, and table tops have returns on both sides. Floors less than 2 m
   apart are merged. Floor elevations can be set manually in settings.
2. **Slice grid**: points 0.5–2.0 m above each floor are binned into cells (0.25 m by default).
   Density is points / (cell × slice height), which approximates pts/m² on vertical surfaces.
3. **Zone coverage**: inside a wall-height slice, open floor legitimately has no returns. What a
   scan must capture there is the zone's walls and whatever stands against them. So the zone
   boundary is cut into cell-length strips reaching `wall_band` (0.75 m) inward. A strip is
   covered when its density meets the zone minimum, and coverage % is covered perimeter length
   over evaluated length.
4. **Openings**: short runs (≤ 1.5 m) of near-zero returns between covered strips, such as doors
   and glazing. They are excluded from the percentage and listed as INFO.
5. **Candidate gaps**: every other run of under-density perimeter ≥ 1 m, labelled
   "possible gap — review". Zones below 50% are HIGH and zones below the target (90%) are
   REVIEW. Gaps inside passing zones are INFO.

## Input formats

| Input | Format |
|---|---|
| Point cloud | `.e57` (multi-scan with poses), `.las`, `.laz`, read from a local path or uploaded |
| Zones | JSON list of `{id, name, polygon: [[x,y],…], floor, loa, min_density, in_scope}` |
| Scan plan / poses | CSV `label,x,y[,z][,zone]`; headers such as `Name;Easting;Northing` are recognized |
| Registration | CSV `from,to,error_mm[,overlap_pct,type]`; target rows `id,,error_mm,,target`. Metre columns are converted. |
| Check points | CSV `id,survey_x,survey_y,survey_z,scan_x,scan_y,scan_z` (metres) |
| Scope | PDF or TXT |
| Delivery | manifest JSON `[{name,size,path?}]`, CSV, or a plain list (*listed*); or a folder path whose files are opened (*inspected*) |

## Tests

```bash
cd scangap/backend && python -m pytest -q
```

35 tests. The known-answer suite builds the synthetic project and asserts that:

- Mech 104 is flagged
- Corridor East is flagged as thin
- S7 and S9 are the missing setups
- the over-tolerance link sits in the long chain
- the missing validation method is flagged REVIEW
- the manifest findings appear
- the one-page PDF is produced

Unit tests cover:

- LOA bands
- floor detection with tables and two storeys
- coverage on hand-made grids (missing wall, door, weak wall, clockwise polygons)
- plan matching and registration chains, including loop closure
- NSSDA residuals and LLM quote verification with a mocked model
- the offline fallback when the network fails
- LAS/LAZ/E57 round trips with poses
- manifest inspection and the API, including read-only mode

CI: `.github/workflows/scangap-ci.yml`.

## Limitations

- **2D, per-floor**: coverage is judged from a horizontal wall-height slice. Ceilings, floors,
  MEP above the slice and anything below 0.5 m are not assessed. Ramps and split levels need
  manual floor elevations.
- **Zone drawing matters**: draw zones on the interior wall faces. A boundary drawn on a wall
  centreline can pick up the other side of a shared wall and overstate coverage of an unscanned
  room.
- **Openings vs. shadows**: a short occlusion shadow with near-zero returns looks like a doorway
  and is excluded (but listed). Large glazed walls read as gaps.
- **Density is a proxy**: pts/m² on vertical surfaces says nothing about noise, range accuracy
  or registration. It is not an LOA measure.
- **No compliance statements**: registration errors are internal consistency. Check-point
  residuals are compared to the LOA band only when you supply survey data, and fewer than 20
  points triggers a warning.
- **Poses**: LAS/LAZ and merged E57s carry no scanner positions; import a poses CSV.
  E57 `cartesianBounds` are reported as stored, because writers disagree on the frame.
- **Units**: E57 is metres by definition. LAS units are read from a WKT VLR when present,
  otherwise assumed to be metres and listed as absent.
- **Scope extraction**: the offline rules are keyword-based and miss requirements phrased
  unusually. The LLM path is better but still needs review. Unverifiable quotes are always
  discarded.
- **Synthetic scanner** is coarse (0.4° steps), so the demo uses 200 pts/m² rather than a
  real-world threshold. Set real minimums per zone.

## Deploy

- **Field laptop (intended)**: `scangap serve` binds to 127.0.0.1 and nothing leaves the
  machine. Package with the venv, or `pipx install ./backend`, and ship `frontend/out` alongside.
- **Shared office server, read-only**:
  `SCANGAP_READONLY=1 scangap serve --host 0.0.0.0` behind your reverse proxy and auth.
  ScanGap has no user accounts.
- **Static read-only demo**: `scripts/build_hosted_demo.sh` bakes the synthetic project into
  JSON and writes `hosted-demo/`, which needs no backend:
  - `standalone.html` + `app/` + `demo/` for any static host (rename it to `index.html`)
  - `index.html`, a fragment, for hosts that supply their own document skeleton
