import { Entity, Scene } from '@vectojs/core';
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
  createStreamState,
  isAcceptedFile,
  loadFile,
  rewindStream,
  tickStream,
  tokenize,
  type StreamState,
} from '@vectojs/river-core';

import { PerfMonitor } from './perf/Monitor';
import { isValidStageSize } from './utils/dpr';

declare global {
  interface Window {
    __app?: {
      scene: Scene;
      markdown: Markdown;
      previewScroll: ScrollView;
      state: StreamState;
      perf: PerfMonitor;
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

  if (!canvas || !stage) throw new Error('River requires #river-canvas and #river-stage');

  const scene = new Scene(canvas, {
    disableWindowResize: true,
    maxDPR: 3,
  });

  const state = createStreamState();
  const perf = new PerfMonitor();
  const asyncGen = new AsyncGeneration();
  let stream: StreamController | null = null;
  let mdAutoScroll = true;
  let lastPerfUpdate = 0;
  let themeId = 'warm';
  let internalDrag = false;

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
    const idle = state.status === 'idle' && state.content.length === 0;
    // When idle the drop overlay is the primary affordance; when a document is
    // loaded the canvas transcript owns the stage. Mirror gallery DropZone's
    // visible flag — `is-hidden { opacity:0; pointer-events:none; }` so the
    // blanket never shields the transcript's text selection.
    if (idle) {
      dropzoneEl.classList.remove('is-hidden');
      dropzoneEl.removeAttribute('aria-hidden');
    } else {
      dropzoneEl.classList.add('is-hidden');
      dropzoneEl.setAttribute('aria-hidden', 'true');
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
          fpsEl.textContent = `FPS ${fps} · ${hz}Hz · ${sample.renderMode}`;
        }
        lastPerfUpdate = now;
        scene.markDirty();
      }

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

  // ── Drag & drop ──────────────────────────────────────────────────────────
  const onDragOver = (e: DragEvent): void => {
    e.preventDefault();
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
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

  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragend', onDragEnd);

  // ── Scroll: keep auto-follow honest when the user scrolls manually ───────
  // ScrollView owns wheel/touch spring physics; the Hybrid shell only needs to
  // know whether the viewport is still pinned to the bottom so the ticker can
  // decide whether to keep pinning.
  const onWheel = (): void => {
    // Let ScrollView's wheel handler run first (Scene dispatches wheel to the
    // ScrollView entity), then sample the settled target after a microtask.
    requestAnimationFrame(() => {
      mdAutoScroll = isAtBottom();
    });
  };
  window.addEventListener('wheel', onWheel, { passive: true });
  // Touch drag also clears auto-follow — sample after the Scene's pointer handlers.
  const onPointerDown = (): void => {
    requestAnimationFrame(() => {
      mdAutoScroll = isAtBottom();
    });
  };
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  // ── Keyboard shortcuts: Space = play/pause, Esc = stop, L = toggle loop ─
  const onKeyDown = (e: KeyboardEvent): void => {
    if (
      (e.target as HTMLElement).tagName === 'INPUT' ||
      (e.target as HTMLElement).tagName === 'SELECT'
    ) {
      if (e.code === 'Escape' && (e.target as HTMLElement).tagName === 'INPUT') {
        (e.target as HTMLElement).blur();
      }
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      if (state.status === 'streaming') {
        state.status = 'paused';
      } else if (state.content) {
        state.status = 'streaming';
        layout();
      }
      scene.markDirty();
      updateChrome();
    }
    if (e.code === 'Escape') {
      stopAndClear();
    }
    if (e.code === 'KeyL') {
      state.loop = !state.loop;
      scene.markDirty();
      updateChrome();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  updateChrome();
  syncDropzone();

  // ── Devtools hook — ?debug → attachDevtools(scene), window.__app ────────
  window.__app = { scene, markdown, previewScroll, state, perf };

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
    document.removeEventListener('dragover', onDragOver);
    document.removeEventListener('drop', onDrop);
    document.removeEventListener('dragstart', onDragStart);
    document.removeEventListener('dragend', onDragEnd);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('keydown', onKeyDown);
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
