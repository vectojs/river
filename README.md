# River — Streaming Markdown Reader

Streaming markdown reader (LLM-typewriter) built as a VectoJS forge. Hybrid shell: traditional HTML chrome (header file/controls/rate/theme, optional 48px ribbon) wrapping a VectoJS canvas core (`#river-canvas` + `#river-a11y-root`).

- **Family**: `vectojs-native/river/` (container; each child is its own git repo: `river/`, `river-core/`, `river-docs/`).
- **Deployed**: <https://river.vectojs.org> (Cloudflare Pages project `river` — not yet live until CTX bootstrap; local `bun run preview` on 3518).
- **Gallery Stream Reader reference**: `vectojs-gallery/src/creations/chat/` — drop a `.md`/`.txt` and replay at adjustable rate with `@vectojs/markdown createStream` + `river-core` tokenize/tickStream.

## Tech Stack

- `bun` + `vite` + `typescript` (strict, noUnusedLocals/Params)
- `@vectojs/core` 1.39.1, `@vectojs/markdown` 0.23.1, `@vectojs/styles` 0.3.3, `@vectojs/ui` 2.20.2 (exact-pinned, never `workspace:*`), `marked` ^18.0.10, `@vectojs/devtools` 0.11.2
- `oxfmt` 0.64.0 / `oxlint` 1.79.0 / `biome` 2.5.6 / `markdownlint-cli2` / `lefthook` / `commitlint` / `vite-plugin-pwa` 1.3.0

## Development

```bash
bun install
bun run dev        # http://localhost:3518 (vite, HMR)
bun run check      # oxfmt --check + oxlint --deny-warnings + markdownlint
bun run test       # bun test (0 files expected in app; 34 in river-core)
bun run build      # tsc && vite build → dist/ (PWA 8 entries, manifest.webmanifest)
bun run test:e2e   # playwright test (chromium, via vite preview on 3518)
```

Append `?debug` to attach `@vectojs/devtools` (`attachDevtools(scene)`) and expose `window.__app = { scene, markdown, previewScroll, state, perf }`. Smoke tests assert `auditScene(scene)` returns `[]`.

## Hybrid Shell Contract

- Outer chrome is plain HTML/CSS flex (`#river-header`, `#river-ribbon`).
- Center `#river-stage` hosts `<canvas id="river-canvas">` + `<div id="river-a11y-root">` for the VectoJS `Scene`.
- `Scene` uses `disableWindowResize:true` + `ResizeObserver` on `#river-stage` (see `scribe/src/main.ts:671-700`): `isValidStageSize` guard → `scene.resize(w,h)` → `previewScroll` centered (max 860) → `markdown.setMaxWidth` + `scroll.updateContentSize()`. `disableWindowResize:true` mandatory; window resize owned by observer.
- Stream ticker: `StreamTicker extends Entity` inside Scene onDemand; `hasPendingAnimations = status===streaming`; `tickStream(state, dt)` owns rate/pause; `Markdown.createStream({ incompleteMode: 'optimistic', maxBufferedChars })` handles parsing.
- DropZone, ScrollBar HTML thumb, SearchBar, ContextMenu are HTML overlays; VectoJS owns only `#river-canvas` pixels.

## R2 Assets

Public assets live in `cdn-vectojs` bucket namespace `river/*` (e.g. `river/logo.svg`). Upload with `wrangler r2 object put river/logo.svg --remote` and verify `200` + `content-type`; link `https://cdn.vectojs.org/river/...`. Never commit static copies.

## Roadmap

- CTX-0053 scaffold ✅ — CTX-0054 river-core streaming pipeline ✅ — CTX-0055 Hybrid shell & canvas ✅ — CTX-0056 aux features ✅ — CTX-0057 polish, audit, e2e smoke, docs & handoff ✅
- Next: R2 logo upload, GitHub repo creation (`vectojs/river`), Cloudflare Pages deploy, dark theme, i18n (en only today).

## License

MIT — see `LICENSE` (when published to `github.com/vectojs/river`).

## Accessibility

Header buttons have `aria-label`, search input `aria-label`, context menu `role="menu"` + `role="menuitem"` (separator `role="separator"`), dropzone `role="button"` + `tabindex` toggle via `aria-hidden`, search bar `role="search"`, slider `aria-label="Token rate"`. `en` only; no i18n yet (documented in `river-docs/TODO.md`).

## Reference

- `vectojs-gallery/src/creations/chat/` — Stream Reader product reference (state, parser, AsyncGeneration, pacing).
- `vectojs-native/scribe/` — scaffold template for Hybrid shell, tooling, CI, and PWA pattern.
- `vectojs-docs/forge/findings/` — engine findings (none blocking for River 0.1).
