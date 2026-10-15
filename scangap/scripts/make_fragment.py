"""Turn Next's exported index.html into a page fragment for hosts that supply their own
document skeleton (<!doctype>, <html>, <head>, <body>): keep the title, stylesheet links and
scripts from <head>, then the body content."""
import re
import sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
html = src.read_text()
head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
body = re.search(r"<body[^>]*>(.*)</body>", html, re.S).group(1)
title = re.search(r"<title>.*?</title>", head, re.S).group(0)
keep = re.findall(r"<link[^>]*rel=\"(?:stylesheet|icon|preload)\"[^>]*/?>|<script\b.*?</script>", head, re.S)
keep = [k for k in keep if 'rel="preload"' not in k or "as=\"font\"" in k]
# legacy-browser polyfills (noModule) are never loaded by modern browsers; some hosts reject the file
keep = [k for k in keep if "noModule" not in k]
frag = "\n".join([title, '<meta name="description" content="ScanGap read-only demo: synthetic office floor QA">', *keep]) + "\n" + body
dst.write_text(frag)
print(f"wrote {dst} ({len(frag):,} chars)")
