"""End-to-end on the synthetic office: the answers are known by construction."""
from scangap import project


def _f(res, module=None, severity=None, contains=None, ref=None):
    out = []
    for f in res["findings"]:
        if module and f["module"] != module:
            continue
        if severity and f["severity"] not in (severity if isinstance(severity, tuple) else (severity,)):
            continue
        if contains and contains.lower() not in f["title"].lower():
            continue
        if ref and f.get("ref") != ref:
            continue
        out.append(f)
    return out


def test_mech_104_flagged(synthetic):
    res = synthetic["results"]
    z = {r["name"]: r for r in res["zones"]}
    assert z["Mech 104"]["coverage_pct"] == 0
    assert z["Mech 104"]["setups_inside"] == []
    f = _f(res, "coverage", "high", ref="Z104")
    assert f and f[0]["title"].startswith("Possible gap — review")


def test_corridor_east_flagged_thin(synthetic):
    res = synthetic["results"]
    z = {r["name"]: r for r in res["zones"]}
    ce = z["Corridor East"]
    assert ce["coverage_pct"] < 50
    assert ce["slice_points"] > 0  # thin, not empty
    assert any(g["kind"] == "below density" for g in ce["gaps"])
    assert _f(res, "coverage", ("high", "review"), ref="ZCE")


def test_scanned_rooms_pass(synthetic):
    res = synthetic["results"]
    for r in res["zones"]:
        if r["zone"] not in ("Z104", "ZCE"):
            assert r["coverage_pct"] >= 90, r["name"]
            assert r["severity"] == "pass", r["name"]


def test_gap_wording_never_confirms(synthetic):
    for f in synthetic["results"]["findings"]:
        if f["module"] == "coverage" and "gap" in f["title"].lower():
            assert "possible gap — review" in f["title"].lower()
        assert "confirmed" not in (f["title"] + f["detail"]).lower()


def test_s7_s9_missing(synthetic):
    plan = synthetic["results"]["plan"]
    assert plan["missing"] == ["S7", "S9"]
    rows = {r["label"]: r for r in plan["rows"]}
    assert rows["S7"]["zone_names"] == ["Mech 104"]
    assert rows["S9"]["zone_names"] == ["Corridor East"]
    assert plan["matched"] == 9
    assert {f["ref"] for f in _f(synthetic["results"], "plan", "high")} == {"S7", "S9"}


def test_registration_long_chain_link_over_tolerance(synthetic):
    reg = synthetic["results"]["registration"]
    over = [l["id"] for l in reg["links"] if l["error_mm"] > reg["tolerance_mm"]]
    assert over == ["S10–S11"]
    long = [c for c in reg["chains"] if c["unconstrained"] and c["links"] >= 3]
    assert len(long) == 1 and "S10–S11" in long[0]["link_ids"]
    f = _f(synthetic["results"], "registration", "high", contains="long single chain")
    assert f and "S10–S11" in f[0]["detail"]
    # context band shown, never a compliance claim
    assert reg["loa"]["code"] == "LOA30"
    for f in _f(synthetic["results"], "registration"):
        assert "complian" not in f["title"].lower() or f["title"].startswith("No LOA compliance")


def test_scope_missing_validation_is_review(synthetic):
    p = synthetic["project"]
    assert "validation" in p["scope"]["not_addressed"]
    assert p["spec"]["validation_method"] is None
    assert _f(synthetic["results"], "spec", "review", contains="validation method")
    # everything else came from the scope with verified quotes
    assert p["spec"]["default_loa"] == "LOA30" and p["spec"]["lod"] == "LOD 300"
    assert all(r["quote_verified"] for r in p["requirements"])


def test_manifest_checks(synthetic):
    m = synthetic["results"]["manifest"]
    status = {d["deliverable"]: d["status"] for d in m["deliverables"]}
    assert any("location plan" in k.lower() and v == "missing" for k, v in status.items())
    assert any("E57" in k and v == "inspected" for k, v in status.items())
    titles = " ".join(f["title"] for f in _f(synthetic["results"], "manifest"))
    assert "Duplicate" in titles and "naming convention" in titles
    files = {f["name"]: f for f in m["files"]}
    assert files["HSO_L1_Registered.e57"]["status"] == "inspected"
    assert files["Level1 model v3.rvt"]["status"] == "listed"
    assert files["Level1 model v3.rvt"]["naming_ok"] is False


def test_header_read_vs_absent(synthetic):
    c = synthetic["results"]["cloud"]
    assert c["scans"] == 9 and c["scans_with_pose"] == 9
    assert "acquisitionStart" in c["absent"]
    assert c["coordinate_metadata"].startswith("LOCAL: Harbor St")
    assert c["floors"] == [0.01] or abs(c["floors"][0]) < 0.05


def test_verdict_and_report(synthetic):
    res = synthetic["results"]
    assert res["verdict"]["level"] == "high"
    pdf = project.pdf(synthetic["pid"])
    assert pdf[:4] == b"%PDF"
    from pypdf import PdfReader
    import io
    reader = PdfReader(io.BytesIO(pdf))
    assert len(reader.pages) == 1
    text = reader.pages[0].extract_text()
    assert "QA aid, not a certification" in text and "Reviewer" in text
    csv = project.csv_report(synthetic["pid"])
    assert "Mech 104" in csv and "S7" in csv and "Disclaimer" in csv


def test_zone_edit_reuses_cached_grid(synthetic):
    import time
    pid = synthetic["pid"]
    p = project.load(pid)
    p["zones"] = [z for z in p["zones"] if z["id"] != "ZCE"]
    project.save(p)
    t = time.time()
    res = project.analyze(pid)
    assert time.time() - t < 5
    assert "Corridor East" not in {z["name"] for z in res["zones"]}
    p["zones"] = synthetic["project"]["zones"]
    project.save(p)
    project.analyze(pid)
