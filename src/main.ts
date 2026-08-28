import { Entity, Scene, type IRenderer } from '@vectojs/core';
import {
  Markdown,
  resolvePresetTheme,
  type MarkdownTheme,
  type MarkdownThemePresetName,
  type StreamController,
} from '@vectojs/markdown';
import { DOCUMENT_SCROLL_PHYSICS, ScrollView } from '@vectojs/ui';
import {
  ACCEPTED_EXTENSIONS,
  AsyncGeneration,
  collectDocumentText,
  createStreamState,
  findMatches,
  isAcceptedFile,
  loadFile,
  rewindStream,
  tickStream,
  tokenize,
  type DocText,
  type SearchMatch,
  type StreamState,
} from '@vectojs/river-core';

import { PerfMonitor } from './perf/Monitor';
import { isValidStageSize } from './utils/dpr';
import { findCodeBlockAt, type CodeBlockHit } from './view/blockHit';
import {
  getContextMenuLastShowAt,
  hideContextMenu,
  isContextMenuVisible,
  showContextMenu,
  type ContextMenuItem,
} from './view/contextMenu';

declare global {
  interface Window {
    __app?: {
      scene: Scene;
      markdown: Markdown;
      previewScroll: ScrollView;
      state: StreamState;
      perf: PerfMonitor;
      mdAutoScroll?: boolean;
    };
  }
}

const MD_THEME: MarkdownTheme = {
  textColor: '#2d2015',
  headingColor: '#1d130a',
  codeColor: '#0f172a',
  codeBgColor: 'rgba(0,0,0,0.04)',
  quoteBorderColor: '#b4823c',
  quoteTextColor: '#8c7a65',
  tableBgColor: 'rgba(0, 0, 0, 0.02)',
  tableHeaderBgColor: 'rgba(0, 0, 0, 0.06)',
  bodyFont: 'system-ui, sans-serif',
  codeFont: 'monospace',
  fontSize: 15,
};

const THEME_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'warm', label: 'Warm light' },
  { id: 'solarizedLight', label: 'Solarized Light' },
  { id: 'githubLight', label: 'GitHub Light' },
];

function isDone(status: StreamState['status']): boolean {
  return status === 'done';
}

/**
 * Floor for the stream's admission buffer, used when the document is smaller
 * than it. Matches the controller's own 64KiB default so a small file behaves
 * exactly as before this was set explicitly.
 */
const MIN_BUFFERED_CHARS = 64 * 1024;
const PERF_REFRESH_MS = 500;
const OUTER_PAD = 16;
const CENTERED_MAX_WIDTH = 860;

/* ── Search highlight — canvas Entity that scrolls with the document ────────
 * Ported from gallery StreamReader MatchHighlight (index.ts:122). Lives as a
 * child of `markdown` so its y scrolls with the document. Uses IRenderer (not
 * RawRenderer) so it stays backend-agnostic.
 */
class MatchHighlight extends Entity {
  constructor() {
    super('MatchHighlight');
    this.interactive = false;
    this.opacity = 0;
  }

  override isPointInside(): boolean {
    return false;
  }

  override render(r: IRenderer): void {
    r.beginPath();
    r.roundRect(0, 0, this.width, this.height, 4);
    r.fill('rgba(255, 196, 48, 0.28)');
  }
}

/* ── Scrollbar constants (gallery ScrollBar.ts parity) ────────────────────── */
const SCROLLBAR_PAD = 4;
const SCROLLBAR_MIN_THUMB = 32;

