#!/usr/bin/env python3
"""Write deterministic build provenance for the Debian artifact."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'build-info.json').read_text())['version']
commit = os.environ.get('WALLPAPER_SUITE_COMMIT', '')
if not commit:
    try:
        commit = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    except (OSError, subprocess.CalledProcessError):
        archival = root / '.git_archival.txt'
        commit = archival.read_text().strip().removeprefix('commit=') if archival.exists() else ''
if not re.fullmatch(r'[a-f0-9]{40}', commit):
    raise SystemExit('A full source revision is required to build the Debian package')
output = Path(sys.argv[1])
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps({'version': version, 'commit': commit}, indent=2) + '\n')
