"""Synthetic 6-room office floor, ray-cast from planned setups.

Layout (metres, x east, y north), 30 × 14 m, walls 0.15 m thick, 3.0 m ceiling:

    y=14 +-----------+-----------+-----------+
         | Office 101| Office 102| Conf 103  |
    y=8  +--d--------+--d--------+---d-------+
         | Corridor West (S6 S8 S10 S11)  | Corridor East (S9 — missed)
    y=6  +--d--------+--d--------+---X-------+   X = Mech 104 door, closed
         | Office 105| Open 106  | Mech 104  |   (S7 — missed)
    y=0  +-----------+-----------+-----------+
         x=0        x=10        x=20        x=30

Known answers the tests assert:
  * Mech 104 was never scanned (no setup, door closed) → flagged.
  * Corridor East is only seen at grazing angles from S11 → thin → flagged.
  * Planned S7 and S9 are missing from the actual setups.
  * Registration link S10–S11 sits in a 3-link single chain and exceeds tolerance.
  * The scope document has no validation method → REVIEW.

The scanner model is deliberately coarse (0.4° steps) to keep files small; the
demo project's minimum density is scaled to match (see DEMO_MIN_DENSITY).
"""
from __future__ import annotations

import csv
import json
from pathlib import Path

import numpy as np

WALL_T = 0.15
H = 3.0
DOOR_W = 0.9
DOOR_H = 2.1
SCANNER_H = 1.5
DEMO_MIN_DENSITY = 200.0  # pts/m² — matches the coarse simulated scanner

ROOMS = {
    "Z101": ("Office 101", (0, 8, 10, 14)),
    "Z102": ("Office 102", (10, 8, 20, 14)),
    "Z103": ("Conference 103", (20, 8, 30, 14)),
    "Z104": ("Mech 104", (20, 0, 30, 6)),
    "Z105": ("Office 105", (0, 0, 10, 6)),
    "Z106": ("Open Office 106", (10, 0, 20, 6)),
}
CORRIDORS = {
    "ZCW": ("Corridor West", (0, 6, 20, 8)),
    "ZCE": ("Corridor East", (20, 6, 30, 8)),
}

PLANNED = [  # label, x, y, intended zone
    ("S1", 5.0, 11.0, "Z101"), ("S2", 15.0, 11.0, "Z102"), ("S3", 25.0, 11.0, "Z103"),
    ("S4", 5.0, 3.0, "Z105"), ("S5", 15.0, 3.0, "Z106"), ("S6", 2.5, 7.0, "ZCW"),
    ("S7", 25.0, 3.0, "Z104"), ("S8", 7.5, 7.0, "ZCW"), ("S9", 25.0, 7.0, "ZCE"),
    ("S10", 12.5, 7.0, "ZCW"), ("S11", 17.5, 7.0, "ZCW"),
]
MISSED = {"S7", "S9"}
# small field offsets between plan and actual
ACTUAL_OFFSETS = {"S1": (0.2, -0.1), "S2": (-0.3, 0.2), "S3": (0.1, 0.3), "S4": (0.25, 0.1),
                  "S5": (-0.2, -0.3), "S6": (0.1, 0.05), "S8": (-0.15, 0.1), "S10": (0.3, -0.05),
                  "S11": (-0.1, 0.1)}


def _box(x0, y0, x1, y1, z0=0.0, z1=H):
    return (min(x0, x1), min(y0, y1), z0, max(x0, x1), max(y0, y1), z1)


def _wall_x(y, xa, xb, doors=(), closed=()):
    """Horizontal wall along y from xa to xb with door openings starting at the given x."""
    t = WALL_T / 2
    boxes, cur = [], xa
    for d in sorted(doors):
        boxes.append(_box(cur, y - t, d, y + t))
        boxes.append(_box(d, y - t, d + DOOR_W, y + t, DOOR_H, H))  # lintel
        cur = d + DOOR_W
    boxes.append(_box(cur, y - t, xb, y + t))
    for d in closed:  # closed door leaf, slightly recessed, full height to the head
        boxes.append(_box(d, y - 0.02, d + DOOR_W, y + 0.02, 0, DOOR_H))
    return boxes


def _wall_y(x, ya, yb):
    t = WALL_T / 2
    return [_box(x - t, ya, x + t, yb)]


