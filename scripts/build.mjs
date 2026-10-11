import { build } from 'esbuild';
import { build as buildRenderer } from 'vite';

export async function buildMain() {
  await build({
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    target: 'node22',
  });
  await build({
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.cjs',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    target: 'node22',
  });
}

if (process.argv[1]?.endsWith('/build.mjs')) {
  await buildMain();
  await buildRenderer();
}
