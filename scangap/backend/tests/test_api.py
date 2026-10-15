import importlib

from fastapi.testclient import TestClient


def _client(readonly=False, monkeypatch=None):
    if monkeypatch:
        monkeypatch.setenv("SCANGAP_READONLY", "1" if readonly else "")
    from scangap import api
    importlib.reload(api)
    return TestClient(api.app)


def test_api_flow_on_synthetic(synthetic, monkeypatch):
    c = _client(monkeypatch=monkeypatch)
    h = c.get("/api/health").json()
    assert h["ok"] and h["llm_available"] is False and len(h["loa"]) == 5
    assert any(p["id"] == "demo-synthetic" for p in c.get("/api/projects").json())
    b = c.get("/api/projects/demo-synthetic").json()
    assert b["results"]["verdict"]["level"] == "high"
    g = c.get("/api/projects/demo-synthetic/grid/0").json()
    assert g["nx"] > 100 and g["density_b64"]
    pts = c.get("/api/projects/demo-synthetic/points.bin?n=5000").content
    assert len(pts) == 5000 * 12
    assert c.get("/api/projects/demo-synthetic/report.pdf").content[:4] == b"%PDF"
    assert c.get("/api/projects/nope").status_code == 404


def test_api_new_project_inputs(synthetic, monkeypatch, tmp_path):
    c = _client(monkeypatch=monkeypatch)
    pid = c.post("/api/projects", json={"name": "Test job"}).json()["id"]
    r = c.post(f"/api/projects/{pid}/inputs/plan", files={"file": ("plan.csv", b"label,x,y\nA,0,0\n")})
    assert r.status_code == 200
    bad = c.post(f"/api/projects/{pid}/inputs/plan", files={"file": ("plan.csv", b"foo,bar\n1,2\n")})
    assert bad.status_code == 400
    zones = [{"id": "z1", "name": "Lobby", "polygon": [[0, 0], [4, 0], [4, 4], [0, 4]]}]
    r = c.put(f"/api/projects/{pid}/zones", json=zones)
    assert r.json()["project"]["zones"][0]["name"] == "Lobby"
    cloud = synthetic["project"]["inputs"]["cloud"]
    r = c.post(f"/api/projects/{pid}/cloud", data={"path": cloud})
    assert r.status_code == 200 and r.json()["results"]["cloud"]["points"] > 1_000_000
    r = c.post(f"/api/projects/{pid}/inputs/scope", files={"file": ("scope.txt", b"Deliverables: a) Point cloud in E57 format.\nThe survey shall meet LOA20.\n")})
    reqs = r.json()["project"]["requirements"]
    assert reqs and all(q["status"] == "proposed" for q in reqs)
    reqs[0]["status"] = "accepted"
    r = c.put(f"/api/projects/{pid}/requirements", json=reqs)
    assert r.status_code == 200
    c.delete(f"/api/projects/{pid}")


def test_readonly_blocks_writes(synthetic, monkeypatch):
    c = _client(readonly=True, monkeypatch=monkeypatch)
    assert c.get("/api/projects/demo-synthetic").status_code == 200
    assert c.post("/api/projects", json={"name": "x"}).status_code == 403
    assert c.put("/api/projects/demo-synthetic/zones", json=[]).status_code == 403
    monkeypatch.setenv("SCANGAP_READONLY", "")
