import json

import numpy as np
import pytest

from scangap import cloud, coverage, loa, manifest, plan, registration, scope
from scangap.cloud import Z_BIN, Grid
from scangap.models import Deliverable, ProjectSpec, Requirement, Settings, Zone
from scangap.spec import check_spec


# ---------------------------------------------------------------- LOA & spec

def test_loa_bands():
    assert loa.band("LOA30").label == "LOA30: 5–15 mm @95%"
    assert loa.band("loa 20").upper_mm == 50
    assert loa.band("LOA10").upper_mm is None
    assert loa.loa_for_error(4.0) == "LOA40" and loa.loa_for_error(12) == "LOA30" and loa.loa_for_error(60) == "LOA10"


def test_spec_flags_missing_use_loa_validation():
    f = check_spec(ProjectSpec(), [Zone(id="a", name="A", polygon=[(0, 0), (1, 0), (1, 1)])])
    titles = {x.title for x in f if x.severity == "review"}
    assert {"Intended use not stated", "Required LOA not defined", "Validation method not defined"} <= titles
    ok = check_spec(ProjectSpec(intended_use="design", default_loa="LOA30", validation_method="TS checks",
                                coordinate_system="EPSG:2272", units="ft", lod="LOD 300"), [])
    assert [x.severity for x in ok] == ["pass"]


# ---------------------------------------------------------------- floors

def _hist(surfaces, walls):
    z = np.arange(-1, 12, Z_BIN)
    h = np.zeros(len(z), dtype=np.int64)
    for lo, hi in walls:
        h[(z >= lo) & (z < hi)] += 100
    for s, n in surfaces:
        h[int((s + 1) / Z_BIN)] += n
    return h, -1.0


def test_detect_two_storeys_ignores_tables_and_ceilings():
    # storey 1: floor 0, table 0.75, ceiling 2.9; slab; storey 2: floor 3.3, ceiling 6.2
    h, z0 = _hist([(0.0, 50000), (0.75, 20000), (2.9, 40000), (3.3, 50000), (6.2, 40000)],
                  walls=[(0.0, 2.9), (3.3, 6.2)])
    floors, peaks = cloud.detect_floors(h, z0)
    assert len(floors) == 2
    assert abs(floors[0] - 0.0) < 0.05 and abs(floors[1] - 3.3) < 0.05


# ---------------------------------------------------------------- coverage

def _room_grid(missing_wall=None, door=None, weak_wall=None):
    """10×6 m room, 0.25 m cells, walls one cell thick just inside the zone edge."""
    c = 0.25
    nx, ny = 48, 32  # origin -1,-1 → covers -1..11, -1..7
    counts = np.zeros((ny, nx), dtype=np.int64)
    ix = lambda x: int((x + 1) / c)  # noqa: E731
    dense = 2000
    walls = {"S": (slice(ix(0.0), ix(0.0) + 1), slice(ix(0), ix(10))),
             "N": (slice(ix(5.9), ix(5.9) + 1), slice(ix(0), ix(10))),
             "W": (slice(ix(0), ix(6)), slice(ix(0.0), ix(0.0) + 1)),
             "E": (slice(ix(0), ix(6)), slice(ix(9.9), ix(9.9) + 1))}
    for k, sl in walls.items():
        if k != missing_wall:
            counts[sl] = 30 if k == weak_wall else dense
    if door:
        counts[ix(0.0), ix(door):ix(door + 0.9)] = 0
    return Grid(origin=(-1.0, -1.0), cell=c, counts=counts, slice_min=0.5, slice_max=2.0, floor_z=0.0)


ROOM = Zone(id="r", name="Room", polygon=[(0, 0), (10, 0), (10, 6), (0, 6)])


def test_full_room_100pct():
    r = coverage.zone_coverage(_room_grid(), ROOM, 500, Settings())
    assert r["coverage_pct"] == 100 and r["gaps"] == []


def test_missing_wall_is_possible_gap():
    r = coverage.zone_coverage(_room_grid(missing_wall="N"), ROOM, 500, Settings())
    assert 60 < r["coverage_pct"] < 75
    assert r["gaps"][0]["kind"] == "no returns" and r["gaps"][0]["length_m"] >= 9.5
    f = coverage.coverage_findings([r], [ROOM], Settings())
    assert f[0].severity == "review" and f[0].title.startswith("Possible gap — review")


def test_door_opening_excluded_weak_wall_counted():
    r = coverage.zone_coverage(_room_grid(door=4.0), ROOM, 500, Settings())
    assert r["coverage_pct"] == 100 and len(r["openings"]) == 1
    r = coverage.zone_coverage(_room_grid(weak_wall="E"), ROOM, 500, Settings())
    assert r["gaps"][0]["kind"] == "below density" and r["coverage_pct"] < 85


