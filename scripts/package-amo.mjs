// SPDX-License-Identifier: AGPL-3.0-or-later
// Build everything an addons.mozilla.org submission needs, into dist/amo/:
//   tsuzuki-<version>.zip         the extension (upload this)
//   tsuzuki-<version>-source.zip  the exact source of HEAD (upload when asked for source code)
// See docs/AMO.md.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'dist', 'amo');
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
if (dirty) {
  console.warn('\n⚠  Uncommitted changes. The source zip is built from the last commit (HEAD), so it would not match the build.\n   Commit first, then re-run.\n');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

run('node', ['extension/build.mjs', 'firefox']);
run('npx', ['--yes', 'web-ext@10', 'lint', '--source-dir', 'dist/firefox']);
run('npx', ['--yes', 'web-ext@10', 'build', '--source-dir', 'dist/firefox', '--artifacts-dir', out, '--filename', `tsuzuki-${version}.zip`, '--overwrite-dest']);
run('git', ['archive', '--format=zip', '-o', join(out, `tsuzuki-${version}-source.zip`), 'HEAD']);

for (const f of [`tsuzuki-${version}.zip`, `tsuzuki-${version}-source.zip`]) {
  if (!existsSync(join(out, f))) throw new Error(`missing ${f}`);
}
console.log(`\nReady for AMO in dist/amo/:\n  tsuzuki-${version}.zip         → upload\n  tsuzuki-${version}-source.zip  → "submit source code"\nNext steps: docs/AMO.md`);
