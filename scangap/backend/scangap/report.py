"""One-page PDF and CSV QA report."""
from __future__ import annotations

import csv
import io
from datetime import datetime, timezone

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.colors import LinearSegmentedColormap, LogNorm  # noqa: E402

from .models import SEVERITY_ORDER  # noqa: E402

# Sequential blue ramp (light = low) and reserved status colours
BLUE_RAMP = ["#f3f7fc", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]
STATUS = {"high": "#d03b3b", "review": "#fab219", "pass": "#0ca30c", "info": "#6b6f76"}
INK = "#1f2328"
MUTED = "#6b6f76"
DISCLAIMER = ("ScanGap is a QA aid, not a certification. Coverage, plan and registration results are screening "
              "indicators; candidate gaps need on-site or in-software review. LOA compliance can only be "
              "established with independent validation data.")


def heatmap_png(grid, zones: list[dict], zone_results: dict, actual: list[dict], plan_rows: list[dict],
                dpi: int = 160, width_in: float = 7.2) -> bytes:
    dens = grid.density()
    x0, x1, y0, y1 = grid.extent()
    aspect = (y1 - y0) / max(x1 - x0, 1e-6)
    fig, ax = plt.subplots(figsize=(width_in, max(2.0, width_in * aspect * 0.92)), dpi=dpi)
    cmap = LinearSegmentedColormap.from_list("seq", BLUE_RAMP).with_extremes(bad="#ffffff")
    pos = dens[dens > 0]
    vmax = float(np.percentile(pos, 99)) if len(pos) else 1.0
    vmin = max(vmax / 1000, 1.0)
    im = ax.imshow(np.ma.masked_less_equal(dens, 0), origin="lower", extent=(x0, x1, y0, y1),
                   cmap=cmap, norm=LogNorm(vmin=vmin, vmax=vmax), interpolation="nearest")
    for z in zones:
        if z.get("floor", 0) != getattr(grid, "floor_index", 0):
            continue
        poly = np.asarray(z["polygon"] + [z["polygon"][0]], float)
        r = zone_results.get(z["id"])
        sev = r.get("severity", "info") if r else "info"
        ax.plot(poly[:, 0], poly[:, 1], color=MUTED, lw=0.7, ls=(0, (4, 2)))
        lx, ty = poly[:-1, 0].min(), poly[:-1, 1].max()
        pad = 0.012 * (x1 - x0)
        label = z["name"] + (f"  {r['coverage_pct']:.0f}%" if r else "")
        ax.text(lx + pad, ty - pad, label, ha="left", va="top", fontsize=6, color=INK,
                bbox=dict(boxstyle="round,pad=0.25", fc="white", ec=STATUS.get(sev, MUTED), lw=1.2, alpha=0.92))
        if r:
            for g in r.get("gaps", []):
                p = np.asarray(g["path"])
                if len(p):
                    ax.plot(p[:, 0], p[:, 1], color=STATUS["high"], lw=2.2, solid_capstyle="round")
    for a in actual:
        ax.plot(a["x"], a["y"], "o", ms=4.5, mfc=INK, mec="white", mew=0.8)
        ax.annotate(a["label"], (a["x"], a["y"]), xytext=(3, 3), textcoords="offset points", fontsize=5.5, color=INK)
    for p in plan_rows:
        if p["status"] == "missing":
            ax.plot(p["x"], p["y"], "x", ms=7, mew=2, color=STATUS["high"])
            ax.annotate(f"{p['label']} (planned, missing)", (p["x"], p["y"]), xytext=(4, -9),
                        textcoords="offset points", fontsize=5.5, color=STATUS["high"], fontweight="bold")
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.tick_params(labelsize=6, colors=MUTED)
    for s in ax.spines.values():
        s.set_color("#c9ccd1")
    cb = fig.colorbar(im, ax=ax, fraction=0.025, pad=0.01)
    cb.ax.tick_params(labelsize=5.5, colors=MUTED)
    cb.set_label("pts/m² (vertical surfaces, slice)", fontsize=6, color=MUTED)
    fig.tight_layout(pad=0.3)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi)
    plt.close(fig)
    return buf.getvalue()


def _sorted_findings(findings: list[dict]) -> list[dict]:
    return sorted(findings, key=lambda f: SEVERITY_ORDER.get(f["severity"], 9))


