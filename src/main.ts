import { Scene } from '@vectojs/core';
import { Markdown } from '@vectojs/markdown';
import { DOCUMENT_SCROLL_PHYSICS, ScrollView } from '@vectojs/ui';

import { isValidStageSize } from './utils/dpr';

declare global {
  interface Window {
    __app?: {
      scene: Scene;
      markdown: Markdown;
      scroll: ScrollView;
    };
  }
}

const SAMPLE = `# River — Streaming Markdown Reader

Hello world. This is the River hybrid scaffold (CTX-0053).

- Drop a \\.md/\\.txt and replay at adjustable rate (CTX-0054/55)
- VectoJS canvas core via \`@vectojs/markdown\` + \`createStream\` (upcoming)
- Hybrid shell: HTML header + ribbon + \`#river-stage\` → VectoJS \`Scene\`

> Audit gate: \`auditScene(scene)\` must return \`[]\` — smoke gate mirrors scribe. Add documented \`ignore\` only where stacking is intentional.

**Next**: CTX-0054 port streaming pipeline into \`river-core\`.
`;

function mountRiver(): void {
  const canvas = document.getElementById('river-canvas') as HTMLCanvasElement | null;
  const stage = document.getElementById('river-stage') as HTMLElement | null;
  const fileNameEl = document.getElementById('river-file-name') as HTMLElement | null;
  const saveStatusEl = document.getElementById('river-save-status') as HTMLElement | null;

  if (!canvas || !stage) throw new Error('River requires #river-canvas and #river-stage');

  // Scene owns backing store — disableWindowResize + ResizeObserver on #river-stage (scribe/src/main.ts:671-700)
  const scene = new Scene(canvas, {
    disableWindowResize: true,
    maxDPR: 3,
  });

  const OUTER_PAD = 16;
  const CENTERED_MAX = 860;

  const markdown = new Markdown(SAMPLE, {
    maxWidth: 640,
    selectable: true,
  });

  // Link handler — external → new tab (internal # anchor deferred to CTX-0055 scroll sync)
  markdown.onLinkClick = (url: string): void => {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // ignore
    }
  };

  const scroll = new ScrollView({
    width: 400,
    height: 400,
    scrollPhysics: DOCUMENT_SCROLL_PHYSICS,
  });
  scroll.add(markdown);

  // Manual layout — Scene has no auto-layout for Hybrid shell
  markdown.x = OUTER_PAD;
  markdown.y = OUTER_PAD;

  scene.add(scroll);
  scene.start();

  if (fileNameEl) fileNameEl.textContent = 'sample.md';
  if (saveStatusEl) saveStatusEl.textContent = 'Ready';

  const layout = (): void => {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!isValidStageSize(w, h)) return;
    scene.resize(w, h);

    const availW = Math.max(320, w);
    const availH = Math.max(200, h);
    const paneW = Math.max(320, availW - 2 * OUTER_PAD);
    const paneH = availH - 2 * OUTER_PAD;

    // Centered column (Obsidian/Typora): cap at 860, balanced gutters
    const idealW = Math.min(CENTERED_MAX, paneW);
    const centeredX = Math.max(OUTER_PAD, Math.round((availW - idealW) / 2));

    scroll.width = idealW;
    scroll.height = paneH;
    scroll.x = centeredX;
    scroll.y = OUTER_PAD;

    markdown.setMaxWidth(Math.max(200, idealW - 32));
    scroll.updateContentSize();
    scene.markDirty();
  };

  const observer = new ResizeObserver(layout);
  observer.observe(stage);
  layout();

  if (document.fonts?.ready) {
    void document.fonts.ready.then(() => layout());
  }

  // Devtools hook — ?debug → attachDevtools(scene), window.__app (scribe AGENTS.md)
  window.__app = { scene, markdown, scroll };

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

  // auditScene gate — smoke tests assert auditScene(scene) returns [] (see scribe-devtools skill)
  // Keep for CTX-0057: import { auditScene } from '@vectojs/devtools' and assert in e2e smoke.
}

mountRiver();
