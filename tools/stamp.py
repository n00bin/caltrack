"""Stamps a build id into app.js and sw.js. Run before committing:

    python tools/stamp.py

Why this exists: the service worker's cache is named after the build. If that
name never changes, `activate` never purges the old cache and phones keep
serving stale code - which is exactly what happened on 30 Aug 2026, when two
consecutive fixes appeared not to work because they never reached the device.

The stamp is also shown in Settings, so "which version are you actually
running?" is answerable rather than guesswork.
"""
import io
import os
import re
import subprocess
from datetime import datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))


def git_short_sha():
    try:
        out = subprocess.run(['git', 'rev-parse', '--short=7', 'HEAD'],
                             cwd=ROOT, capture_output=True, text=True, timeout=10)
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return 'local'


def replace(path, pattern, value, label):
    p = os.path.join(ROOT, path)
    s = io.open(p, encoding='utf-8').read()
    new, n = re.subn(pattern, value, s, count=1)
    if n != 1:
        raise SystemExit('could not stamp %s (%s)' % (path, label))
    io.open(p, 'w', encoding='utf-8', newline='').write(new)


def main():
    # Date for humans, sha for pinning it to a commit. The sha is the PREVIOUS
    # commit, since this runs before the new one - close enough to identify a
    # build, and the date disambiguates.
    stamp = datetime.now().strftime('%Y-%m-%d.%H%M') + '+' + git_short_sha()

    replace('app.js', r"var BUILD = '[^']*';", "var BUILD = '%s';" % stamp, 'BUILD')
    replace('sw.js', r"const VERSION = '[^']*';",
            "const VERSION = 'caltrack-%s';" % stamp, 'VERSION')
    print('stamped', stamp)


if __name__ == '__main__':
    main()