def test_clockwise_polygon_same_result():
    cw = Zone(id="r", name="Room", polygon=list(reversed(ROOM.polygon)))
    a = coverage.zone_coverage(_room_grid(missing_wall="W"), ROOM, 500, Settings())["coverage_pct"]
    b = coverage.zone_coverage(_room_grid(missing_wall="W"), cw, 500, Settings())["coverage_pct"]
    assert a == b


def test_empty_zone_is_high():
    g = _room_grid()
    g.counts[:] = 0
    r = coverage.zone_coverage(g, ROOM, 500, Settings())
    f = coverage.coverage_findings([r], [ROOM], Settings())
    assert f[0].severity == "high" and "no returns" in f[0].title


# ---------------------------------------------------------------- plan

def test_plan_matching_tolerance_and_labels():
    planned = plan.parse_setups("Name;Easting;Northing;Room\nA;0;0;Room\nB;5;0;\nC;10;0;\n")
    actual = [{"label": "Scan 1", "x": 0.3, "y": 0.1}, {"label": "Scan 2", "x": 5.2, "y": -0.2},
              {"label": "Scan 3", "x": 14, "y": 0}]
    r = plan.match_plan(planned, actual, 1.0, [ROOM])
    assert r["missing"] == ["C"]
    assert [u["label"] for u in r["unplanned"]] == ["Scan 3"]
    assert r["rows"][0]["zones"] == ["r"]
    assert any(f.title.startswith("Planned setup C") for f in r["findings"])


# ---------------------------------------------------------------- registration

REG = "from,to,error_mm\nA,B,2\nB,C,3\nC,D,9\nD,E,2\nE,F,1\n"


def test_chain_detected_and_loop_closure_clears_it():
    r = registration.check_registration(registration.parse_registration(REG), 6, 3, "LOA30")
    assert any(f.severity == "high" and "Long single chain" in f.title for f in r["findings"])
    closed = REG + "F,A,2\n"
    r2 = registration.check_registration(registration.parse_registration(closed), 6, 3, "LOA30")
    assert not any("Long single chain" in f.title for f in r2["findings"])
    assert any("C–D" in f.title for f in r2["findings"])  # over tolerance still flagged


def test_registration_units_metres():
    reg = registration.parse_registration("scan_a,scan_b,error\nA,B,0.002\nB,C,0.004\n")
    assert reg["links"][0]["error_mm"] == 2.0 and "metres" in reg["unit_note"]


def test_checkpoints_95pct():
    rows = ["id,survey_x,survey_y,survey_z,scan_x,scan_y,scan_z"]
    rng = np.random.default_rng(1)
    for i in range(25):
        d = rng.normal(0, 0.003, 3)
        rows.append(f"CP{i},{i},0,0,{i + d[0]},{d[1]},{d[2]}")
    v = registration.validate_checkpoints(registration.parse_checkpoints("\n".join(rows)), "LOA30")
    assert v["n"] == 25 and 3 < v["h95_mm"] < 12
    assert v["findings"][-1].severity == "pass" and "not a certification" in v["findings"][-1].detail


# ---------------------------------------------------------------- scope

def test_invented_quote_is_rejected():
    text = "The survey shall meet LOA30. Deliver E57."
    reqs = [Requirement(id="R1", category="loa", text="LOA30", value="LOA30", source_quote="The survey shall meet LOA30."),
            Requirement(id="R2", category="validation", text="check points", source_quote="Validate with 20 total-station check points.")]
    out = scope.verify_quotes(reqs, text)
    assert out[0].quote_verified and out[0].status == "proposed"
    assert not out[1].quote_verified and out[1].status == "rejected"


