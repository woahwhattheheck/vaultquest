"""Select a compatible isolated runner without changing product dependency files."""
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
    if dest.is_symlink():
        dest.unlink()
    elif dest.exists():
        raise RuntimeError('refusing to replace an unexpected real dependency directory: ' + str(dest))
    dest.symlink_to(runtime / 'node_modules' / name, target_is_directory=True)
launcher = root / 'node_modules' / '.bin' / 'vitest'
launcher.write_text('#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../vitest/vitest.mjs" "$@"\n')
launcher.chmod(0o755)
if subprocess.check_output(['git', 'status', '--porcelain'], cwd=root, text=True).strip():
    raise RuntimeError('isolated runner setup changed tracked product files')