def report_csv(project: dict, results: dict) -> str:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["ScanGap QA report", project["name"], results.get("analyzed_at", "")])
    w.writerow(["Verdict", results["verdict"]["headline"]])
    w.writerow([])
    w.writerow(["section", "severity", "title", "detail", "ref"])
    for f in _sorted_findings(results["findings"]):
        w.writerow([f["module"], f["severity"].upper(), f["title"], f["detail"], f.get("ref") or ""])
    w.writerow([])
    w.writerow(["zone", "name", "loa", "loa_range", "coverage_pct", "evaluated_m", "covered_m", "min_density",
                "setups_inside", "gaps"])
    for z in results.get("zones", []):
        w.writerow([z["zone"], z["name"], z.get("loa") or "", z.get("loa_range") or "", z["coverage_pct"],
                    z["evaluated_m"], z["covered_m"], z["min_density"], ";".join(z["setups_inside"]),
                    len(z["gaps"])])
    if results.get("plan"):
        w.writerow([])
        w.writerow(["planned_setup", "x", "y", "status", "actual", "offset_m", "zones"])
        for r in results["plan"]["rows"]:
            w.writerow([r["label"], r["x"], r["y"], r["status"], r.get("actual") or "", r.get("offset_m") or "",
                        ";".join(r["zone_names"])])
    if results.get("registration"):
        w.writerow([])
        w.writerow(["link", "error_mm", "overlap_pct", "over_tolerance"])
        tol = results["registration"]["tolerance_mm"]
        for l in results["registration"]["links"]:
            w.writerow([l["id"], l["error_mm"], l.get("overlap_pct") or "", l["error_mm"] > tol])
    w.writerow([])
    w.writerow(["Reviewer", project.get("signoff", {}).get("reviewer", ""), "Date", project.get("signoff", {}).get("date", "")])
    w.writerow(["Disclaimer", DISCLAIMER])
    return out.getvalue()