def test_llm_path_is_verified_and_falls_back(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    monkeypatch.delenv("SCANGAP_OFFLINE", raising=False)
    text = "Point cloud shall meet USIBD LOA30 at 95% confidence."
    fake = [Requirement(id="R1", category="loa", text="LOA30", value="LOA30",
                        source_quote="Point cloud shall meet USIBD LOA30 at 95% confidence."),
            Requirement(id="R2", category="validation", text="invented", source_quote="Independent check points required.")]
    monkeypatch.setattr(scope, "extract_llm", lambda t: (fake, ["validation"]))
    r = scope.extract(text)
    assert r["extractor"] == "llm"
    st = {q["id"]: (q["quote_verified"], q["status"]) for q in r["requirements"]}
    assert st == {"R1": (True, "proposed"), "R2": (False, "rejected")}

    def boom(t):
        raise ConnectionError("no network on site")
    monkeypatch.setattr(scope, "extract_llm", boom)
    r = scope.extract(text)
    assert r["extractor"] == "offline" and "failed" in r["note"]


def test_offline_finds_validation_when_present():
    t = "Accuracy shall be validated with independent total-station check points (min. 20)."
    r = scope.extract(t, mode="offline")
    assert any(q["category"] == "validation" for q in r["requirements"])
    assert "validation" not in r["not_addressed"]


def test_apply_only_accepted():
    reqs = [Requirement(id="R1", category="loa", text="x", value="LOA30", source_quote="q", quote_verified=True, status="proposed"),
            Requirement(id="R2", category="lod", text="x", value="LOD 300", source_quote="q", quote_verified=True, status="accepted")]
    sp, _, _ = scope.apply_requirements(ProjectSpec(), reqs)
    assert sp.default_loa is None and sp.lod == "LOD 300"


def test_naming_regex():
    rx = scope.naming_regex("HSO_L1_<description>.<ext>")
    import re
    assert re.match(rx, "HSO_L1_Registered.e57") and not re.match(rx, "Level1 model.rvt")


# ---------------------------------------------------------------- readers & manifest

def test_las_laz_roundtrip_and_inspection(tmp_path):
    from scangap.readers import open_cloud
    from scangap.readers.las import write_las
    xyz = np.random.default_rng(0).uniform(0, 10, (5000, 3))
    for ext, wkt in ((".las", None), (".laz", 'PROJCS["NAD83 / test",UNIT["metre",1]]')):
        p = tmp_path / f"t{ext}"
        write_las(p, xyz, wkt=wkt)
        r = open_cloud(p)
        h = r.header()
        assert h.point_count == 5000
        got = np.vstack([c.xyz for c in r.iter_chunks(1500)])
        assert np.allclose(np.sort(got[:, 0]), np.sort(xyz[:, 0]), atol=0.001)
        assert ("CRS records" in h.read) == bool(wkt)
        ins = manifest.inspect_file(p)
        assert ins["ok"] and ins["declares_crs"] == bool(wkt)
    bad = tmp_path / "fake.e57"
    bad.write_bytes(b"not an e57")
    assert manifest.inspect_file(bad)["ok"] is False


def test_e57_pose_applied(tmp_path):
    from scangap.readers import open_cloud
    from scangap.readers.e57 import write_e57
    local = np.array([[1.0, 0, 0], [0, 1.0, 0]])
    s = 2 ** -0.5  # 90° about Z: (w, x, y, z)
    write_e57(tmp_path / "p.e57", [{"name": "S1", "xyz": local, "translation": [10, 20, 1.5], "rotation": [s, 0, 0, s]}])
    r = open_cloud(tmp_path / "p.e57")
    h = r.header()
    assert h.scans[0].position == (10.0, 20.0, 1.5) and "coordinateMetadata" in h.absent
    pts = np.vstack([c.xyz for c in r.iter_chunks()])
    assert np.allclose(pts, [[10, 21, 1.5], [9, 20, 1.5]], atol=1e-6)


def test_manifest_listed_vs_inspected_and_duplicates(tmp_path):
    f = tmp_path / "P_A.pdf"
    f.write_bytes(b"%PDF-1.4 test")
    files = [{"name": "P_A.pdf", "size": 13, "path": str(f)}, {"name": "p_a.PDF", "size": 13},
             {"name": "P_cloud.e57", "size": 10}]
    d = [Deliverable(name="Report PDF", format="pdf"), Deliverable(name="Cloud E57", format="e57"),
         Deliverable(name="Model RVT", format="rvt")]
    m = manifest.check_manifest(files, d, scope.naming_regex("P_<x>.<ext>"), None)
    st = {r["name"]: r["status"] for r in m["files"]}
    assert st == {"P_A.pdf": "inspected", "p_a.PDF": "listed", "P_cloud.e57": "listed"}
    titles = [x.title for x in m["findings"]]
    assert any(t.startswith("Missing deliverable: Model RVT") for t in titles)
    assert any(t.startswith("Duplicate") for t in titles)
    assert any("No coordinate system declared" in t for t in titles)
    assert any("not verified for listed-only" in t for t in titles)


def test_manifest_parse_formats():
    assert manifest.parse_manifest('[{"name":"a.e57","size":1}]')[0]["name"] == "a.e57"
    assert [x["name"] for x in manifest.parse_manifest("file,size\nx/a.pdf,3\nb.rvt,4\n")] == ["a.pdf", "b.rvt"]
    assert len(manifest.parse_manifest("a.pdf\nb.pdf\n")) == 2
