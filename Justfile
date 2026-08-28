default:
    @just --list

dev:
    bun run dev

verify:
    @bun run format:check
    @bun run lint
    @bun run test
    @bun run build

build:
    bun run build

check:
    bun run check

e2e:
    # smoke e2e requires built dist; build if missing
    if [ ! -f dist/index.html ]; then bun run build; fi
    bun run test:e2e

preview:
    bun run preview