def build_geometry() -> np.ndarray:
    b = []
    b += _wall_x(0, -0.075, 30.075)
    b += _wall_x(14, -0.075, 30.075)
    b += _wall_y(0, 0, 14)
    b += _wall_y(30, 0, 14)
    b += _wall_x(8, 0, 30, doors=(4.0, 14.0, 23.0))
    b += _wall_x(6, 0, 30, doors=(4.0, 14.0), closed=())
    # Mech 104's door at x=24 on y=6 is closed: the wall section is solid apart from a recessed leaf
    b += _wall_y(10, 0, 6) + _wall_y(20, 0, 6) + _wall_y(10, 8, 14) + _wall_y(20, 8, 14)
    # furniture: desks (low), tall cabinets against walls, a free-standing column in 106
    for x in (2, 6):
        b.append(_box(x, 10.5, x + 1.6, 11.3, 0, 0.75))
    b.append(_box(12, 13.3, 14, 13.85, 0, 1.9))  # cabinet against N wall of 102
    b.append(_box(22, 10, 28, 11.2, 0, 0.75))  # conference table
    b.append(_box(12, 1.5, 13.6, 2.3, 0, 0.75))
    b.append(_box(16.5, 1.0, 17.0, 1.5, 0, H))  # column in Open Office 106
    b.append(_box(1, 0.25, 3, 0.75, 0, 1.9))  # shelving in 105
    b.append(_box(24, 2, 27, 4, 0, 2.2))  # AHU in Mech 104 (never seen)
    return np.array(b, dtype=float)


def _cast(origin: np.ndarray, dirs: np.ndarray, boxes: np.ndarray):
    """Nearest hit of each ray against boxes, floor (z=0) and ceiling (z=H)."""
    n = len(dirs)
    best_t = np.full(n, np.inf)
    best_ax = np.full(n, 2, dtype=np.int8)
    with np.errstate(divide="ignore", invalid="ignore"):
        inv = 1.0 / dirs
        # floor / ceiling
        tf = np.where(dirs[:, 2] < 0, (0.0 - origin[2]) * inv[:, 2], np.inf)
        tc = np.where(dirs[:, 2] > 0, (H - origin[2]) * inv[:, 2], np.inf)
        best_t = np.minimum(tf, tc)
        for bx in boxes:
            t1 = (bx[:3] - origin) * inv
            t2 = (bx[3:] - origin) * inv
            tmn = np.minimum(t1, t2)
            tmx = np.maximum(t1, t2)
            tmn = np.nan_to_num(tmn, nan=-np.inf)
            tmx = np.nan_to_num(tmx, nan=np.inf)
            tnear = tmn.max(1)
            tfar = tmx.min(1)
            hit = (tfar >= np.maximum(tnear, 0)) & (tnear > 1e-6) & (tnear < best_t)
            best_t = np.where(hit, tnear, best_t)
            best_ax = np.where(hit, tmn.argmax(1).astype(np.int8), best_ax)
    return best_t, best_ax


def simulate_scan(origin, boxes, step_deg=0.4, rng=None, max_range=40.0, noise_m=0.003):
    rng = rng or np.random.default_rng(0)
    az = np.deg2rad(np.arange(0, 360, step_deg))
    el = np.deg2rad(np.arange(-60, 90, step_deg))
    A, E = np.meshgrid(az, el)
    A, E = A.ravel(), E.ravel()
    dirs = np.column_stack([np.cos(E) * np.cos(A), np.cos(E) * np.sin(A), np.sin(E)])
    origin = np.asarray(origin, float)
    out_t, out_ax = np.empty(len(dirs)), np.empty(len(dirs), np.int8)
    for i in range(0, len(dirs), 60000):
        out_t[i:i + 60000], out_ax[i:i + 60000] = _cast(origin, dirs[i:i + 60000], boxes)
    ok = np.isfinite(out_t) & (out_t < max_range)
    # falloff: return probability drops with range and with grazing incidence
    cos_inc = np.abs(dirs[np.arange(len(dirs)), out_ax])
    p = np.clip(1 - (out_t / max_range) ** 4, 0, 1) * np.clip((cos_inc - 0.05) / 0.25, 0, 1)
    keep = ok & (rng.random(len(dirs)) < p)
    r = out_t[keep] + rng.normal(0, noise_m, keep.sum())
    local = dirs[keep] * r[:, None]  # scanner-local frame (no rotation; translation = origin)
    intensity = np.clip(cos_inc[keep] * (1 - out_t[keep] / max_range), 0, 1)
    return local, intensity


def actual_setups() -> list[tuple[str, float, float]]:
    out = []
    for lab, x, y, _ in PLANNED:
        if lab in MISSED:
            continue
        dx, dy = ACTUAL_OFFSETS.get(lab, (0, 0))
        out.append((lab, x + dx, y + dy))
    return out


def zones_json() -> list[dict]:
    t = WALL_T / 2
    zs = []
    for zid, (name, (x0, y0, x1, y1)) in {**ROOMS, **CORRIDORS}.items():
        # interior faces; corridor zones share an open boundary at x=20
        ax0 = x0 + t
        ax1 = x1 - t
        if zid == "ZCW":
            ax1 = 20.0
        if zid == "ZCE":
            ax0 = 20.0
        poly = [[ax0, y0 + t], [ax1, y0 + t], [ax1, y1 - t], [ax0, y1 - t]]
        zs.append({"id": zid, "name": name, "polygon": poly, "floor": 0,
                   "loa": "LOA20" if zid == "Z104" else "LOA30", "min_density": DEMO_MIN_DENSITY,
                   "in_scope": True})
    return zs


