"""Lenient CSV parsing: field crews export from many tools with different headers."""
from __future__ import annotations

import csv
import io
import re


def _norm(h: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", h.strip().lower()).strip("_")


def read_csv(text: str) -> tuple[list[str], list[dict]]:
    text = text.lstrip("﻿")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    rows = list(csv.reader(io.StringIO(text), dialect))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        return [], []
    header = [_norm(h) for h in rows[0]]
    out = []
    for r in rows[1:]:
        if r and r[0].strip().startswith("#"):
            continue
        out.append({header[i]: (r[i].strip() if i < len(r) else "") for i in range(len(header))})
    return header, out


def pick(header: list[str], *candidates: str) -> str | None:
    for c in candidates:
        if c in header:
            return c
    for c in candidates:
        for h in header:
            if h.startswith(c):
                return h
    return None


def to_float(v) -> float | None:
    try:
        return float(str(v).replace(",", "")) if str(v).strip() != "" else None
    except ValueError:
        return None
