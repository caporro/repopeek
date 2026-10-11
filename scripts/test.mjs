import { spawnSync } from 'node:child_process';
const build = spawnSync(
  'cargo',
  [
    'build',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--no-default-features',
    '--features',
    'test-driver',
    '--bin',
    'repopeek-test-driver',
    '--locked',
  ],
  { stdio: 'inherit' },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const tests = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'tests/*.test.ts'], {
  stdio: 'inherit',
});
process.exit(tests.status ?? 1);
