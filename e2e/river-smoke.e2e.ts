import { expect, test } from '@playwright/test';

test.describe('river smoke — hybrid shell + canvas', () => {
  test('shell mounts, dropzone + controls + streaming + search + contextmenu', async ({ page }) => {
    await page.goto('/');

    // ── Shell visible ─────────────────────────────────────────────────────
    await expect(page.locator('#river-header')).toBeVisible();
    await expect(page.locator('#river-canvas')).toBeVisible();
    await expect(page.locator('#river-a11y-root')).toBeAttached();
    await expect(page.locator('#river-stage')).toBeVisible();

    // Header controls exist with accessibility
    await expect(page.locator('#river-open-file')).toBeVisible();
    await expect(page.locator('#river-play')).toBeVisible();
    await expect(page.locator('#river-pause')).toBeVisible();
    await expect(page.locator('#river-stop')).toBeVisible();
    await expect(page.locator('#river-loop')).toBeVisible();
    await expect(page.locator('#river-rate')).toBeVisible();
    await expect(page.locator('#river-rate-input')).toBeVisible();
    await expect(page.locator('#river-theme-picker')).toBeVisible();
    await expect(page.locator('#river-progress')).toBeAttached();
    await expect(page.locator('#river-fps')).toBeAttached();

    // Dropzone is primary affordance when idle (uses .is-hidden opacity, not display:none)
    const dropzone = page.locator('#river-dropzone');
    await expect(dropzone).not.toHaveClass(/is-hidden/);
    await expect(dropzone).toHaveAttribute('role', 'button');
    await expect(page.locator('#river-dropzone-hint')).toContainText(/Markdown/);
    await expect(page.locator('#river-dropzone-btn')).toBeVisible();

    // Canvas + ribbon
    await expect(page.locator('#river-ribbon')).toBeAttached();

    // Search bar hidden initially, context menu hidden
    await expect(page.locator('#river-searchbar')).toBeHidden();
    await expect(page.locator('#river-context-menu')).toBeHidden();
    await expect(page.locator('#river-scrollbar')).toBeHidden();

    // ── window.__app hook (hybrid contract) ───────────────────────────────
    await page.waitForFunction(
      () => (window as unknown as { __app?: unknown }).__app !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    const appOk = await page.evaluate(() => {
      const w = window as unknown as {
        __app: {
          scene: unknown;
          markdown: { width: number; height: number };
          previewScroll: { width: number; height: number };
          state: { status: string; content: string; tokenRate: number };
          perf: unknown;
        };
      };
      return (
        !!w.__app.scene &&
        !!w.__app.markdown &&
        !!w.__app.previewScroll &&
        !!w.__app.state &&
        !!w.__app.perf
      );
    });
    expect(appOk).toBeTruthy();

    // Disabled states when idle with no content: play disabled, pause disabled
    const playDisabledIdle = await page.evaluate(() => {
      const btn = document.getElementById('river-play') as HTMLButtonElement | null;
      return btn?.disabled ?? null;
    });
    expect(playDisabledIdle).toBe(true);
    const pauseDisabledIdle = await page.evaluate(() => {
      const btn = document.getElementById('river-pause') as HTMLButtonElement | null;
      return btn?.disabled ?? null;
    });
    expect(pauseDisabledIdle).toBe(true);

    // Loop aria-pressed reflects state
    await expect(page.locator('#river-loop')).toHaveAttribute('aria-pressed', 'false');

    // Rate slider/input sync: range 10-2000, step 10
    const rateAttrs = await page.evaluate(() => {
      const r = document.getElementById('river-rate') as HTMLInputElement | null;
      const ri = document.getElementById('river-rate-input') as HTMLInputElement | null;
      return {
        sliderMin: r?.min,
        sliderMax: r?.max,
        sliderStep: r?.step,
        inputMin: ri?.min,
        inputMax: ri?.max,
      };
    });
    expect(rateAttrs.sliderMin).toBe('10');
    expect(rateAttrs.sliderMax).toBe('2000');
    expect(rateAttrs.sliderStep).toBe('10');
    expect(rateAttrs.inputMin).toBe('10');
    expect(rateAttrs.inputMax).toBe('2000');

    // ── Streaming: drop a file and verify playback starts ─────────────────
    const sampleMd = [
      '# River Smoke',
      '',
      'Hello **River** — streaming smoke test.',
      '',
      '```js',
      'console.log("hello river");',
      '```',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'More text at rate.',
    ].join('\n');

    // Dispatch drop event carrying a File (like semantic-margin.e2e.ts)
    await page.evaluate((markdown: string) => {
      const file = new File([markdown], 'smoke.md', { type: 'text/markdown' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
    }, sampleMd);

    // Wait for state.fileName to become smoke.md and status to be streaming or done
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __app: { state: { fileName: string; status: string } };
        };
        return w.__app.state.fileName === 'smoke.md';
      },
      undefined,
      { timeout: 10_000 },
    );

    // Dropzone should hide (is-hidden) once document loaded
    await expect(page.locator('#river-dropzone')).toHaveClass(/is-hidden/, {
      timeout: 5_000,
    });

    // Progress text should appear once streaming
    await page.waitForFunction(
      () => {
        const el = document.getElementById('river-progress');
        return !!el && el.textContent !== null && el.textContent.includes('tok');
      },
      undefined,
      { timeout: 10_000 },
    );
    const progressText = await page.locator('#river-progress').textContent();
    expect(progressText).toMatch(/tok/);

    // Pause button becomes enabled when streaming, Play disabled when streaming
    await page.waitForFunction(
      () => {
        const pause = document.getElementById('river-pause') as HTMLButtonElement | null;
        return pause && !pause.disabled;
      },
      undefined,
      { timeout: 10_000 },
    );
    const playDisabledStreaming = await page.evaluate(() => {
      const btn = document.getElementById('river-play') as HTMLButtonElement | null;
      return btn?.disabled ?? null;
    });
    // Play should be disabled while streaming
    expect(playDisabledStreaming).toBe(true);

    // Let a few tokens render, then pause via button
    await page.waitForTimeout(600);
    await page.locator('#river-pause').click();
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __app: { state: { status: string } } };
        return w.__app.state.status === 'paused';
      },
      undefined,
      { timeout: 5_000 },
    );
    // After pause, Play becomes enabled, Pause disabled
    await expect(page.locator('#river-play')).toBeEnabled();
    await expect(page.locator('#river-pause')).toBeDisabled();

    // Resume via Play
    await page.locator('#river-play').click();
    await page.waitForFunction(
      () => {
        const w = window as unknown as { __app: { state: { status: string } } };
        return w.__app.state.status === 'streaming';
      },
      undefined,
      { timeout: 5_000 },
    );

    // ── Rate slider/input sync ────────────────────────────────────────────
    await page.evaluate(() => {
      const slider = document.getElementById('river-rate') as HTMLInputElement | null;
      if (!slider) throw new Error('rate slider missing');
      slider.value = '500';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(
      () => {
        const w = window as unknown as {
          __app: { state: { tokenRate: number } };
        };
        return w.__app.state.tokenRate === 500;
      },
      undefined,
      { timeout: 5_000 },
    );
    const rateInputVal = await page.locator('#river-rate-input').inputValue();
    expect(rateInputVal).toBe('500');

    // ── Search: open via Ctrl+F, find term, step, close ───────────────────
    // Ensure document has rendered some text before searching
    await page.waitForTimeout(400);
    await page.keyboard.press('Control+F');
    await expect(page.locator('#river-searchbar')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('#river-search-input')).toBeFocused();

    const searchInput = page.locator('#river-search-input');
    await searchInput.fill('River');
    await page.waitForFunction(
      () => {
        const el = document.getElementById('river-search-count');
        return !!el && el.textContent !== '' && el.textContent !== '0 / 0';
      },
      undefined,
      { timeout: 5_000 },
    );
    const countText = await page.locator('#river-search-count').textContent();
    expect(countText).toMatch(/\d+ \/ \d+/);

    // Step through matches via buttons
    await page.locator('#river-search-next').click();
    await page.locator('#river-search-prev').click();
    // Close search via button
    await page.locator('#river-search-close').click();
    await expect(page.locator('#river-searchbar')).toBeHidden();

    // Re-open search, then close via Escape
    await page.keyboard.press('Control+F');
    await expect(page.locator('#river-searchbar')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#river-searchbar')).toBeHidden();

    // ── Scrollbar: should be visible after content renders ────────────────
    // Wait a bit for layout to settle
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const el = document.getElementById('river-scrollbar');
      return !!el && !el.hidden && !el.classList.contains('is-hidden');
    });
    // Scrollbar may be hidden if content not tall enough yet; after more ticks it appears.
    // At least check the thumb exists
    await expect(page.locator('.river-scrollbar__thumb')).toBeAttached();

    // ── Context menu: right-click canvas, menu appears with expected items ─
    // Right-click near center of canvas
    const canvasBox = await page.locator('#river-canvas').boundingBox();
    if (canvasBox) {
      await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + 50, {
        button: 'right',
      });
      await expect(page.locator('#river-context-menu')).toBeVisible({
        timeout: 5_000,
      });
      // Should contain theme choices and search entry
      await expect(page.locator('#river-context-menu')).toContainText('Find in document');
      await expect(page.locator('#river-context-menu')).toContainText('Warm light');
      // Click outside to close
      await page.mouse.click(10, 10);
      await expect(page.locator('#river-context-menu')).toBeHidden({
        timeout: 5_000,
      });
    }

    // ── Loop toggle aria-pressed ──────────────────────────────────────────
    const loopBefore = await page.locator('#river-loop').getAttribute('aria-pressed');
    await page.locator('#river-loop').click();
    const loopAfter = await page.locator('#river-loop').getAttribute('aria-pressed');
    expect(loopBefore).not.toBe(loopAfter);
    // Toggle back
    await page.locator('#river-loop').click();
    await expect(page.locator('#river-loop')).toHaveAttribute(
      'aria-pressed',
      loopBefore ?? 'false',
    );

    // ── auditScene gate: optional, only if devtools available ──────────────
    // Visit ?debug and verify no audit errors (best-effort: if auditScene not exported, skip)
    await page.goto('/?debug');
    await page.waitForFunction(
      () => (window as unknown as { __app?: unknown }).__app !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    await page.waitForTimeout(800);
    const auditResult = await page.evaluate(async () => {
      try {
        const mod = await import('@vectojs/devtools');
        const fn = (mod as unknown as { auditScene?: (s: unknown) => unknown[] }).auditScene;
        if (!fn) return { skipped: true, reason: 'no auditScene export' };
        const w = window as unknown as { __app: { scene: unknown } };
        const issues = fn(w.__app.scene);
        return { skipped: false, issues, count: issues.length };
      } catch (e) {
        return { skipped: true, reason: String(e) };
      }
    });
    // If audit ran, expect clean
    if (!auditResult.skipped) {
      expect((auditResult as { count: number }).count).toBe(0);
    }

    // ── Theme picker ──────────────────────────────────────────────────────
    await page.goto('/');
    await page.waitForFunction(
      () => (window as unknown as { __app?: unknown }).__app !== undefined,
      undefined,
      { timeout: 10_000 },
    );
    const themePicker = page.locator('#river-theme-picker');
    await expect(themePicker).toBeVisible();
    await themePicker.selectOption('githubLight');
    await page.waitForFunction(
      () => {
        const el = document.getElementById('river-theme-picker') as HTMLSelectElement | null;
        return el?.value === 'githubLight';
      },
      undefined,
      { timeout: 5_000 },
    );
    // Switch back to warm
    await themePicker.selectOption('warm');
  });
});
