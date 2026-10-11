import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/basic-languages/monaco.contribution.js';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import type { DiffResult } from '../shared/types';
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme('repopeek-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#15181d',
    'editorGutter.background': '#15181d',
    'editorLineNumber.foreground': '#5b626d',
    'diffEditor.insertedTextBackground': '#42b98b26',
    'diffEditor.removedTextBackground': '#ed777d26',
    'diffEditor.insertedLineBackground': '#42b98b0d',
    'diffEditor.removedLineBackground': '#ed777d0d',
    'diffEditorOverview.insertedForeground': '#42b98bcc',
    'diffEditorOverview.removedForeground': '#ed777dcc',
  },
});
function language(file: string) {
  return (
    (
      {
        ts: 'typescript',
        tsx: 'typescript',
        js: 'javascript',
        jsx: 'javascript',
        mjs: 'javascript',
        cjs: 'javascript',
        json: 'json',
        css: 'css',
        scss: 'scss',
        html: 'html',
        vue: 'html',
        md: 'markdown',
        py: 'python',
        php: 'php',
        rb: 'ruby',
        rs: 'rust',
        go: 'go',
        sh: 'shell',
        yml: 'yaml',
        yaml: 'yaml',
        sql: 'sql',
        xml: 'xml',
        swift: 'swift',
        c: 'c',
        h: 'c',
        cpp: 'cpp',
        java: 'java',
        toml: 'ini',
      } as Record<string, string>
    )[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'plaintext'
  );
}
export function CodeDiff({ result, file, dark }: { result: DiffResult; file: string; dark: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    monaco.editor.setTheme(dark ? 'repopeek-dark' : 'vs');
  }, [dark]);
  useEffect(() => {
    if (!container.current || result.type === 'message') return;
    const options: monaco.editor.IStandaloneEditorConstructionOptions = {
      automaticLayout: true,
      readOnly: true,
      domReadOnly: true,
      fontFamily: 'SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      padding: { top: 16, bottom: 16 },
      wordWrap: 'off',
      lineNumbersMinChars: 3,
      renderWhitespace: 'selection',
      stickyScroll: { enabled: false },
    };
    if (result.type === 'conflict') {
      const model = monaco.editor.createModel(result.content, language(file));
      const editor = monaco.editor.create(container.current, { ...options, model });
      return () => {
        editor.dispose();
        model.dispose();
      };
    }
    const original = monaco.editor.createModel(result.original, language(file));
    const modified = monaco.editor.createModel(result.modified, language(file));
    const editor = monaco.editor.createDiffEditor(container.current, {
      ...options,
      originalEditable: false,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      enableSplitViewResizing: true,
      renderOverviewRuler: true,
      ignoreTrimWhitespace: false,
      maxComputationTime: 5000,
    });
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
  }, [result, file]);
  if (result.type === 'message')
    return (
      <div className="empty">
        <span className="empty-glyph">{result.reason === 'submodule' ? '⑂' : '⌘'}</span>
        <p>{result.message}</p>
      </div>
    );
  return (
    <>
      {result.type === 'text' && (
        <div className="version-labels">
          <span>{result.originalLabel}</span>
          <span>{result.modifiedLabel}</span>
        </div>
      )}
      {(result.type === 'conflict' || result.note) && (
        <div className="diff-note">{result.type === 'conflict' ? result.message : result.note}</div>
      )}
      <div className="editor-container" ref={container} data-testid="code-editor" />
    </>
  );
}
