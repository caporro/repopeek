import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
const executable = new URL('../src-tauri/target/release/repopeek', import.meta.url);
await access(executable);
const child = spawn(executable.pathname, [], { stdio: 'inherit' });
child.on('error', (error) => {
  throw error;
});
child.on('exit', (code) => process.exit(code ?? 0));
