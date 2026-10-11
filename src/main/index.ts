import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, session } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { commitStaged, getDiff, getStatus, resolveRepository, stage, unstage } from './git';
import { getCommitDiff, getHistoryPage, getLocalStatus, getOverview } from './history';
import { SettingsStore } from './settings';
import type { AppState, ChangeTarget, Preferences, Repository } from '../shared/types';

app.setName('RepoPeek');
if (!app.isPackaged && process.env.REPOPEEK_USER_DATA)
  app.setPath('userData', process.env.REPOPEEK_USER_DATA);
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);
const developmentURL = !app.isPackaged ? process.env.REPOPEEK_DEV_URL : undefined;
if (developmentURL && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(developmentURL))
  throw new Error('URL di sviluppo non valido.');
let window: BrowserWindow | null = null;
let store: SettingsStore;
let refreshInFlight: Promise<AppState> | undefined;
let gitMutationInFlight: Promise<unknown> | undefined;

function assertSender(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url;
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    url !== (developmentURL ?? 'app://repopeek/index.html')
  )
    throw new Error('Richiesta non autorizzata.');
}
function repository(value: unknown): Repository {
  if (typeof value !== 'string') throw new Error('Repository non valido.');
  const repo = store.get().repositories.find((item) => item.path === value);
  if (!repo) throw new Error('Repository non presente nella lista.');
  return repo;
}
function handle(channel: string, action: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertSender(event);
    return action(...args);
  });
}
async function refresh(): Promise<AppState> {
  if (gitMutationInFlight) await gitMutationInFlight;
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    const settings = store.get();
    const statuses: AppState['statuses'] = new Array(settings.repositories.length);
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(3, settings.repositories.length) }, async () => {
        while (index < settings.repositories.length) {
          const current = index++;
          statuses[current] = await getOverview(settings.repositories[current]);
        }
      }),
    );
    return { settings, statuses, warning: store.warning, refreshedAt: new Date().toISOString() };
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

function changeTarget(value: unknown): ChangeTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('File o cartella non valido.');
  const target = value as Partial<ChangeTarget>;
  if (
    typeof target.path !== 'string' ||
    !target.path ||
    target.path.length > 32_768 ||
    target.path.includes('\0') ||
    path.posix.isAbsolute(target.path) ||
    target.path.split('/').some((part) => !part || part === '.' || part === '..') ||
    (target.kind !== 'file' && target.kind !== 'directory') ||
    Object.keys(value).some((key) => key !== 'path' && key !== 'kind')
  )
    throw new Error('File o cartella non valido.');
  return target as ChangeTarget;
}

async function mutateGit<T>(action: () => Promise<T>): Promise<T> {
  if (gitMutationInFlight) throw new Error('È già in corso un’operazione Git.');
  if (refreshInFlight) await refreshInFlight;
  if (gitMutationInFlight) throw new Error('È già in corso un’operazione Git.');
  const mutation = action();
  gitMutationInFlight = mutation;
  try {
    return await mutation;
  } finally {
    if (gitMutationInFlight === mutation) gitMutationInFlight = undefined;
    refreshInFlight = undefined;
  }
}

function moveGit(value: unknown, action: (repo: Repository) => Promise<void>) {
  return mutateGit(async () => {
    const repo = repository(value);
    await action(repo);
    // Return authoritative file state immediately; statistics are refreshed separately.
    return getStatus(repo);
  });
}