def report_pdf(project: dict, results: dict, heatmap: bytes | None) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.units import inch
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=0.45 * inch, rightMargin=0.45 * inch,
                            topMargin=0.4 * inch, bottomMargin=0.4 * inch,
                            title=f"ScanGap QA — {project['name']}", author="ScanGap")
    W = letter[0] - 0.9 * inch
    base = ParagraphStyle("b", fontName="Helvetica", fontSize=7, leading=8.6, textColor=colors.HexColor(INK))
    small = ParagraphStyle("s", parent=base, fontSize=6.2, leading=7.4, textColor=colors.HexColor(MUTED))
    h1 = ParagraphStyle("h1", parent=base, fontName="Helvetica-Bold", fontSize=12, leading=14)
    h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=7.8, leading=9.5, spaceBefore=3)
    mono = ParagraphStyle("m", parent=base, fontName="Courier", fontSize=6.6, leading=7.8)
    v = results["verdict"]
    vcol = STATUS["high"] if v["level"] == "high" else STATUS["review"] if v["level"] == "review" else STATUS["pass"]
    story = []
    story.append(Table([[Paragraph(f"ScanGap QA report — {project['name']}", h1),
                         Paragraph(f"Generated {results.get('analyzed_at', '')}<br/>Source: {results.get('cloud', {}).get('file', '—')}", small)]],
                       colWidths=[W * 0.62, W * 0.38],
                       style=TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                                         ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)])))
    counts = v["counts"]
    story.append(Table([[Paragraph(f"<b>{v['headline']}</b>", ParagraphStyle("v", parent=base, fontSize=9, leading=11, textColor=colors.white)),
                         Paragraph(f"HIGH {counts.get('high', 0)} · REVIEW {counts.get('review', 0)} · INFO {counts.get('info', 0)} · PASS {counts.get('pass', 0)}",
                                   ParagraphStyle("vc", parent=base, textColor=colors.white, alignment=2))]],
                       colWidths=[W * 0.65, W * 0.35],
                       style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(vcol if v["level"] != "review" else "#8a5a00")),
                                         ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 4),
                                         ("BOTTOMPADDING", (0, 0), (-1, -1), 4)])))
    story.append(Spacer(1, 4))

    spec = project["spec"]
    def sv(k):
        return spec.get(k) or "<font color='#d03b3b'>NOT DEFINED — REVIEW</font>"
    spec_rows = [["Intended use", sv("intended_use")], ["LOA (default)", (spec.get("default_loa") or "<font color='#d03b3b'>NOT DEFINED — REVIEW</font>") + (f" ({results.get('loa_label')})" if results.get("loa_label") else "")],
                 ["Validation", sv("validation_method")], ["Coordinate system", spec.get("coordinate_system") or "not declared"],
                 ["Units / LOD", f"{spec.get('units') or '—'} / {spec.get('lod') or '—'}"]]
    spec_tbl = Table([[Paragraph(f"<b>{a}</b>", base), Paragraph(str(b)[:180], base)] for a, b in spec_rows],
                     colWidths=[W * 0.12, W * 0.30],
                     style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 1),
                                       ("TOPPADDING", (0, 0), (-1, -1), 0.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 0.5),
                                       ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#e1e4e8"))]))
    cloud = results.get("cloud", {})
    scan_rows = [["Points", f"{cloud.get('points', 0):,}"], ["Scans / with pose", f"{cloud.get('scans', 0)} / {cloud.get('scans_with_pose', 0)}"],
                 ["Floors (Z)", ", ".join(f"{z:.2f} m" for z in cloud.get("floors", [])) or "—"],
                 ["Slice / cell", f"{cloud.get('slice', '')} / {cloud.get('cell', '')} m"],
                 ["Absent in file", ", ".join(cloud.get("absent", [])[:5]) or "—"]]
    scan_tbl = Table([[Paragraph(f"<b>{a}</b>", base), Paragraph(str(b), mono if a != "Absent in file" else small)] for a, b in scan_rows],
                     colWidths=[W * 0.12, W * 0.42],
                     style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 1),
                                       ("TOPPADDING", (0, 0), (-1, -1), 0.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 0.5),
                                       ("LINEBELOW", (0, 0), (-1, -2), 0.25, colors.HexColor("#e1e4e8"))]))
    story.append(Table([[Paragraph("Project spec", h2), Paragraph("Scan data", h2)], [spec_tbl, scan_tbl]],
                       colWidths=[W * 0.44, W * 0.56],
                       style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)])))

    if heatmap:
        img = Image(io.BytesIO(heatmap))
        ratio = img.imageHeight / img.imageWidth
        h = min(W * ratio, 3.0 * inch)
        img.drawWidth, img.drawHeight = h / ratio, h
        story.append(Paragraph("Coverage heatmap — 0.5–2.0 m slice; red = possible gap (review); ✕ = planned setup missing", h2))
        story.append(img)

    text_status = dict(STATUS, review="#8a5a00", pass_="#067a06")  # darker text steps; hues stay reserved for marks

    def chip(sev):
        return f"<font color='{text_status.get(sev if sev != 'pass' else 'pass_', MUTED)}'><b>{sev.upper()}</b></font>"

    zrows = [[Paragraph(f"<b>{h}</b>", small) for h in ("Zone", "LOA", "Coverage", "Perimeter ok", "Setups", "Status")]]
    for z in results.get("zones", [])[:14]:
        zrows.append([Paragraph(z["name"], base), Paragraph(f"{z.get('loa') or '—'}", mono),
                      Paragraph(f"{z['coverage_pct']:.1f}%", mono), Paragraph(f"{z['covered_m']:.1f}/{z['evaluated_m']:.1f} m", mono),
                      Paragraph(", ".join(z["setups_inside"]) or "none", mono), Paragraph(chip(z.get("severity", "info")), base)])
    ztbl = Table(zrows, colWidths=[W * 0.15, W * 0.06, W * 0.075, W * 0.1, W * 0.08, W * 0.065],
                 style=TableStyle([("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e1e4e8")),
                                   ("TOPPADDING", (0, 0), (-1, -1), 0.5), ("BOTTOMPADDING", (0, 0), (-1, -1), 0.5),
                                   ("LEFTPADDING", (0, 0), (-1, -1), 1)]))
    right = []
    if results.get("plan"):
        p = results["plan"]
        right.append(Paragraph(f"Plan vs actual: {p['matched']} of {len(p['rows'])} planned found (±{p['tolerance_m']:g} m)", h2))
        for r in p["rows"]:
            if r["status"] == "missing":
                right.append(Paragraph(f"{chip('high')} <font face='Courier'>{r['label']}</font> missing — meant for {', '.join(r['zone_names']) or '—'}", base))
    if results.get("registration"):
        rg = results["registration"]
        right.append(Paragraph(f"Registration: {rg['stats']['n']} links, max <font face='Courier'>{rg['stats']['max_mm']} mm</font>, tol {rg['tolerance_mm']:g} mm"
                               + (f"; target {rg['loa']['label']} (context only)" if rg.get("loa") else ""), h2))
        for f in rg["findings"]:
            if f["severity"] in ("high", "review"):
                right.append(Paragraph(f"{chip(f['severity'])} {f['title']}", base))
    if results.get("validation", {}).get("n"):
        vd = results["validation"]
        right.append(Paragraph(f"Validation: {vd['n']} check points, H95 {vd['h95_mm']} mm, V95 {vd['v95_mm']} mm", h2))
    story.append(Table([[Paragraph("Zones", h2), ""], [ztbl, right]], colWidths=[W * 0.54, W * 0.46],
                       style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0)])))

    open_items = [f for f in _sorted_findings(results["findings"]) if f["severity"] in ("high", "review")]
    story.append(Paragraph(f"Open items ({len(open_items)})", h2))
    shown = open_items[:12]
    for f in shown:
        story.append(Paragraph(f"{chip(f['severity'])} [{f['module']}] {f['title']}", base))
    if len(open_items) > len(shown):
        story.append(Paragraph(f"+{len(open_items) - len(shown)} more in the CSV report.", small))
    so = project.get("signoff", {})
    story.append(Spacer(1, 6))
    story.append(Table([[Paragraph(f"<b>Reviewer:</b> {so.get('reviewer') or '______________________'}", base),
                         Paragraph(f"<b>Signature:</b> ______________________", base),
                         Paragraph(f"<b>Date:</b> {so.get('date') or '____________'}", base)]],
                       colWidths=[W * 0.4, W * 0.35, W * 0.25]))
    story.append(Spacer(1, 3))
    story.append(Paragraph(DISCLAIMER + " " + results.get("credit", ""), small))
    doc.build(story)
    return buf.getvalue()


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
