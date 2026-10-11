// Injected only by a native build with the opt-in `smoke` Cargo feature.
(() => {
  const errors = [],
    checks = [];
  let editorCancellations = 0;
  addEventListener('error', (event) => errors.push(event.message));
  addEventListener('unhandledrejection', (event) => {
    // Monaco cancels pending tokenization/diff work when its models are disposed.
    if (event.reason?.name === 'Canceled' && event.reason?.message === 'Canceled') {
      editorCancellations++;
      event.preventDefault();
      return;
    }
    errors.push(String(event.reason));
  });
  const wait = async (test, label) => {
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const value = test();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Timeout: ${label}`);
  };
  const check = (label, value) => {
    if (!value) throw new Error(label);
    checks.push(label);
  };
  const setInput = (node, value) => {
    const prototype =
      node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const refreshUI = async () => {
    document.querySelector('.refresh-button').click();
    await wait(() => !document.querySelector('.refresh-button').disabled, 'refresh');
  };
  async function run() {
    await wait(
      () =>
        window.repopeek &&
        document.querySelectorAll('.repo-strip').length === 2 &&
        document.querySelector('.file-row'),
      'UI iniziale',
    );
    const api = window.repopeek;
    const state = await api.refresh();
    const first = state.settings.repositories[0].path;
    const second = state.settings.repositories[1].path;
    check(
      'WebKit senza Node/Electron nel renderer',
      typeof window.require === 'undefined' && typeof window.process === 'undefined',
    );
    check(
      'Migrazione JSON e repository selezionato',
      document.querySelector('.repo-strip.selected').getAttribute('aria-label') === 'Repository Native demo',
    );
    check(
      'Tre colonne visibili',
      document.querySelector('.repository-sidebar').getBoundingClientRect().width > 0 &&
        document.querySelector('.repository-center').getBoundingClientRect().width > 0 &&
        document.querySelector('.selection-panel').getBoundingClientRect().width > 0,
    );
    check(
      'Monaco caricato su richiesta',
      !performance.getEntriesByType('resource').some((resource) => resource.name.includes('CodeDiff-')),
    );
    const page = await api.getHistory(first);
    check(
      'Cronologia e paginazione native',
      page.commits.length === 20 &&
        !!page.nextCursor &&
        (await api.getHistory(first, page.nextCursor)).commits.length > 0,
    );
    await wait(() => document.querySelectorAll('.graph-row:not(.wip-row)').length >= 20, 'prima pagina UI');
    document.querySelector('.load-history')?.click();
    await wait(
      () =>
        document.querySelectorAll('.graph-row:not(.wip-row)').length === 24 &&
        !document.querySelector('.history-loading'),
      'commit precedenti nella UI',
    );
    const rows = () => [...document.querySelectorAll('.graph-row:not(.wip-row)')].map((row) => row.title);
    const beforeRefresh = rows();
    const originalHistory = api.getHistory;
    let historyRequests = 0;
    api.getHistory = (...args) => {
      historyRequests++;
      return originalHistory(...args);
    };
    await refreshUI();
    await wait(
      () => historyRequests >= 2 && !document.querySelector('.history-loading'),
      'refresh delle pagine caricate',
    );
    api.getHistory = originalHistory;
    check(
      'Refresh conserva i commit precedenti senza duplicati',
      JSON.stringify(rows()) === JSON.stringify(beforeRefresh),
    );
    const staged = await api.getDiff(first, 'staged:code.ts');
    const working = await api.getDiff(first, 'working:code.ts');
    check(
      'Diff staged e working indipendenti',
      staged.original === 'export const value = 1;\n' &&
        staged.modified === 'export const value = 2;\n' &&
        working.modified === 'export const value = 3;\n',
    );
    document.querySelector('.file-row[title="code.ts"]').click();
    await wait(
      () => document.querySelector('.monaco-diff-editor .view-lines')?.textContent.includes('export'),
      'Monaco WebKit e worker',
    );
    await wait(() => document.querySelector('.line-insert,.char-insert'), 'calcolo diff Monaco');
    check('Monaco reale in WebKit', document.querySelectorAll('.monaco-editor').length >= 2);
    document.querySelector('.back-button').click();
    await wait(() => !document.querySelector('.diff-panel'), 'ritorno al grafo');
    check('Editor rilasciato al ritorno al grafo', !document.querySelector('.monaco-editor'));
    const move = document.querySelector('[aria-label="Aggiungi file new.txt allo staging"]');
    move.click();
    await wait(
      () => document.querySelector('[aria-label="Rimuovi file new.txt dallo staging"]'),
      'staging dalla UI',
    );
    document.querySelector('[aria-label="Rimuovi file new.txt dallo staging"]').click();
    await wait(
      () => document.querySelector('[aria-label="Aggiungi file new.txt allo staging"]'),
      'unstaging dalla UI',
    );
    check(
      'Stage e unstage dalla UI',
      (await api.getLocalStatus(first)).changes.some((c) => c.path === 'new.txt' && c.section === 'working'),
    );
    setInput(document.querySelector('[aria-label="Titolo commit"]'), 'Native smoke commit');
    setInput(document.querySelector('[aria-label="Descrizione commit"]'), 'Only the index');
    await wait(() => !document.querySelector('.commit-submit').disabled, 'titolo commit');
    document.querySelector('.commit-submit').click();
    await wait(
      () =>
        document.querySelector('[aria-label="Titolo commit"]')?.value === '' &&
        !document.querySelector('.refresh-button').disabled,
      'commit dalla UI',
    );
    const after = await api.getLocalStatus(first);
    check(
      'Commit del solo staging',
      !after.changes.some((c) => c.section === 'staged') &&
        after.changes.some((c) => c.path === 'code.ts' && c.section === 'working') &&
        after.changes.some((c) => c.path === 'new.txt' && c.section === 'working'),
    );
    const history = await api.getHistory(first);
    check(
      'Commit persistito con descrizione',
      history.commits[0].subject === 'Native smoke commit' && history.commits[0].body === 'Only the index',
    );
    const commit = history.commits[0];
    const diff = await api.getCommitDiff(first, commit.hash, commit.changes[0].key);
    check(
      'Diff storica indipendente dal working',
      diff.type === 'text' && diff.modified === 'export const value = 2;\n',
    );
    const theme = document.querySelector('[aria-label="Tema"]');
    theme.value = 'light';
    theme.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => document.documentElement.dataset.theme === 'light', 'tema');
    check('Tema e preferenze salvati', (await api.refresh()).settings.preferences.theme === 'light');
    await api.reorderRepositories([second, first]);
    await refreshUI();
    check('Riordino persistito', (await api.refresh()).settings.repositories[0].path === second);
    try {
      await api.getDiff('/not-registered', 'working:code.ts');
      throw new Error('Repository esterno accettato');
    } catch (error) {
      check('Confine repository registrati', String(error).includes('Repository non presente'));
    }
    try {
      await api.stage(first, { path: '../outside', kind: 'file' });
      throw new Error('Traversal accettato');
    } catch (error) {
      check('Percorsi di mutazione validati', String(error).includes('non valido'));
    }
    check('Nessun errore JS', errors.length === 0);
  }
  run()
    .then(() =>
      window.__TAURI_INTERNALS__.invoke('smoke_complete', {
        report: { ok: true, checks, errors, editorCancellations, userAgent: navigator.userAgent },
      }),
    )
    .catch((error) =>
      window.__TAURI_INTERNALS__.invoke('smoke_complete', {
        report: { ok: false, checks, errors, error: String(error), stack: error.stack },
      }),
    );
})();
