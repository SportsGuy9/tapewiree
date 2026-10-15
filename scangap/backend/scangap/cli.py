"""Command line: `scangap serve | demo | analyze | export-static`."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv=None):
    ap = argparse.ArgumentParser(prog="scangap", description="Coverage & scope QA for reality capture")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve", help="run the local API + UI")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8000)
    d = sub.add_parser("demo", help="build demo projects")
    d.add_argument("which", choices=["synthetic", "edinburgh", "all"])
    d.add_argument("--edinburgh-path", help="use an already-downloaded cloud_coloured.e57")
    d.add_argument("--regenerate", action="store_true", help="re-simulate the synthetic point cloud")
    a = sub.add_parser("analyze", help="one-shot analysis of a point cloud")
    a.add_argument("cloud")
    a.add_argument("--zones")
    a.add_argument("--plan")
    a.add_argument("--registration")
    a.add_argument("--out", default="scangap_report")
    e = sub.add_parser("export-static", help="bake a project into JSON for the read-only hosted demo")
    e.add_argument("project_id")
    e.add_argument("out_dir")
    args = ap.parse_args(argv)

    if args.cmd == "serve":
        import uvicorn
        if args.host not in ("127.0.0.1", "localhost"):
            print(f"warning: binding to {args.host} exposes project data on the network", file=sys.stderr)
        uvicorn.run("scangap.api:app", host=args.host, port=args.port)
    elif args.cmd == "demo":
        from . import demo
        if args.which in ("synthetic", "all"):
            r = demo.build_synthetic(regenerate=args.regenerate)
            print("synthetic:", r["verdict"]["headline"])
        if args.which in ("edinburgh", "all"):
            r = demo.build_edinburgh(args.edinburgh_path)
            print("edinburgh:", r["verdict"]["headline"])
    elif args.cmd == "analyze":
        from . import project
        p = project.create(Path(args.cloud).stem)
        pid = p["id"]
        if args.zones:
            raw = json.loads(Path(args.zones).read_text())
            p["zones"] = raw["zones"] if isinstance(raw, dict) else raw
        for kind in ("plan", "registration"):
            f = getattr(args, kind)
            if f:
                p["inputs"][kind] = str(project.store_input(pid, kind, Path(f).name, Path(f).read_bytes()))
        project.save(p)
        project.ingest_cloud(pid, args.cloud)
        res = project.analyze(pid)
        Path(args.out + ".pdf").write_bytes(project.pdf(pid))
        Path(args.out + ".csv").write_text(project.csv_report(pid))
        print(res["verdict"]["headline"])
        for f in res["findings"]:
            if f["severity"] in ("high", "review"):
                print(f"  {f['severity'].upper():6s} {f['title']}")
        print(f"wrote {args.out}.pdf, {args.out}.csv (project {pid})")
    elif args.cmd == "export-static":
        from .static_export import export
        export(args.project_id, Path(args.out_dir))
        print(f"exported to {args.out_dir}")


if __name__ == "__main__":
    main()
