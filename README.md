# River — Streaming Markdown Reader

LLM-typewriter-inspired streaming markdown reader built as a VectoJS forge. Hybrid shell: traditional HTML chrome (header with file name + save status + controls placeholder, optional 48px ribbon) wrapping a VectoJS canvas core (`#river-canvas` + `#river-a11y-root`).

- **Family**: `vectojs-native/river/` (container; each child is its own git repo).
- **Deployed**: <https://river.vectojs.org> (Cloudflare Pages, `river` project).
- **Gallery Stream Reader reference**: `vectojs-gallery/src/creations/chat/` — drop a `.md`/`.txt` and replay at adjustable rate with `@vectojs/markdown createStream`.

## Tech Stack

- `bun` + `vite` + `typescript` (strict)
- `@vectojs/core` 1.39.1, `@vectojs/markdown` 0.23.1, `@vectojs/styles` 0.3.3, `@vectojs/ui` 2.20.2 (exact-pinned, never `workspace:*`)
- `oxfmt` / `oxlint` / `biome` / `markdownlint-cli2` / `lefthook`

## Development

```bash
bun install
bun run dev        # http://localhost:3518
bun run check      # format:check + lint + lint:md
bun run test
bun run build
```

Append `?debug` to attach `@vectojs/devtools` and expose `window.__app = { scene, markdown, scroll }`.

## Layout

- Outer chrome is plain HTML/CSS flex (`#river-header`, `#river-ribbon`).
- Center `#river-stage` hosts `<canvas id="river-canvas">` + `<div id="river-a11y-root">` for the VectoJS `Scene`.
- `Scene` uses `disableWindowResize:true` + `ResizeObserver` on `#river-stage` (see `scribe/src/main.ts:671-700`).

## R2 Assets

Public assets live in `cdn-vectojs` bucket namespace `river/*` (e.g. `river/logo.svg`). Upload with `wrangler r2 object put river/logo.svg --file=... --remote` and verify `200` + `content-type`; link `https://cdn.vectojs.org/river/...`.

## Roadmap

- CTX-0053 scaffold (this) → CTX-0054 river-core streaming pipeline → CTX-0055 Hybrid shell & canvas integration → CTX-0056 auxiliary features → CTX-0057 polish, audit, e2e.