function mountRiver(): void {
  const canvas = document.getElementById('river-canvas') as HTMLCanvasElement | null;
  const stage = document.getElementById('river-stage') as HTMLElement | null;
  const dropzoneEl = document.getElementById('river-dropzone') as HTMLElement | null;
  const dropzoneHint = document.getElementById('river-dropzone-hint') as HTMLElement | null;
  const dropzoneBtn = document.getElementById('river-dropzone-btn') as HTMLButtonElement | null;

  const openFileBtn = document.getElementById('river-open-file') as HTMLButtonElement | null;
  const playBtn = document.getElementById('river-play') as HTMLButtonElement | null;
  const pauseBtn = document.getElementById('river-pause') as HTMLButtonElement | null;
  const stopBtn = document.getElementById('river-stop') as HTMLButtonElement | null;
  const loopBtn = document.getElementById('river-loop') as HTMLButtonElement | null;
  const rateSlider = document.getElementById('river-rate') as HTMLInputElement | null;
  const rateInput = document.getElementById('river-rate-input') as HTMLInputElement | null;
  const progressEl = document.getElementById('river-progress') as HTMLElement | null;
  const fpsEl = document.getElementById('river-fps') as HTMLElement | null;
  const themePicker = document.getElementById('river-theme-picker') as HTMLSelectElement | null;
  const statusEl = document.getElementById('river-status') as HTMLElement | null;
  // compat: hidden scaffold elements still present after header migration
  const fileNameEl = document.getElementById('river-file-name') as HTMLElement | null;
  const saveStatusEl = document.getElementById('river-save-status') as HTMLElement | null;

  // Search bar HTML elements (Hybrid, not canvas)
  const searchBarEl = document.getElementById('river-searchbar') as HTMLElement | null;
  const searchInputEl = document.getElementById('river-search-input') as HTMLInputElement | null;
  const searchCountEl = document.getElementById('river-search-count') as HTMLElement | null;
  const searchPrevBtn = document.getElementById('river-search-prev') as HTMLButtonElement | null;
  const searchNextBtn = document.getElementById('river-search-next') as HTMLButtonElement | null;
  const searchCloseBtn = document.getElementById('river-search-close') as HTMLButtonElement | null;

  // Scrollbar HTML elements
  const scrollbarEl = document.getElementById('river-scrollbar') as HTMLElement | null;
  const scrollbarThumbEl = scrollbarEl?.querySelector(
    '.river-scrollbar__thumb',
  ) as HTMLElement | null;

  if (!canvas || !stage) throw new Error('River requires #river-canvas and #river-stage');

  const scene = new Scene(canvas, {
    disableWindowResize: true,
    maxDPR: 3,
    maxFPS: 0,
    autoThrottle: false,
    idleFPS: 60,
    renderMode: 'always',
  });

  const state = createStreamState();
  const perf = new PerfMonitor();
  const asyncGen = new AsyncGeneration();
  let stream: StreamController | null = null;
  let mdAutoScroll = true;
  let lastPerfUpdate = 0;
  let themeId = 'warm';
  let internalDrag = false;
  let dragOverCounter = 0;

  // Scrollbar drag state (HTML thumb)
  let thumbDragging = false;
  let thumbStartClientY = 0;
  let thumbStartScroll = 0;

  const markdown = new Markdown('', {
    maxWidth: 640,
    theme: MD_THEME,
    selectable: true,
  });

  markdown.onLinkClick = (url: string): void => {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  };

  // Search state — mirrors gallery StreamReader search fields
  let searchMatches: SearchMatch[] = [];
  let searchCurrent = -1;
  let searchIndexDirty = true;
  let searchIndex: DocText | null = null;
  const searchHighlight = new MatchHighlight();
  markdown.add(searchHighlight);

  const previewScroll = new ScrollView({
    width: 400,
    height: 400,
    scrollPhysics: DOCUMENT_SCROLL_PHYSICS,
  });
  previewScroll.add(markdown);
  // Manual layout — Scene has no auto-layout for Hybrid shell
  scene.add(previewScroll);
  scene.start();

  function isAtBottom(): boolean {
    const maxScroll = Math.max(0, previewScroll.content.height - previewScroll.height);
    if (maxScroll <= 0) return true;
    const cur = -previewScroll.content.y;
    return cur >= maxScroll - 8;
  }

  function syncDropzone(): void {
    if (!dropzoneEl) return;
    const idle = state.status === 'idle';
    // When idle the drop overlay is the primary affordance; when a document is
    // loaded the canvas transcript owns the stage. Mirror gallery DropZone's
    // visible flag — `is-hidden { opacity:0; pointer-events:none; }` so the
    // blanket never shields the transcript's text selection.
    if (idle) {
      dropzoneEl.classList.remove('is-hidden');
      dropzoneEl.removeAttribute('aria-hidden');
      dropzoneEl.tabIndex = 0;
    } else {
      dropzoneEl.classList.add('is-hidden');
      dropzoneEl.setAttribute('aria-hidden', 'true');
      dropzoneEl.tabIndex = -1;
      // Ensure drag highlight is cleared when overlay hides
      dropzoneEl.classList.remove('is-drag-over');
      dragOverCounter = 0;
    }
    if (dropzoneHint) {
      if (state.fileName && state.status === 'idle') {
        dropzoneHint.textContent = `${state.fileName} — Press ▶ Play to start`;
      } else if (state.status === 'idle') {
        dropzoneHint.textContent = 'Markdown · plain text';
      } else {
        dropzoneHint.textContent = state.fileName || 'Streaming…';
      }
    }
  }

  function updateScrollbar(): void {
    if (!scrollbarEl || !scrollbarThumbEl) return;
    const viewH = previewScroll.height;
    const contentH = previewScroll.content.height || markdown.height || 0;
    const scrollY = -(previewScroll.content.y ?? 0);
    const maxScroll = Math.max(0, contentH - viewH);
    if (contentH <= viewH || viewH <= 0 || maxScroll <= 0) {
      scrollbarEl.classList.add('is-hidden');
      scrollbarEl.hidden = true;
      scrollbarEl.setAttribute('aria-hidden', 'true');
      return;
    }
    scrollbarEl.classList.remove('is-hidden');
    scrollbarEl.hidden = false;
    scrollbarEl.removeAttribute('aria-hidden');
    const track = viewH - SCROLLBAR_PAD * 2;
    const thumbH = Math.max(SCROLLBAR_MIN_THUMB, (viewH / contentH) * track);
    const trackTravel = Math.max(1, viewH - SCROLLBAR_PAD * 2 - thumbH);
    const thumbY =
      SCROLLBAR_PAD + (Math.max(0, Math.min(scrollY, maxScroll)) / maxScroll) * trackTravel;
    scrollbarThumbEl.style.height = `${Math.round(thumbH)}px`;
    scrollbarThumbEl.style.top = `${Math.round(thumbY)}px`;
  }

  function thumbDragToScroll(deltaClientY: number): number {
    const viewH = previewScroll.height;
    const contentH = previewScroll.content.height || markdown.height || 0;
    const maxScroll = Math.max(0, contentH - viewH);
    const track = viewH - SCROLLBAR_PAD * 2;
    const thumbH = Math.max(SCROLLBAR_MIN_THUMB, (viewH / contentH) * track);
    const trackTravel = Math.max(1, viewH - SCROLLBAR_PAD * 2 - thumbH);
    return thumbStartScroll + (deltaClientY / trackTravel) * maxScroll;
  }

  function updateChrome(): void {
    if (fileNameEl) fileNameEl.textContent = state.fileName || 'No file';
    if (saveStatusEl) {
      saveStatusEl.textContent =
        state.status === 'streaming'
          ? 'Streaming'
          : state.status === 'paused'
            ? 'Paused'
            : state.status === 'done'
              ? 'Done'
              : 'Ready';
    }
    if (statusEl) {
      const name = state.fileName || 'No file';
      const wordCount = state.content
        ? state.content.trim().split(/\s+/).filter(Boolean).length
        : 0;
      const ch = state.content.length;
      statusEl.textContent =
        state.status === 'idle' && !state.content
          ? 'Ready'
          : `${name} · ${wordCount} words · ${ch.toLocaleString()} ch`;
    }
    if (progressEl) {
      if (!state.content) {
        progressEl.textContent = '';
      } else {
        const pct =
          state.tokens.length > 0 ? Math.round((state.cursor / state.tokens.length) * 100) : 0;
        const loop = state.loop ? ' • loop' : '';
        progressEl.textContent = `${pct}% • ${state.cursor.toLocaleString()}/${state.tokens.length.toLocaleString()} tok • ${state.status}${loop} • ${state.fileName}`;
      }
    }
    if (loopBtn) {
      loopBtn.setAttribute('aria-pressed', String(state.loop));
      loopBtn.textContent = state.loop ? '↻ Loop • on' : '↻ Loop';
    }
    const rate = state.tokenRate;
    if (rateSlider && document.activeElement !== rateSlider) rateSlider.value = String(rate);
    if (rateInput && document.activeElement !== rateInput) rateInput.value = String(rate);
    if (playBtn) playBtn.disabled = state.status === 'streaming' || !state.content;
    if (pauseBtn) pauseBtn.disabled = state.status !== 'streaming';
    if (stopBtn) stopBtn.disabled = !state.content && state.status === 'idle';
    if (themePicker && themePicker.value !== themeId) themePicker.value = themeId;
    syncDropzone();
    updateScrollbar();
  }

  /**
   * Discard the current writer. `destroy()` rather than `close()`: closing is a
   * promise that also runs end-of-stream settlement, which is meaningless for a
   * document being thrown away, and it would race the next document's writer.
   */
  function releaseStream(): void {
    stream?.destroy();
    stream = null;
  }

  /**
   * Stop playback because the writer refused a chunk.
   *
   * `write()` rejects rather than blocking when a blocked write already exists,
   * so a refusal means this chunk never reached the document and the visible text
   * would silently diverge from `state.cursor` if playback continued.
   */
  function failStream(error: unknown): void {
    releaseStream();
    state.status = 'done';
    console.error('[river] stream write refused, playback stopped:', error);
    scene.markDirty();
  }

  /** Point the document at a fresh empty source and open a new writer over it. */
  function resetDocument(): void {
    releaseStream();
    markdown.setContent('');
    stream = markdown.createStream({
      // A typewriter that shows `**bo` before the closing `**` arrives reads as
      // a rendering bug rather than as typing. The guess is display-only and is
      // unwound on close, so the finished document is identical either way.
      incompleteMode: 'optimistic',
      // `tokenize()` keeps a whole `![alt](url)` span as ONE atomic token, and a
      // `data:` URI runs to hundreds of thousands of base64 characters, so a
      // single tick can hand over a chunk far larger than the 64KiB default.
      // Admission only takes an oversize chunk when the buffer is otherwise
      // empty; if anything is already accepted-but-uncommitted it parks in the
      // single blocked slot, and a further write that frame rejects. Sizing the
      // buffer from the document itself keeps every chunk admissible without
      // guessing a ceiling: the whole source is the true upper bound on any
      // chunk, and the buffer is a character count, not a retained copy.
      maxBufferedChars: Math.max(MIN_BUFFERED_CHARS, state.content.length),
    });
    mdAutoScroll = true;
    clearSearchState();
  }

  /* ── Search helpers (gallery parity) ───────────────────────────────────── */

  function rebuildSearchIndex(): void {
    searchIndex = collectDocumentText(markdown);
    searchIndexDirty = false;
  }

  function isDocumentShown(): boolean {
    return state.status !== 'idle' && state.content.length > 0;
  }

  function updateSearchCountUI(): void {
    if (!searchCountEl) return;
    const q = searchInputEl?.value.trim() ?? '';
    if (q === '') {
      searchCountEl.textContent = '';
      return;
    }
    if (searchMatches.length === 0) {
      searchCountEl.textContent = '0 / 0';
    } else {
      searchCountEl.textContent = `${searchCurrent + 1} / ${searchMatches.length}`;
    }
  }

  function scrollToMatch(index: number): void {
    const m = searchMatches[index];
    if (!m) {
      searchHighlight.opacity = 0;
      scene.markDirty();
      return;
    }
    const viewportH = previewScroll.height;
    const contentH = previewScroll.content.height || markdown.height || 0;
    const maxScroll = Math.max(0, contentH - viewportH);
    // Center the match line in the viewport (gallery: m.y + DOC_INSET - viewportH/2)
    // River has no DOC_INSET inside content; m.y is markdown-local, so center via:
    const target = Math.max(0, Math.min(maxScroll, m.y - viewportH / 2 + (m.height ?? 20) / 2));
    previewScroll.scrollTo(target);
    // Highlight geometry is markdown-local, so it scrolls with the document
    searchHighlight.y = m.y - 2;
    searchHighlight.height = (m.height ?? 20) + 4;
    searchHighlight.width = Math.max(100, markdown.width || 640);
    searchHighlight.opacity = 1;
    scene.markDirty();
  }

  function openSearch(): void {
    if (!isDocumentShown() || !searchBarEl || !searchInputEl) return;
    searchBarEl.classList.remove('is-hidden');
    searchBarEl.removeAttribute('aria-hidden');
    searchBarEl.hidden = false;
    // Ensure search input is focused for IME
    requestAnimationFrame(() => searchInputEl.focus());
    if (searchIndexDirty) rebuildSearchIndex();
    const q = searchInputEl.value;
    searchMatches = searchIndex ? findMatches(searchIndex, q) : [];
    searchCurrent = searchMatches.length > 0 ? 0 : -1;
    updateSearchCountUI();
    if (searchInputEl.value.trim() !== '' || searchMatches.length > 0) {
      scrollToMatch(searchCurrent);
    } else {
      searchHighlight.opacity = 0;
    }
    scene.markDirty();
  }

  function closeSearch(): void {
    if (!searchBarEl) return;
    searchBarEl.classList.add('is-hidden');
    searchBarEl.setAttribute('aria-hidden', 'true');
    // Use hidden for parity with scrollbar but keep pointerEvents none via is-hidden CSS;
    // do not set hidden attribute that would defeat display:none vs is-hidden toggle —
    // searchbar uses is-hidden class, but also set hidden for a11y.
    searchHighlight.opacity = 0;
    scene.markDirty();
    // Return focus to stage so Esc doesn't re-blur input immediately
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  function clearSearchState(): void {
    if (searchInputEl) searchInputEl.value = '';
    searchIndex = null;
    searchIndexDirty = true;
    searchMatches = [];
    searchCurrent = -1;
    searchHighlight.opacity = 0;
    updateSearchCountUI();
    if (searchBarEl) {
      searchBarEl.classList.add('is-hidden');
      searchBarEl.setAttribute('aria-hidden', 'true');
    }
  }

  function onSearchQuery(query: string): void {
    if (searchIndexDirty) rebuildSearchIndex();
    searchMatches = searchIndex ? findMatches(searchIndex, query) : [];
    searchCurrent = searchMatches.length > 0 ? 0 : -1;
    updateSearchCountUI();
    scrollToMatch(searchCurrent);
  }

  function stepSearch(delta: number): void {
    if (searchIndexDirty) {
      rebuildSearchIndex();
      const idx = searchIndex;
      searchMatches = idx ? findMatches(idx, searchInputEl?.value ?? '') : [];
      if (searchMatches.length === 0) {
        searchCurrent = -1;
        updateSearchCountUI();
        searchHighlight.opacity = 0;
        scene.markDirty();
        return;
      }
      // Clamp current if it was -1 or out of range
      if (searchCurrent < 0 || searchCurrent >= searchMatches.length) searchCurrent = 0;
    }
    if (searchMatches.length === 0) {
      updateSearchCountUI();
      return;
    }
    const n = searchMatches.length;
    searchCurrent = (searchCurrent + delta + n) % n;
    updateSearchCountUI();
    scrollToMatch(searchCurrent);
  }

  /* ── Context menu helpers ──────────────────────────────────────────────── */

  function copyText(text: string): void {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      console.warn('[river] clipboard unavailable — copy skipped');
      return;
    }
    clipboard.writeText(text).catch((error: unknown) => {
      console.warn('[river] clipboard write rejected:', error);
    });
  }

  function buildMenuItems(hit: CodeBlockHit | null): ContextMenuItem[] {
    const shown = isDocumentShown();
    const hasContent = state.content.length > 0;
    const streaming = state.status === 'streaming';
    const items: ContextMenuItem[] = [];

    if (hit) {
      items.push({
        id: 'copy-code',
        label: hit.lang ? `Copy ${hit.lang} code` : 'Copy code',
        data: hit,
      });
    }

    items.push({
      id: 'search',
      label: 'Find in document',
      hint: 'Ctrl F',
      disabled: !shown,
    });

    THEME_CHOICES.forEach((choice, i) => {
      items.push({
        id: `theme:${choice.id}`,
        label: choice.label,
        checked: themeId === choice.id,
        sectionBefore: i === 0,
      });
    });

    items.push({
      id: 'toggle-play',
      label: streaming ? 'Pause stream' : 'Resume stream',
      disabled: !hasContent || streaming,
      sectionBefore: true,
    });
    items.push({
      id: 'restart',
      label: 'Restart stream',
      disabled: !hasContent,
    });
    items.push({
      id: 'copy-source',
      label: 'Copy source',
      disabled: !hasContent,
    });
    return items;
  }

  function handleMenuSelect(id: string, data: unknown): void {
    if (id === 'search') {
      openSearch();
      return;
    }
    if (id.startsWith('theme:')) {
      applyTheme(id.slice('theme:'.length));
      return;
    }
    switch (id) {
      case 'copy-code': {
        const hit = data as CodeBlockHit | null;
        if (hit) copyText(hit.text);
        break;
      }
      case 'toggle-play':
        if (state.content && state.status !== 'streaming') {
          if (!stream) {
            rewindStream(state);
            resetDocument();
          }
          state.status = 'streaming';
          layout();
          scene.markDirty();
          updateChrome();
        }
        break;
      case 'restart':
        if (state.content) {
          rewindStream(state);
          resetDocument();
          state.status = 'streaming';
          scene.markDirty();
          updateChrome();
        }
        break;
      case 'copy-source':
        copyText(state.tokens.slice(0, state.cursor).join('') || state.content);
        break;
    }
  }

  async function openFile(file: File): Promise<void> {
    const generation = asyncGen.next();
    if (dropzoneHint) dropzoneHint.textContent = `Parsing ${file.name}…`;
    if (statusEl) statusEl.textContent = `Parsing ${file.name}…`;
    scene.markDirty();

    const loaded = await loadFile(file);
    if (!asyncGen.isCurrent(generation)) return;

    state.content = loaded.source;
    // tokenize from river-core — image-atomic spans keep data: URIs from
    // producing tens of thousands of gibberish tokens that type for minutes.
    // Resolved via the file: alias in river/package.json:31
    // (`@vectojs/river-core`: `file:../river-core` → symlink in node_modules);
    // vite resolves it to river-core/dist/index.js, so the static import at the
    // top is the single bundling path. Dynamic probe was removed — the link
    // already proves resolution without a second async chunk.
    state.tokens = tokenize(loaded.source);
    state.fileName = loaded.fileName;
    rewindStream(state);

    resetDocument();
    state.status = 'streaming';
    if (dropzoneHint) dropzoneHint.textContent = state.fileName;
    layout();
    scene.markDirty();
    updateChrome();
  }

  function stopAndClear(): void {
    state.status = 'idle';
    rewindStream(state);
    releaseStream();
    markdown.setContent('');
    if (dropzoneHint) {
      dropzoneHint.textContent = state.fileName
        ? `${state.fileName} — Press ▶ Play to start`
        : 'Markdown · plain text';
    }
    mdAutoScroll = true;
    clearSearchState();
    hideContextMenu();
    layout();
    scene.markDirty();
    updateChrome();
  }

  function applyTheme(id: string): void {
    const choice = THEME_CHOICES.find((c) => c.id === id);
    if (!choice || id === themeId) return;
    const resolved =
      id === 'warm'
        ? resolvePresetTheme(MD_THEME)
        : resolvePresetTheme(id as MarkdownThemePresetName);
    themeId = id;

    const revealed = state.tokens.slice(0, state.cursor).join('');
    const status = state.status;

    if (state.status === 'idle' || revealed.length === 0) {
      markdown.setTheme(resolved);
      scene.markDirty();
      updateChrome();
      return;
    }

    releaseStream();
    markdown.setTheme(resolved);
    markdown.setContent('');
    stream = markdown.createStream({
      incompleteMode: 'optimistic',
      maxBufferedChars: Math.max(MIN_BUFFERED_CHARS, state.content.length),
    });
    void stream.write(revealed).catch((error: unknown) => {
      failStream(error);
    });

    mdAutoScroll = status === 'streaming';
    clearSearchState();

    if (status === 'done') {
      const finishing = stream;
      stream = null;
      const generation = asyncGen.next();
      void finishing.close().then(() => {
        if (!asyncGen.isCurrent(generation)) return;
        scene.markDirty();
      });
    }
    layout();
    scene.markDirty();
    updateChrome();
  }

  function openFilePicker(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPTED_EXTENSIONS;
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      // `accept` is a dialog filter, not a guarantee: "All files" defeats it in
      // every browser's picker. Same gate as the drop path.
      if (!isAcceptedFile(file)) {
        rejectFile(file);
        return;
      }
      void openFile(file);
    };
    input.click();
  }

  function rejectFile(file: File): void {
    console.warn(`[river] ignored "${file.name}": expected one of ${ACCEPTED_EXTENSIONS}`);
    if (dropzoneEl && !dropzoneEl.classList.contains('is-hidden')) {
      if (dropzoneHint)
        dropzoneHint.textContent = `${file.name} is not Markdown — expected ${ACCEPTED_EXTENSIONS}`;
      scene.markDirty();
    }
  }

  const layout = (): void => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!isValidStageSize(w, h)) return;
    scene.resize(w, h);

    const availW = Math.max(320, w);
    const availH = Math.max(200, h);
    const paneW = Math.max(320, availW - 2 * OUTER_PAD);
    const paneH = availH - 2 * OUTER_PAD;

    const idealW = Math.min(CENTERED_MAX_WIDTH, paneW);
    const centeredX = Math.max(OUTER_PAD, Math.round((availW - idealW) / 2));

    previewScroll.width = idealW;
    previewScroll.height = paneH;
    previewScroll.x = centeredX;
    previewScroll.y = OUTER_PAD;

    const mdWidth = Math.max(200, idealW - 32);
    // Re-wrap the already-rendered blocks in place. This used to require a full
    // rebuild — release the stream, replay the revealed source through
    // `setContent`, open a fresh writer, carry the scroll offset across by hand —
    // because `maxWidth` is read when each block is *built*, so assigning it
    // alone left every existing block at the old width. `setMaxWidth`
    // (@vectojs/markdown 0.9.0) reflows the existing blocks instead: the same
    // entity instances survive, an open stream writer keeps appending, and
    // nothing is re-lexed.
    markdown.setMaxWidth(mdWidth);
    previewScroll.updateContentSize();
    updateScrollbar();
    scene.markDirty();
  };

  // ── Stream ticker — drives the Hybrid streaming loop inside Scene's onDemand cycle ──
  class StreamTicker extends Entity {
    override update(dt: number): void {
      const now = performance.now();
      if (now - lastPerfUpdate > PERF_REFRESH_MS) {
        const sample = perf.sample(scene);
        if (fpsEl) {
          const fps = Number.isFinite(sample.fps) ? sample.fps.toFixed(1) : '—';
          const hz = Number.isFinite(sample.displayHz) ? sample.displayHz.toFixed(0) : '—';
          // Starvation: when rafHz falls well below displayHz, show "240←8" style
          let hzLabel = `${hz}Hz`;
          if (
            Number.isFinite(sample.displayHz) &&
            Number.isFinite(sample.rafHz) &&
            sample.displayHz > 0
          ) {
            const rafStarved = 0.75;
            if (sample.rafHz < sample.displayHz * rafStarved) {
              hzLabel = `${Math.round(sample.displayHz)}←${Math.round(sample.rafHz)}`;
              fpsEl.style.color = '#d97757';
            } else {
              fpsEl.style.color = '';
            }
          }
          fpsEl.textContent = `FPS ${fps} · ${hzLabel} · ${sample.renderMode}`;
          fpsEl.title =
            Number.isFinite(sample.frameMs) && Number.isFinite(sample.heapUsedMB)
              ? `frame ${sample.frameMs}ms · heap ${sample.heapUsedMB.toFixed(1)}MB`
              : `FPS ${fps} · ${hzLabel}`;
        }
        lastPerfUpdate = now;
        scene.markDirty();
      }
      // Poll scrollbar thumb each frame — ScrollView's spring moves content.y continuously
      updateScrollbar();

      if (state.status !== 'streaming') {
        updateChrome();
        return;
      }

      const chunk = tickStream(state, dt);

      if (chunk) {
        // `write()` returns a backpressure promise, and it *rejects* rather than
        // blocking when a blocked write already exists. Its resolution is of no use
        // here — this is a fixed-rate typewriter whose next chunk is decided by the
        // frame clock, not by admission — but discarding it with `void` turns any
        // rejection into an unhandled one that escapes to the page as a
        // `pageerror`, with no way for the demo to notice.
        //
        // One write per frame does not itself reach that state: measured in
        // Chromium, the controller's own rAF commits between frames, so an oversize
        // chunk is admitted alone and no rejection occurs even with a 70 KiB image
        // token. Reproducing it took three writes inside a single frame. So this is
        // a contract the demo should honour rather than a bug it is hitting, and
        // the handler exists so that a future second write per frame surfaces here
        // instead of on `window`.
        stream?.write(chunk).catch((error: unknown) => {
          failStream(error);
        });

        // Search index stale — rendered text grew
        searchIndexDirty = true;

        if (mdAutoScroll) {
          // PreviewScroll's spring would otherwise smooth a per-tick pin and never
          // settle — `scrollToBottom()` snaps instantly for the streaming pin,
          // while wheel/drag still spring. Height converges via
          // driveVirtualizableContent's per-frame poll.
          previewScroll.scrollToBottom();
        }
        scene.markDirty();
      }

      if (isDone(state.status)) {
        // Closing is what makes the document converge on a one-shot parse: it
        // final-flushes, waits for the last chunk's off-thread parse to land, and
        // unwinds the optimistic tail guess.
        const finishing = stream;
        stream = null;
        const generation = asyncGen.next();
        void finishing?.close().then(() => {
          if (!asyncGen.isCurrent(generation)) return;
          if (state.loop && state.status === 'done') {
            rewindStream(state);
            resetDocument();
            state.status = 'streaming';
          }
          scene.markDirty();
        });
        scene.markDirty();
      }

      updateChrome();
    }

    override hasPendingAnimations(): boolean {
      return state.status === 'streaming';
    }

    override isPointInside(): boolean {
      return false;
    }

    override render(): void {
      /* ticker is logic-only — no pixels */
    }
  }

  const ticker = new StreamTicker('StreamTicker');
  scene.add(ticker);

  const observer = new ResizeObserver(layout);
  observer.observe(stage);
  layout();

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => layout());
  }

  // ── HTML chrome wiring — migrating gallery ControlPanel canvas paint to Hybrid header ──
  openFileBtn?.addEventListener('click', () => openFilePicker());
  dropzoneBtn?.addEventListener('click', () => openFilePicker());
  dropzoneEl?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement)?.closest('#river-dropzone-btn')) return;
    openFilePicker();
  });
  dropzoneEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openFilePicker();
    }
  });

  playBtn?.addEventListener('click', () => {
    if (state.content && state.status !== 'streaming') {
      // After Clean the stream was destroyed and markdown cleared; replay needs a fresh writer.
      if (!stream) {
        rewindStream(state);
        resetDocument();
      }
      state.status = 'streaming';
      layout();
      scene.markDirty();
      updateChrome();
    }
  });

  pauseBtn?.addEventListener('click', () => {
    if (state.status === 'streaming') {
      state.status = 'paused';
      scene.markDirty();
      updateChrome();
    }
  });

  stopBtn?.addEventListener('click', () => stopAndClear());

  loopBtn?.addEventListener('click', () => {
    state.loop = !state.loop;
    scene.markDirty();
    updateChrome();
  });

  const onRateChange = (raw: string): void => {
    const v = Number(raw);
    if (!Number.isFinite(v)) return;
    const clamped = Math.max(10, Math.min(2000, Math.round(v)));
    state.tokenRate = clamped;
    updateChrome();
    scene.markDirty();
  };

  rateSlider?.addEventListener('input', () => onRateChange(rateSlider.value));
  rateInput?.addEventListener('input', () => onRateChange(rateInput.value));
  rateInput?.addEventListener('change', () => onRateChange(rateInput.value));

  themePicker?.addEventListener('change', () => {
    const v = themePicker.value;
    applyTheme(v);
  });

  // Keep theme select in sync with initial warm sentinel
  if (themePicker) themePicker.value = themeId;

  // ── Search bar wiring (HTML) ───────────────────────────────────────────
  searchInputEl?.addEventListener('input', () => {
    onSearchQuery(searchInputEl.value);
  });
  searchInputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) stepSearch(-1);
      else stepSearch(1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
    }
  });
  searchPrevBtn?.addEventListener('click', () => stepSearch(-1));
  searchNextBtn?.addEventListener('click', () => stepSearch(1));
  searchCloseBtn?.addEventListener('click', () => closeSearch());

  // ── Scrollbar thumb drag (HTML) ────────────────────────────────────────
  scrollbarThumbEl?.addEventListener('pointerdown', (e) => {
    if (!isDocumentShown()) return;
    const contentH = previewScroll.content.height || markdown.height || 0;
    const viewH = previewScroll.height;
    if (contentH <= viewH) return;
    thumbDragging = true;
    thumbStartClientY = e.clientY;
    thumbStartScroll = -(previewScroll.content.y ?? 0);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  const onThumbPointerMove = (e: PointerEvent): void => {
    if (!thumbDragging) return;
    const next = thumbDragToScroll(e.clientY - thumbStartClientY);
    previewScroll.scrollTo(next);
    mdAutoScroll = isAtBottom();
    scene.markDirty();
  };
  const onThumbPointerUp = (): void => {
    if (!thumbDragging) return;
    thumbDragging = false;
    scene.markDirty();
  };
  window.addEventListener('pointermove', onThumbPointerMove);
  window.addEventListener('pointerup', onThumbPointerUp);
  window.addEventListener('pointercancel', onThumbPointerUp);

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const onDragEnter = (e: DragEvent): void => {
    e.preventDefault();
    if (internalDrag) return;
    dragOverCounter++;
    if (dropzoneEl && !dropzoneEl.classList.contains('is-hidden')) {
      dropzoneEl.classList.add('is-drag-over');
    } else if (dropzoneEl && state.content.length > 0) {
      // When document shown, still show dropzone as drag-over hint? Keep hidden but show highlight?
      // No — keep hidden to avoid blanket over text; drag-over highlight only when visible.
    }
    // Also add generic stage highlight when dragging over stage
    stage.classList.add('is-drag-over');
  };
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
    if (dropzoneEl && !internalDrag && dropzoneEl.classList.contains('is-drag-over')) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDragLeave = (e: DragEvent): void => {
    e.preventDefault();
    if (internalDrag) return;
    dragOverCounter = Math.max(0, dragOverCounter - 1);
    if (dragOverCounter === 0) {
      dropzoneEl?.classList.remove('is-drag-over');
      stage.classList.remove('is-drag-over');
    }
    // Fallback: if leaving window entirely (relatedTarget null), clear
    if (!e.relatedTarget) {
      dragOverCounter = 0;
      dropzoneEl?.classList.remove('is-drag-over');
      stage.classList.remove('is-drag-over');
    }
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    dragOverCounter = 0;
    dropzoneEl?.classList.remove('is-drag-over');
    stage.classList.remove('is-drag-over');
    if (internalDrag) {
      internalDrag = false;
      return;
    }
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    if (!isAcceptedFile(file)) {
      rejectFile(file);
      return;
    }
    void openFile(file);
  };

  const onDragStart = (): void => {
    internalDrag = true;
  };
  const onDragEnd = (): void => {
    internalDrag = false;
  };

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragend', onDragEnd);

  // ── Scroll: keep auto-follow honest when the user scrolls manually ───────
  // ScrollView owns wheel/touch spring physics; the Hybrid shell only needs to
  // know whether the viewport is still pinned to the bottom so the ticker can
  // decide whether to keep pinning. Also close context menu on wheel.
  // Wheel over empty canvas gutters misses the content projection hit-test, so
  // the shell also applies the delta manually when the native event was not
  // already consumed by ScrollView (see repro5: wheel at 600,300 hit CANVAS,
  // not [data-vecto-content], and produced zero scroll).
  const onWheel = (e: WheelEvent): void => {
    if (isContextMenuVisible()) hideContextMenu();
    if (e.ctrlKey) return;
    const maxScroll = Math.max(0, previewScroll.content.height - previewScroll.height);
    if (maxScroll > 0 && !e.defaultPrevented) {
      const target = e.target as HTMLElement | null;
      const overContent = !!target?.closest?.('[data-vecto-content]');
      const overMenu = !!target?.closest?.('#river-context-menu');
      const overScrollbar = !!scrollbarEl?.contains(target as Node);
      if (!overContent && !overMenu && !overScrollbar) {
        let delta = e.deltaY ?? 0;
        const mode = (e as WheelEvent).deltaMode ?? 0;
        if (mode === 1) delta *= 16;
        else if (mode === 2) delta *= previewScroll.height;
        if (delta !== 0) {
          const cur = -previewScroll.content.y;
          const next = Math.max(0, Math.min(maxScroll, cur + delta));
          if (next !== cur) {
            previewScroll.scrollTo(next);
            scene.markDirty();
            e.preventDefault();
          }
        }
      }
    }
    // Immediate update based on spring target, not live y (which lags)
    const targetY = (previewScroll as unknown as { targetY: number }).targetY;
    const curTarget = typeof targetY === 'number' ? -targetY : -previewScroll.content.y;
    mdAutoScroll = curTarget >= maxScroll - 8;
    requestAnimationFrame(() => {
      mdAutoScroll = isAtBottom();
    });
  };
  window.addEventListener('wheel', onWheel, { passive: false });
  // Touch drag also clears auto-follow — sample after the Scene's pointer handlers.
  const onPointerDown = (): void => {
    if (isContextMenuVisible()) {
      // Do not close here — contextMenu's own click-outside handler will close if outside.
    }
    mdAutoScroll = isAtBottom();
    requestAnimationFrame(() => {
      mdAutoScroll = isAtBottom();
    });
  };
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  // ── Context menu (right-click) ───────────────────────────────────────────
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const worldX = e.clientX - rect.left;
    const worldY = e.clientY - rect.top;
    // Guard: if click is on scrollbar thumb area, let thumb own it
    if (scrollbarEl && !scrollbarEl.hidden && !scrollbarEl.classList.contains('is-hidden')) {
      const sbRect = scrollbarEl.getBoundingClientRect();
      if (e.clientX >= sbRect.left && e.clientX <= sbRect.right) {
        // If over scrollbar, don't show document menu
        return;
      }
    }
    // Hit-test code block under cursor (world coords)
    let hit: CodeBlockHit | null = null;
    try {
      hit = isDocumentShown() ? findCodeBlockAt(markdown, worldX, worldY) : null;
    } catch {
      hit = null;
    }
    const items = buildMenuItems(hit);
    showContextMenu({
      x: e.clientX,
      y: e.clientY,
      items,
      onSelect: (id, data) => handleMenuSelect(id, data),
    });
  };
  window.addEventListener('contextmenu', onContextMenu);

  // Close context menu on window pointerdown outside menu (scribe pattern already handles click outside,
  // but also close on pointerdown that starts a drag/pointer capture)
  const onWindowPointerDownForMenu = (e: PointerEvent): void => {
    if (!isContextMenuVisible()) return;
    // Right button will trigger contextmenu to reposition menu; don't dismiss on the same gesture.
    if (e.button === 2 && Date.now() - getContextMenuLastShowAt() < 300) return;
    if (e.button === 2) return;
    const menuEl = document.getElementById('river-context-menu');
    if (!menuEl) return;
    const target = e.target as Node | null;
    if (target && menuEl.contains(target)) return;
    // Don't close if clicking scrollbar thumb (drag will handle)
    if (scrollbarThumbEl && target && scrollbarThumbEl.contains(target as Node)) return;
    hideContextMenu();
  };
  window.addEventListener('pointerdown', onWindowPointerDownForMenu);

  // ── Keyboard shortcuts: Ctrl/Cmd+F = find, Space = play/pause, Esc = stop, L = toggle loop ─
  const onKeyDown = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    const isInput =
      target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA';
    // Esc inside search input closes search before blurring
    if (isInput && e.code === 'Escape' && target.id === 'river-search-input') {
      e.preventDefault();
      e.stopPropagation();
      closeSearch();
      return;
    }
    // Ctrl/Cmd+F opens find — prevent browser's find even when input focused (except search input itself)
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
      e.preventDefault();
      if (searchBarEl && !searchBarEl.classList.contains('is-hidden')) {
        searchInputEl?.focus();
        searchInputEl?.select();
      } else {
        openSearch();
      }
      return;
    }
    if (isInput) {
      if (e.code === 'Escape' && target.tagName === 'INPUT') {
        (target as HTMLElement).blur();
      }
      // Let input handle its own keys; but Enter in search input already handled above
      return;
    }

    // Esc dismisses context menu before any other Esc meaning
    if (e.code === 'Escape' && isContextMenuVisible()) {
      hideContextMenu();
      e.preventDefault();
      return;
    }
    // Esc dismisses search before stop
    if (e.code === 'Escape' && searchBarEl && !searchBarEl.classList.contains('is-hidden')) {
      e.preventDefault();
      closeSearch();
      return;
    }

    // Enter/Shift+Enter when search open steps through matches (gallery parity: Enter next, Shift+Enter prev)
    if (
      searchBarEl &&
      !searchBarEl.classList.contains('is-hidden') &&
      e.code === 'Enter' &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      if (e.shiftKey) stepSearch(-1);
      else stepSearch(1);
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      if (state.status === 'streaming') {
        state.status = 'paused';
      } else if (state.content) {
        if (!stream) {
          rewindStream(state);
          resetDocument();
        }
        state.status = 'streaming';
        layout();
      }
      scene.markDirty();
      updateChrome();
    }
    if (e.code === 'Escape') {
      hideContextMenu();
      if (searchBarEl && !searchBarEl.classList.contains('is-hidden')) {
        closeSearch();
        return;
      }
      stopAndClear();
    }
    if (e.code === 'KeyL') {
      // Don't hijack when typing in search
      if (searchBarEl && !searchBarEl.classList.contains('is-hidden')) return;
      state.loop = !state.loop;
      scene.markDirty();
      updateChrome();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  updateChrome();
  syncDropzone();

  // ── Devtools hook — ?debug → attachDevtools(scene), window.__app ────────
  window.__app = {
    scene,
    markdown,
    previewScroll,
    state,
    perf,
    get mdAutoScroll() {
      return mdAutoScroll;
    },
    set mdAutoScroll(v: boolean) {
      mdAutoScroll = v;
    },
  };

  const maybeAttachDevtools = async (): Promise<void> => {
    if (!new URLSearchParams(window.location.search).has('debug')) return;
    try {
      const { attachDevtools } = await import('@vectojs/devtools');
      attachDevtools(scene);
    } catch {
      // devtools is optional
    }
  };
  void maybeAttachDevtools();

  // Cleanup on page hide — listeners are window/document global, so they must
  // be removed if the app is ever torn down (HMR, tests). SPA lifetime owns
  // the page, but keeping cleanup mirrors gallery StreamReader:952-974 destroy().
  const destroy = (): void => {
    asyncGen.destroy();
    document.removeEventListener('dragenter', onDragEnter);
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('dragleave', onDragLeave);
    document.removeEventListener('drop', onDrop);
    document.removeEventListener('dragstart', onDragStart);
    document.removeEventListener('dragend', onDragEnd);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerdown', onWindowPointerDownForMenu);
    window.removeEventListener('pointermove', onThumbPointerMove);
    window.removeEventListener('pointerup', onThumbPointerUp);
    window.removeEventListener('pointercancel', onThumbPointerUp);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('contextmenu', onContextMenu);
    window.removeEventListener('beforeunload', destroy);
    hideContextMenu();
    observer.disconnect();
    releaseStream();
    perf.destroy();
    ticker.destroy();
  };
  window.addEventListener('beforeunload', destroy);
  // Expose for tests / HMR
  (window as unknown as { __riverDestroy: () => void }).__riverDestroy = destroy;

  // auditScene gate — smoke tests assert auditScene(scene) returns [] (see scribe-devtools skill)
  // Keep for CTX-0057: import { auditScene } from '@vectojs/devtools' and assert in e2e smoke.
}

mountRiver();
