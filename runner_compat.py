"""Select a known compatible isolated Vitest/Vite pair, not product dependencies."""
import json
import pathlib
import subprocess

root = pathlib.Path('subject').resolve()
runtime = pathlib.Path('runner-runtime').resolve()
runtime.mkdir(exist_ok=True)
(runtime / 'package.json').write_text(json.dumps({'private': True, 'dependencies': {'vitest': '3.2.6', 'vite': '6.4.3', 'jsdom': '25.0.1'}}))
subprocess.run(['npm', 'install', '--prefix', str(runtime), '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
for name in ('vitest', 'vite'):
    dest = root / 'node_modules' / name
    if not dest.is_symlink():
        raise RuntimeError('expected pnpm-generated symlink: ' + str(dest))
    dest.unlink()
    dest.symlink_to(runtime / 'node_modules' / name, target_is_directory=True)
launcher = root / 'node_modules' / '.bin' / 'vitest'
launcher.write_text('#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../vitest/vitest.mjs" "$@"\n')
launcher.chmod(0o755)
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise RuntimeError('isolated runner setup changed tracked product files')
# Correct the generated evidence description before the source/receipt commit.
script = pathlib.Path('controller/repair.py')
text = script.read_text()
old = "`; the existing locked pnpm/Vitest/React/jsdom setup."
new = "`; Vitest 3.2.6 / Vite 6.4.3 / jsdom 25.0.1 in an isolated runner. Frontend runtime dependencies retain their existing locked versions."
if text.count(old) != 1:
    raise RuntimeError('expected evidence description anchor')
text = text.replace(old, new, 1)
old = "No dependency or original test changed. Controlled HTTP results exercise the"
new = "No product dependency file or original test changed. The unrelated backend was temporarily excluded only during frontend installation and restored before source checks. The retained lock otherwise selects an incompatible Vitest 4.1.11/Vite pair that fails before test collection; this run does not claim that canonical full-workspace installation is repaired. Controlled HTTP results exercise the"
if text.count(old) != 1:
    raise RuntimeError('expected evidence limit anchor')
script.write_text(text.replace(old, new, 1))