SCOPE_TEXT = """\
SCOPE OF WORK — REALITY CAPTURE
Project: Harbor Street Office Renovation, Level 1
Client: Northwind Properties LLC
Date: 2026-09-02

1. Purpose
The point cloud and model will be used for renovation design of the Level 1 office suite, including
architectural layout and MEP coordination in the mechanical room.

2. Area
Laser scan all of Level 1: Offices 101, 102 and 105, Conference 103, Open Office 106, Mechanical Room 104,
and the full length of the central corridor (east and west).

3. Accuracy
Registered point cloud shall meet USIBD LOA30 (5–15 mm at 95% confidence) for all occupied rooms and the
corridor. Mechanical Room 104 may be delivered at LOA20.

4. Model
Provide a Revit model of architecture and major MEP at LOD 300.

5. Coordinate system and units
Deliver in the client's local site grid (Harbor St Site Grid, origin at control point CP-1), units in metres.

6. Deliverables
a) Registered point cloud in E57 format, one file per level.
b) Registered point cloud in RCP/RCS format.
c) Revit model (RVT), LOD 300.
d) Registration report (PDF).
e) Scan location plan (PDF).
File names shall follow the convention HSO_L1_<description>.<ext>.

7. Schedule
Field work to be completed by 2026-10-10. Deliverables due 15 working days after demobilization.
"""


def write_demo_inputs(out: Path) -> dict:
    """Write everything except the point cloud: plan, poses, registration, scope, zones, manifest."""
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "scan_plan.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["label", "x", "y", "zone"])
        for lab, x, y, z in PLANNED:
            w.writerow([lab, x, y, z])
    reg = [
        # from, to, error_mm, overlap_pct, type
        ("S4", "S6", 1.9, 41, "cloud-to-cloud"),
        ("S1", "S6", 2.4, 38, "cloud-to-cloud"),
        ("S6", "S8", 2.2, 62, "cloud-to-cloud"),
        ("S8", "S10", 3.1, 58, "cloud-to-cloud"),
        ("S10", "S11", 7.4, 33, "cloud-to-cloud"),  # over tolerance, inside the corridor chain
        ("S11", "S5", 2.6, 35, "cloud-to-cloud"),
        ("S11", "S2", 2.9, 31, "cloud-to-cloud"),
        ("S2", "S3", 3.3, 27, "cloud-to-cloud"),
    ]
    with open(out / "registration.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["from", "to", "error_mm", "overlap_pct", "type"])
        w.writerows(reg)
        w.writerow(["T1", "", 2.1, "", "target"])
        w.writerow(["T2", "", 3.8, "", "target"])
    (out / "scope.txt").write_text(SCOPE_TEXT)
    (out / "zones.json").write_text(json.dumps(zones_json(), indent=2))
    manifest = [
        {"name": "HSO_L1_Registered.e57", "size": 72_000_000},
        {"name": "HSO_L1_Registered.rcp", "size": 1_200},
        {"name": "HSO_L1_Registration_Report.pdf", "size": 480_000},
        {"name": "hso_l1_registration_report.PDF", "size": 480_000},
        {"name": "Level1 model v3.rvt", "size": 38_000_000},
    ]
    (out / "delivery_manifest.json").write_text(json.dumps(manifest, indent=2))
    return {"planned": len(PLANNED), "missed": sorted(MISSED)}


def generate(out: Path, step_deg: float = 0.4, seed: int = 7, fmt: str = "e57") -> Path:
    """Simulate all actual setups and write the point cloud (E57 with poses, or LAZ)."""
    out.mkdir(parents=True, exist_ok=True)
    boxes = build_geometry()
    rng = np.random.default_rng(seed)
    scans = []
    for lab, x, y in actual_setups():
        local, inten = simulate_scan((x, y, SCANNER_H), boxes, step_deg=step_deg, rng=rng)
        scans.append({"name": lab, "xyz": local, "intensity": inten, "translation": [x, y, SCANNER_H]})
    if fmt == "e57":
        from .readers.e57 import write_e57
        path = out / "synthetic_office_L1.e57"
        write_e57(path, scans, coordinate_metadata="LOCAL: Harbor St Site Grid (CP-1 origin), metres",
                  sensor={"sensorVendor": "ScanGap Sim", "sensorModel": "Synthetic TLS 0.4deg",
                          "sensorSerialNumber": "SIM-0001"})
    else:
        from .readers.las import write_las
        path = out / "synthetic_office_L1.laz"
        write_las(path, np.vstack([s["xyz"] + np.asarray(s["translation"]) for s in scans]))
    return path
