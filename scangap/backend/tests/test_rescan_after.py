"""The baked "after" state: a simulated return trip shot the missed setups S7 and S9."""


def _zones(res):
    return {z["name"]: z for z in res["zones"]}


def test_after_mech_104_covered(synthetic_after):
    z = _zones(synthetic_after["results"])["Mech 104"]
    assert z["coverage_pct"] >= 90 and z["severity"] == "pass"
    assert "S7" in z["setups_inside"]
    assert not [f for f in synthetic_after["results"]["findings"]
                if f.get("ref") == "Z104" and f["severity"] in ("high", "review")]


def test_after_corridor_east_covered(synthetic_after):
    z = _zones(synthetic_after["results"])["Corridor East"]
    assert z["coverage_pct"] >= 90 and "S9" in z["setups_inside"]


def test_after_s7_s9_no_longer_missing(synthetic_after):
    plan = synthetic_after["results"]["plan"]
    assert plan["missing"] == []
    rows = {r["label"]: r for r in plan["rows"]}
    assert rows["S7"]["status"] == "matched" and rows["S9"]["status"] == "matched"


def test_after_rescan_does_not_fix_registration_or_spec(synthetic_after):
    f = synthetic_after["results"]["findings"]
    titles = [x["title"] for x in f if x["severity"] in ("high", "review")]
    assert any(t.startswith("Link S10–S11 error 7.4 mm") for t in titles)
    assert any(t.startswith("Long single chain: S6–S8–S10–S11") for t in titles)
    assert "Validation method not defined" in titles


def test_after_verdict_improves_and_is_labelled_simulated(synthetic, synthetic_after):
    before = synthetic["results"]["verdict"]["counts"]
    after = synthetic_after["results"]["verdict"]["counts"]
    assert after["high"] < before["high"]
    assert "SIMULATED" in synthetic_after["project"]["credit"]
    assert "simulated re-scan" in synthetic_after["project"]["name"]
    # the original project is untouched
    assert synthetic["results"]["plan"]["missing"] == ["S7", "S9"]
