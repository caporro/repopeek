import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'repopeek-overview-smoke-')));
const repo = path.join(root, 'demo-app'),
  second = path.join(root, 'website'),
  profile = path.join(root, 'profile');
const errors = [];
let app,
  tick = 0;
const env = { ...process.env, REPOPEEK_USER_DATA: profile, REPOPEEK_SMOKE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
async function git(directory, ...args) {
  const date = `${1700000000 + tick++} +0000`;
  return (
    await exec(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'tag.gpgsign=false',
        '-C',
        directory,
        ...args,
      ],
      {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@localhost',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@localhost',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    )
  ).stdout.trim();
}
async function commit(directory, subject) {
  await git(directory, 'add', '.');
  await git(directory, 'commit', '-m', subject);
  return git(directory, 'rev-parse', 'HEAD');
}
async function launch() {
  app = await electron.launch({
    ...(process.env.REPOPEEK_EXECUTABLE ? { executablePath: process.env.REPOPEEK_EXECUTABLE } : {}),
    args: process.env.REPOPEEK_EXECUTABLE ? [`--user-data-dir=${profile}`] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.getByRole('button', { name: 'Aggiungi repository', exact: true }).waitFor();
  return page;
}
const waitText = async (page, value) =>
  page.waitForFunction(
    (text) =>
      document
        .querySelector('.monaco-diff-editor')
        ?.textContent.replace(/\u00a0/g, ' ')
        .includes(text),
    value,
  );
try {
  await mkdir(path.join(repo, 'src/components'), { recursive: true });
  await mkdir(second);
  await git(repo, 'init', '-b', 'main');
  await git(second, 'init', '-b', 'main');
  const original =
    'export function summarize(repositories) {\n  const dirty = repositories.filter(repo => repo.dirty);\n  return { dirty: dirty.length };\n}\n';
  const staged =
    'export function summarize(repositories) {\n  const available = repositories.filter(repo => repo.available);\n  const dirty = available.filter(repo => repo.dirty);\n  return { dirty: dirty.length, total: available.length };\n}\n';
  const working = staged.replace(
    'total: available.length',
    'total: available.length, refreshedAt: Date.now()',
  );
  await writeFile(path.join(repo, 'src/status.ts'), original);
  await writeFile(path.join(repo, 'README.md'), '# Demo app\n');
  const base = await commit(repo, 'Initial application');
  for (let i = 0; i < 22; i++) {
    await writeFile(path.join(repo, 'README.md'), `# Demo app\nOlder revision ${i}\n`);
    await commit(repo, `Older change ${i}`);
  }
  await git(repo, 'tag', 'v0.1');
  const subjects = [
    'Show repository summaries',
    'Handle unavailable repositories',
    'Preserve local preferences',
    'Improve refresh behavior',
  ];
  for (let i = 0; i < subjects.length; i++) {
    await writeFile(path.join(repo, 'README.md'), `# Demo app\nRevision ${i}\n`);
    await commit(repo, subjects[i]);
  }
  await git(repo, 'checkout', '-b', 'feature/compact', base);
  await writeFile(path.join(repo, 'src/history.ts'), 'export const historyView = "compact";\n');
  const feature = await commit(repo, 'Add compact history view');
  await git(repo, 'tag', '-a', 'preview', '-m', 'Preview');
  await git(repo, 'checkout', 'main');
  await git(repo, 'merge', '--no-ff', 'feature/compact', '-m', 'Merge compact history');
  await git(repo, 'checkout', '-b', 'remote-source', base);
  await writeFile(path.join(repo, 'remote.txt'), 'Remote-only content\n');
  const remote = await commit(repo, 'Remote-only change\n\nDescription from a remote branch');
  await git(repo, 'update-ref', 'refs/remotes/origin/remote-only', remote);
  await git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/remote-only');
  await git(repo, 'checkout', 'main');
  await git(repo, 'branch', '-D', 'remote-source');
  await git(repo, 'config', 'user.name', 'RepoPeek Test');
  await git(repo, 'config', 'user.email', 'test@localhost');
  await git(repo, 'config', 'commit.gpgsign', 'false');
  await git(repo, 'config', 'core.hooksPath', '/dev/null');
  await git(second, 'config', 'user.name', 'RepoPeek Test');
  await git(second, 'config', 'user.email', 'test@localhost');
  await git(second, 'config', 'commit.gpgsign', 'false');
  await git(second, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(path.join(repo, 'src/status.ts'), staged);
  await writeFile(
    path.join(repo, 'src/components/Button.tsx'),
    'export const Button = () => <button>New</button>;\n',
  );
  await git(repo, 'add', '.');
  await writeFile(
    path.join(repo, 'src/components/Button.tsx'),
    'export const Button = () => <button>Updated</button>;\n',
  );
  await rm(path.join(repo, 'README.md'));
  await writeFile(path.join(repo, 'src/status.ts'), working);
  await writeFile(path.join(repo, 'src/new.ts'), 'export const refreshOnFocus = true;\n');
  await writeFile(path.join(second, 'index.html'), '<h1>Website</h1>\n');
  await commit(second, 'Create website');
  await git(second, 'tag', '-a', 'v1.0', '-m', 'Deployment');
  let page = await launch();
  await page.getByRole('heading', { name: 'Un’occhiata ai tuoi repository.' }).waitFor();
  await app.evaluate(
    ({ dialog }, paths) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths });
    },
    [repo, second, repo, root],
  );
  await page.getByRole('button', { name: 'Aggiungi repository', exact: true }).click();
  await page.getByRole('article', { name: 'Repository demo-app', exact: true }).waitFor();
  await page.getByRole('alert').filter({ hasText: 'Repository già presente' }).waitFor();
  await page.getByRole('button', { name: 'Chiudi messaggio' }).click();

  const band = page.getByRole('article', { name: 'Repository demo-app', exact: true });
  const other = page.getByRole('article', { name: 'Repository website', exact: true });
  const graph = page.getByRole('region', { name: 'Grafo dei commit', exact: true });
  const right = page.locator('.selection-panel');
  const selectRepo = async (name) => {
    await page.getByRole('button', { name: `Seleziona repository ${name}`, exact: true }).click();
  };
  const refreshUI = async () => {
    await page.getByRole('button', { name: /Aggiorna.*⌘R/ }).click();
    await page.getByRole('button', { name: /Aggiorna.*⌘R/ }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('.refresh-button').disabled);
  };
  await graph.getByRole('button', { name: /^Commit Remote-only change / }).waitFor();
  assert.equal(await page.locator('.history-dialog, .commit-dialog').count(), 0);
  assert.equal(await band.locator('.commits-panel, .changes-panel').count(), 0);
  const layout = await band.boundingBox(),
    otherLayout = await other.boundingBox();
  assert(layout.height < 120);
  assert.equal(await band.locator('.repo-path').count(), 0);
  assert.equal((await graph.locator('.graph-row').first().boundingBox()).height, 28);
  const rowStyle = await graph.locator('.graph-row.selected').evaluate((row) => {
    const indicator = getComputedStyle(row, '::before');
    return {
      indicatorLeft: indicator.left,
      indicatorWidth: indicator.width,
      indicatorHeight: indicator.height,
      messageBorder: getComputedStyle(row.querySelector('.graph-message')).borderLeftWidth,
      subjectFont: getComputedStyle(row.querySelector('.graph-subject')).fontSize,
      refFont: getComputedStyle(row.querySelector('.ref-badge')).fontSize,
      laneHeight: row.querySelector('.graph-lanes').getBoundingClientRect().height,
    };
  });
  assert.deepEqual(rowStyle, {
    indicatorLeft: '0px',
    indicatorWidth: '2px',
    indicatorHeight: '28px',
    messageBorder: '0px',
    subjectFont: '12px',
    refFont: '10px',
    laneHeight: 28,
  });
  assert(layout.width < (await page.evaluate(() => innerWidth)) / 3);
  assert.equal(otherLayout.y, layout.y + layout.height);
  const graphBox = await graph.boundingBox(),
    rightBox = await right.boundingBox();
  assert(layout.x < graphBox.x && graphBox.x < rightBox.x);
  assert(Math.abs(graphBox.height - rightBox.height) < 2);
  assert((await graph.locator('.graph-lanes path').count()) > 5);
  assert.equal(
    await graph.getByRole('button', { name: 'Commit da fare', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(await band.locator('.repo-state-pending').innerText(), '+1');
  assert(await band.locator('.repo-name').evaluate((el) => el.classList.contains('dirty')));
  assert.equal(await other.locator('.repo-state-aligned').count(), 1);
  assert.equal(
    await right
      .getByRole('button', { name: 'Aggiungi file src/status.ts allo staging', exact: true })
      .count(),
    1,
  );
  await page.getByLabel('Tema', { exact: true }).selectOption('dark');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: path.join(root, 'workspace-dark.png') });

  // A remote-only commit has its own details and historical blob preview.
  await graph.getByRole('button', { name: /^Commit Remote-only change / }).click();
  await right.getByText('Description from a remote branch', { exact: true }).waitFor();
  assert.match(await right.innerText(), /origin\/remote-only/);
  await right.getByRole('button', { name: 'remote.txt · Aggiunto', exact: true }).click();
  await waitText(page, 'Remote-only content');
  assert.equal(await band.isVisible(), true);
  assert.equal(await graph.isVisible(), false);
  assert.equal(await right.isVisible(), true);
  await selectRepo('website');
  await graph.getByRole('button', { name: /^Commit Create website / }).waitFor();
  assert.equal(await page.locator('.workspace-diff').count(), 0);
  assert.match(await right.innerText(), /Create website/);
  await selectRepo('demo-app');
  await graph.getByRole('button', { name: /^Commit Remote-only change / }).waitFor();
  assert.match(await right.innerText(), /Remote-only change/);

  // Paging does not shift lanes or lose commit selection/scroll when opening a diff.
  if (await graph.locator('.graph-scroll').evaluate((node) => node.scrollHeight <= node.clientHeight))
    await graph.getByRole('button', { name: 'Carica altri commit', exact: true }).click();
  await graph.locator('.graph-scroll').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await graph.getByRole('button', { name: /^Commit Initial application / }).waitFor();
  assert.equal(await graph.locator('.graph-row').count(), 31);
  await graph.getByRole('button', { name: /^Commit Initial application / }).click();
  const scrollBefore = await graph.locator('.graph-scroll').evaluate((node) => node.scrollTop);
  await right.getByRole('button', { name: 'src/status.ts · Aggiunto', exact: true }).click();
  await waitText(page, 'dirty.length');
  assert.match(await page.locator('.version-labels').innerText(), new RegExp(base.slice(0, 7)));
  await page.getByRole('button', { name: 'Torna al grafo', exact: true }).click();
  assert.equal(await graph.locator('.graph-scroll').evaluate((node) => node.scrollTop), scrollBefore);
  assert.equal(
    await graph.getByRole('button', { name: /^Commit Initial application / }).getAttribute('aria-pressed'),
    'true',
  );
  await graph.getByRole('button', { name: /^Commit Merge compact history / }).click();
  assert.match(await right.innerText(), /primo genitore/);
  await graph.getByRole('button', { name: 'Commit da fare', exact: true }).click();
  const workingTree = right.getByRole('region', { name: 'Working changes', exact: true });
  const stagedTree = right.getByRole('region', { name: 'Staged changes', exact: true });
  await workingTree.getByRole('button', { name: 'src/status.ts · Modificato', exact: true }).click();
  await waitText(page, 'refreshedAt');
  assert.match(await page.locator('.version-labels').innerText(), /Staging.*Working tree/s);
  assert.equal(await page.locator('.diffOverview').count(), 1);
  await page.screenshot({ path: path.join(root, 'diff-dark.png') });
  await stagedTree.getByRole('button', { name: 'src/status.ts · Modificato', exact: true }).click();
  await waitText(page, 'available');
  await page.waitForFunction(() =>
    document.querySelector('.version-labels')?.textContent.includes('Ultimo commit'),
  );
  assert(!(await page.locator('.monaco-diff-editor').innerText()).includes('refreshedAt'));
  const before = await readFile(path.join(repo, 'src/status.ts'), 'utf8');
  await page.locator('.monaco-diff-editor .modified .view-lines').click();
  await page.keyboard.type('SHOULD_NOT_BE_WRITTEN');
  assert.equal(await readFile(path.join(repo, 'src/status.ts'), 'utf8'), before);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const preferences = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  await workingTree.getByRole('button', { name: 'Cartella src', exact: true }).click();
  assert.equal(
    await workingTree.getByRole('button', { name: 'src/status.ts · Modificato', exact: true }).count(),
    0,
  );
  assert.equal(
    await stagedTree.getByRole('button', { name: 'src/status.ts · Modificato', exact: true }).isVisible(),
    true,
  );
  await workingTree.getByRole('button', { name: 'Cartella src', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Torna al grafo', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Titolo commit', exact: true })
    .fill('Draft kept across navigation');
  await graph.getByRole('button', { name: /^Commit Add compact history view / }).click();
  await graph.getByRole('button', { name: 'Commit da fare', exact: true }).click();
  assert.equal(
    await page.getByRole('textbox', { name: 'Titolo commit', exact: true }).inputValue(),
    'Draft kept across navigation',
  );

  // Moving the staged occurrence refreshes the open working diff, whose selection key stays unchanged.
  await workingTree.getByRole('button', { name: 'src/status.ts · Modificato', exact: true }).click();
  await waitText(page, 'refreshedAt');
  await right.getByRole('button', { name: 'Rimuovi file src/status.ts dallo staging', exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector('.monaco-diff-editor .original .view-lines')
      ?.textContent.replace(/\u00a0/g, ' ')
      .includes('const dirty = repositories.filter'),
  );
  assert.equal(await page.locator('.section-pill').innerText(), 'Working');
  await writeFile(path.join(repo, 'src/status.ts'), staged);
  await git(repo, 'add', '--', 'src/status.ts');
  await writeFile(path.join(repo, 'src/status.ts'), working);
  await refreshUI();
  await page.waitForFunction(() =>
    document
      .querySelector('.monaco-diff-editor .original .view-lines')
      ?.textContent.replace(/\u00a0/g, ' ')
      .includes('const available = repositories.filter'),
  );
  await page.getByRole('button', { name: 'Torna al grafo', exact: true }).click();

  // Consecutive clicks queue independently; local statistics never reload history or other repositories.
  await page.waitForFunction(
    () => document.querySelector('.graph-scroll')?.getAttribute('aria-busy') === 'false',
  );
  await page.evaluate(() => {
    window.historyReloads = 0;
    window.historyObserver = new MutationObserver((records) => {
      window.historyReloads += records.length;
    });
    window.historyObserver.observe(document.querySelector('.graph-scroll'), {
      attributes: true,
      attributeFilter: ['aria-busy'],
    });
  });
  await writeFile(path.join(second, 'index.html'), '<h1>Changed outside selected repository</h1>\n');
  const queued = await page.evaluate(() => {
    const first = document.querySelector('[aria-label="Aggiungi file src/new.ts allo staging"]');
    const second = document.querySelector('[aria-label="Aggiungi file README.md allo staging"]');
    first.click();
    first.click(); // Duplicate clicks must not enqueue a second mutation of the same file.
    const available = !second.disabled;
    second.click();
    return available;
  });
  assert.equal(queued, true);
  await stagedTree.getByRole('button', { name: 'src/new.ts · Aggiunto', exact: true }).waitFor();
  await stagedTree.getByRole('button', { name: 'README.md · Eliminato', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('.selection-panel [aria-busy="true"]') &&
      !document.querySelector('.selection-panel .unknown-count'),
  );
  assert.equal(await other.locator('.repo-state-pending').count(), 0);
  assert.equal(await page.evaluate(() => window.historyReloads), 0);
  assert.equal(await page.locator('.notice[role="alert"]').count(), 0);
  await page.evaluate(() => {
    document.querySelector('[aria-label="Rimuovi file src/new.ts dallo staging"]').click();
    document.querySelector('[aria-label="Rimuovi file README.md dallo staging"]').click();
  });
  await workingTree.getByRole('button', { name: 'src/new.ts · Non tracciato', exact: true }).waitFor();
  await workingTree.getByRole('button', { name: 'README.md · Eliminato', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('.selection-panel [aria-busy="true"]') &&
      !document.querySelector('.selection-panel .unknown-count'),
  );
  assert.equal(await page.evaluate(() => window.historyReloads), 0);
  await page.evaluate(() => window.historyObserver.disconnect());

  // A failed move must release its pending state and allow the next queued file to succeed.
  await writeFile(path.join(repo, 'disappeared.txt'), 'removed before stage\n');
  await writeFile(path.join(repo, 'queued-after-error.txt'), 'stage after error\n');
  await refreshUI();
  await right
    .getByRole('button', { name: 'Aggiungi file disappeared.txt allo staging', exact: true })
    .waitFor();
  await rm(path.join(repo, 'disappeared.txt'));
  await page.evaluate(() => {
    document.querySelector('[aria-label="Aggiungi file disappeared.txt allo staging"]').click();
    document.querySelector('[aria-label="Aggiungi file queued-after-error.txt allo staging"]').click();
  });
  await stagedTree.getByRole('button', { name: 'queued-after-error.txt · Aggiunto', exact: true }).waitFor();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Il file o la cartella non presenta più modifiche' })
    .waitFor();
  await page.waitForFunction(() => !document.querySelector('.selection-panel [aria-busy="true"]'));
  assert((await git(repo, 'diff', '--cached', '--name-only')).includes('queued-after-error.txt'));
  await page.getByRole('button', { name: 'Chiudi messaggio', exact: true }).click();
  await right
    .getByRole('button', { name: 'Rimuovi file queued-after-error.txt dallo staging', exact: true })
    .click();
  await workingTree
    .getByRole('button', { name: 'queued-after-error.txt · Non tracciato', exact: true })
    .waitFor();
  await rm(path.join(repo, 'queued-after-error.txt'));

  // File and bulk stage/unstage; commit excludes newer working changes and untracked files.
  await writeFile(path.join(second, 'index.html'), '<h1>Staged website</h1>\n');
  await refreshUI();
  await selectRepo('website');
  await graph.getByRole('button', { name: 'Commit da fare', exact: true }).waitFor();
  await right.getByRole('button', { name: 'Aggiungi file index.html allo staging', exact: true }).click();
  await right.getByRole('button', { name: 'Rimuovi file index.html dallo staging', exact: true }).waitFor();
  await right.getByRole('button', { name: 'Unstage tutto', exact: true }).click();
  await right.getByRole('button', { name: 'Stage tutto', exact: true }).click();
  await right.getByRole('button', { name: 'Rimuovi file index.html dallo staging', exact: true }).waitFor();
  await writeFile(path.join(second, 'index.html'), '<h1>Newer working website</h1>\n');
  await writeFile(path.join(second, 'excluded.txt'), 'not staged\n');
  await refreshUI();
  await page.getByRole('textbox', { name: 'Titolo commit', exact: true }).fill('Commit from side panel');
  await page.getByRole('textbox', { name: 'Descrizione commit', exact: true }).fill('Only staged content');
  await page.screenshot({ path: path.join(root, 'commit-panel.png') });
  await selectRepo('demo-app');
  assert.equal(
    await page.getByRole('textbox', { name: 'Titolo commit', exact: true }).inputValue(),
    'Draft kept across navigation',
  );
  await selectRepo('website');
  assert.equal(
    await page.getByRole('textbox', { name: 'Titolo commit', exact: true }).inputValue(),
    'Commit from side panel',
  );
  await right.getByRole('button', { name: 'Commit di 1 file', exact: true }).click();
  await right.getByRole('button', { name: 'Stage tutto', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      !document.querySelector('.commit-submit').disabled ||
      document.querySelector('.commit-submit').textContent.includes('Aggiungi file'),
  );
  assert.equal(await git(second, 'log', '-1', '--format=%s'), 'Commit from side panel');
  assert.equal(await git(second, 'log', '-1', '--format=%b'), 'Only staged content');
  assert.equal(await git(second, 'show', 'HEAD:index.html'), '<h1>Staged website</h1>');
  assert.equal(await readFile(path.join(second, 'index.html'), 'utf8'), '<h1>Newer working website</h1>\n');
  assert(!(await git(second, 'ls-tree', '--name-only', 'HEAD')).includes('excluded.txt'));
  assert.equal(await page.getByRole('textbox', { name: 'Titolo commit', exact: true }).inputValue(), '');
  await right.getByRole('button', { name: 'Stage tutto', exact: true }).click();
  await page.getByRole('textbox', { name: 'Titolo commit', exact: true }).fill('Commit remaining changes');
  await right.getByRole('button', { name: 'Commit di 2 file', exact: true }).click();
  await graph.getByRole('button', { name: 'Commit da fare', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await other.locator('.repo-state-pending').count(), 0);
  assert.equal(await other.locator('.repo-state-ahead').innerText(), '2');
  assert(await other.locator('.repo-name').evaluate((el) => el.classList.contains('ahead')));

  // Sidebar controls do not switch repositories; persisted order/selection survive restart.
  await band.getByRole('button', { name: 'Rinomina demo-app', exact: true }).click();
  await page.getByRole('textbox', { name: 'Nome del repository', exact: true }).fill('My app');
  await page.getByRole('button', { name: 'Salva', exact: true }).click();
  await page.getByRole('article', { name: 'Repository My app', exact: true }).waitFor();
  assert.equal(await other.locator('.repo-select').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: 'Sposta My app giù', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.repo-strip')?.getAttribute('aria-label') === 'Repository website',
  );
  await page.getByRole('button', { name: 'Riordina My app', exact: true }).focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(
    () => document.querySelector('.repo-strip')?.getAttribute('aria-label') === 'Repository My app',
  );
  await page
    .getByRole('button', { name: 'Riordina My app', exact: true })
    .dragTo(other, { targetPosition: { x: 180, y: 95 } });
  await page.waitForFunction(
    () => document.querySelector('.repo-strip')?.getAttribute('aria-label') === 'Repository website',
  );
  await app.close();
  app = undefined;
  page = await launch();
  await page.getByRole('article', { name: 'Repository My app', exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.repo-strip.selected')?.getAttribute('aria-label') === 'Repository website',
  );
  assert.equal(await page.getByLabel('Tema', { exact: true }).inputValue(), 'dark');
  assert.equal(
    JSON.parse(await readFile(path.join(profile, 'config/settings.json'), 'utf8')).preferences
      .selectedRepository,
    second,
  );
  await writeFile(path.join(second, 'focus.txt'), 'Focus refresh\n');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].emit('focus'));
  await page
    .locator('.selection-panel')
    .getByRole('button', { name: 'focus.txt · Non tracciato', exact: true })
    .waitFor();
  await rename(second, second + '-moved');
  await refreshUI();
  await page
    .getByRole('article', { name: 'Repository website', exact: true })
    .getByText('Non disponibile', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Rimuovi website dalla lista', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.repo-strip').length === 1);
  await page.getByLabel('Tema', { exact: true }).selectOption('light');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page
    .getByRole('region', { name: 'Grafo dei commit', exact: true })
    .getByRole('button', { name: 'Commit da fare', exact: true })
    .waitFor();
  await page.waitForFunction(
    () => document.querySelector('.graph-scroll')?.getAttribute('aria-busy') === 'false',
  );
  await page.screenshot({ path: path.join(root, 'workspace-light.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
  await page.waitForFunction(() => innerWidth === 1000);
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('.workspace').scrollWidth > document.querySelector('.workspace').clientWidth,
    ),
    false,
  );
  await page.screenshot({ path: path.join(root, 'workspace-narrow.png') });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        success: true,
        root,
        checks: [
          'compact sidebar and repository selection',
          'local/remote graph, merge lanes and WIP',
          'remote-only historical diff',
          'paginated history and preserved scroll/selection',
          'diff replaces graph and keeps sidebar/details visible',
          'working/staged read-only diff and change overview',
          'open working diff updates after unstaging the same file',
          'drafts retained across repository/commit selection',
          'file/bulk stage and unstage',
          'consecutive queued stage/unstage without history/global refresh',
          'failed and duplicate moves do not block later files',
          'inline staged-only commits and full descriptions',
          'persisted selection/theme/order and drag/keyboard reorder',
          'refresh, unavailable repositories and removal',
          'sandbox, themes and minimum-width layout',
        ],
        screenshots: [
          'workspace-dark.png',
          'diff-dark.png',
          'commit-panel.png',
          'workspace-light.png',
          'workspace-narrow.png',
        ].map((name) => path.join(root, name)),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        errors,
        root,
        pages: app
          ? await Promise.all(
              app.windows().map(async (page) => ({
                url: page.url(),
                text: (await page.locator('body').innerText()).slice(0, 4000),
              })),
            )
          : [],
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (app) await app.close();
}
