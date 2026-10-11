import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const renderer = spawnSync('npm', ['run', 'build:ui'], { stdio: 'inherit' });
if (renderer.error) throw renderer.error;
if (renderer.status !== 0) process.exit(renderer.status ?? 1);
const build = spawnSync(
  'cargo',
  [
    'build',
    '--manifest-path',
    'src-tauri/Cargo.toml',
    '--features',
    'smoke,tauri/custom-protocol',
    '--bin',
    'repopeek',
    '--locked',
  ],
  { stdio: 'inherit' },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repopeek-tauri-smoke-')));
const first = path.join(root, 'native-demo'),
  second = path.join(root, 'second-demo');
const profile = path.join(root, 'profile'),
  report = path.join(root, 'report.json');
let child;
async function git(directory, ...args) {
  return (
    await exec(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', directory, ...args],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: 'RepoPeek Test',
          GIT_AUTHOR_EMAIL: 'test@localhost',
          GIT_COMMITTER_NAME: 'RepoPeek Test',
          GIT_COMMITTER_EMAIL: 'test@localhost',
        },
      },
    )
  ).stdout.trim();
}
try {
  for (const repo of [first, second]) {
    await mkdir(repo);
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.name', 'RepoPeek Test');
    await git(repo, 'config', 'user.email', 'test@localhost');
    await git(repo, 'config', 'commit.gpgsign', 'false');
    await git(repo, 'config', 'core.hooksPath', '/dev/null');
    await writeFile(path.join(repo, 'code.ts'), 'export const value = 1;\n');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'Initial');
  }
  for (let i = 0; i < 23; i++) await git(first, 'commit', '--allow-empty', '-m', 'History ' + i);
  await git(first, 'tag', 'v1.0');
  await writeFile(path.join(first, 'code.ts'), 'export const value = 2;\n');
  await git(first, 'add', 'code.ts');
  await writeFile(path.join(first, 'code.ts'), 'export const value = 3;\n');
  await writeFile(path.join(first, 'new.txt'), 'Untracked\n');
  await mkdir(path.join(profile, 'config'), { recursive: true });
  await writeFile(
    path.join(profile, 'config/settings.json'),
    JSON.stringify({
      version: 1,
      repositories: [
        { path: first, name: 'Native demo' },
        { path: second, name: 'Second demo' },
      ],
      preferences: { theme: 'dark', selectedRepository: first },
    }),
  );
  child = spawn(path.resolve('src-tauri/target/debug/repopeek'), [], {
    stdio: 'inherit',
    env: { ...process.env, REPOPEEK_USER_DATA: profile, REPOPEEK_SMOKE_REPORT: report },
  });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Native smoke timed out'));
    }, 120000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const result = JSON.parse(await readFile(report, 'utf8'));
  console.log(JSON.stringify(result, null, 2));
  if (code !== 0 || !result.ok) process.exitCode = 1;
} finally {
  child?.kill();
  await rm(root, { recursive: true, force: true });
}