function registerIPC() {
  handle('repopeek:refresh', refresh);
  handle('repopeek:local-status', (value: unknown) => getLocalStatus(repository(value)));
  handle('repopeek:add', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Aggiungi repository',
      buttonLabel: 'Aggiungi',
      properties: ['openDirectory', 'multiSelections'],
    });
    const accepted: Repository[] = [];
    const rejected: { path: string; message: string }[] = [];
    const known = new Set(store.get().repositories.map((item) => item.path));
    for (const selected of result.filePaths) {
      try {
        const canonical = await resolveRepository(selected);
        if (known.has(canonical)) rejected.push({ path: selected, message: 'Repository già presente.' });
        else {
          known.add(canonical);
          accepted.push({ path: canonical });
        }
      } catch {
        rejected.push({ path: selected, message: 'Cartella non accessibile o repository Git non valido.' });
      }
    }
    const settings = accepted.length
      ? await store.update((current) => ({
          ...current,
          repositories: [
            ...current.repositories,
            ...accepted.filter((repo) => !current.repositories.some((item) => item.path === repo.path)),
          ],
        }))
      : store.get();
    return { settings, rejected };
  });
  handle('repopeek:remove', async (value: unknown) => {
    const repo = repository(value);
    return store.update((current) => ({
      ...current,
      repositories: current.repositories.filter((item) => item.path !== repo.path),
      preferences: {
        ...current.preferences,
        selectedRepository:
          current.preferences.selectedRepository === repo.path
            ? undefined
            : current.preferences.selectedRepository,
      },
    }));
  });
  handle('repopeek:reorder', (paths: unknown) => store.reorderRepositories(paths));
  handle('repopeek:rename', async (value: unknown, name: unknown) => {
    const repo = repository(value);
    if (typeof name !== 'string' || name.length > 120 || /[\x00-\x1f]/.test(name))
      throw new Error('Nome non valido (massimo 120 caratteri).');
    return store.update((current) => ({
      ...current,
      repositories: current.repositories.map((item) =>
        item.path === repo.path ? { path: item.path, ...(name.trim() ? { name: name.trim() } : {}) } : item,
      ),
    }));
  });
  handle('repopeek:preferences', async (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Preferenze non valide.');
    const preferences = value as Partial<Preferences>;
    if (Object.keys(preferences).some((key) => !['theme', 'selectedRepository', 'fileView'].includes(key)))
      throw new Error('Preferenze non valide.');
    if (preferences.theme !== undefined && !['system', 'dark', 'light'].includes(preferences.theme))
      throw new Error('Tema non valido.');
    if (preferences.fileView !== undefined && !['list', 'tree'].includes(preferences.fileView))
      throw new Error('Vista file non valida.');
    if (preferences.selectedRepository !== undefined) repository(preferences.selectedRepository);
    const settings = await store.update((current) => ({
      ...current,
      preferences: { ...current.preferences, ...preferences },
    }));
    nativeTheme.themeSource = settings.preferences.theme;
    return settings;
  });
  handle('repopeek:history', (value: unknown, cursor: unknown) => {
    if (cursor !== undefined && (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)))
      throw new Error('Pagina della cronologia non valida.');
    const page = cursor as import('../shared/types').HistoryCursor | undefined;
    if (
      page &&
      (typeof page.offset !== 'number' ||
        !Number.isSafeInteger(page.offset) ||
        page.offset < 0 ||
        typeof page.revision !== 'string' ||
        !/^[a-f0-9]{64}$/.test(page.revision))
    )
      throw new Error('Pagina della cronologia non valida.');
    return getHistoryPage(repository(value), page);
  });
  handle('repopeek:commit-diff', (value: unknown, hash: unknown, key: unknown) => {
    if (
      typeof hash !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(hash) ||
      typeof key !== 'string' ||
      key.length > 32_768 ||
      key.includes('\0')
    )
      throw new Error('Commit o file non valido.');
    return getCommitDiff(repository(value), hash, key);
  });
  handle('repopeek:diff', (value: unknown, key: unknown) => {
    if (typeof key !== 'string' || key.length > 32_768 || key.includes('\0'))
      throw new Error('File non valido.');
    return getDiff(repository(value), key);
  });
  handle('repopeek:stage', (value: unknown, target: unknown) =>
    moveGit(value, (repo) => stage(repo, changeTarget(target))),
  );
  handle('repopeek:unstage', (value: unknown, target: unknown) =>
    moveGit(value, (repo) => unstage(repo, changeTarget(target))),
  );
  handle('repopeek:stage-all', (value: unknown) => moveGit(value, (repo) => stage(repo)));
  handle('repopeek:unstage-all', (value: unknown) => moveGit(value, (repo) => unstage(repo)));
  handle('repopeek:commit', (value: unknown, message: unknown) => {
    if (typeof message !== 'string' || !message.trim() || message.length > 10_000 || message.includes('\0'))
      throw new Error('Inserisci un messaggio di commit valido.');
    return mutateGit(() => commitStaged(repository(value), message.trim()));
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 620,
    title: 'RepoPeek',
    titleBarStyle: 'hiddenInset',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111318' : '#f6f7f9',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('focus', () => window?.webContents.send('repopeek:refresh-requested'));
  window.on('closed', () => {
    window = null;
  });
  window.once('ready-to-show', () => {
    if (process.env.REPOPEEK_SMOKE !== '1' || app.isPackaged) window?.show();
  });
  void window.loadURL(developmentURL ?? 'app://repopeek/index.html');
}

app
  .whenReady()
  .then(async () => {
    store = new SettingsStore(path.join(app.getPath('userData'), 'config', 'settings.json'));
    const settings = await store.load();
    nativeTheme.themeSource = settings.preferences.theme;
    const rendererRoot = path.resolve(__dirname, '../renderer');
    protocol.handle('app', async (request) => {
      try {
        const url = new URL(request.url);
        const target = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname));
        const mime: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
          '.ttf': 'font/ttf',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
        };
        const contentType = mime[path.extname(target)];
        if (url.host !== 'repopeek' || !target.startsWith(rendererRoot + path.sep) || !contentType)
          return new Response('Not found', { status: 404 });
        return new Response(new Uint8Array(await readFile(target)), {
          headers: { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff' },
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed =
        details.url.startsWith('app://repopeek/') ||
        details.url.startsWith('blob:app://repopeek/') ||
        details.url.startsWith('data:') ||
        Boolean(
          developmentURL &&
          (details.url.startsWith(developmentURL) ||
            details.url.startsWith(developmentURL.replace('http:', 'ws:')) ||
            details.url.startsWith(`blob:${developmentURL}`)),
        );
      callback({ cancel: !allowed });
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'RepoPeek',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        {
          label: 'File',
          submenu: [
            {
              label: 'Aggiungi repository…',
              accelerator: 'CmdOrCtrl+O',
              click: () => window?.webContents.send('repopeek:add-requested'),
            },
            {
              label: 'Aggiorna',
              accelerator: 'CmdOrCtrl+R',
              click: () => window?.webContents.send('repopeek:refresh-requested'),
            },
            { type: 'separator' },
            { role: 'close' },
          ],
        },
        {
          label: 'Modifica',
          submenu: [
            { role: 'copy' },
            { role: 'selectAll' },
            { type: 'separator' },
            { role: 'undo' },
            { role: 'redo' },
            { role: 'cut' },
            { role: 'paste' },
          ],
        },
        { label: 'Finestra', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
      ]),
    );
    registerIPC();
    createWindow();
    app.on('activate', () => {
      if (!window) createWindow();
      else window.show();
    });
  })
  .catch((error) => {
    dialog.showErrorBox('RepoPeek', String(error));
    app.quit();
  });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
