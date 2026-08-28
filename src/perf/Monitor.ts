/**
 * PerfMonitor — frame / memory telemetry for the streaming benchmark panel.
 *
 * Every rate and cost here is **read from the engine**, not re-derived. Core
 * already measures the same quantities on the render loop it owns
 * (`Scene.frameStats`), so a second estimate maintained out here can only drift
 * from the thing it is trying to report — and it did: this module used to keep
 * its own EMA over `1000 / dt` sampled from `update()`, seeded at a literal 60.
 *
 * Two consequences of that seed, both of which showed on screen:
 *
 * - An `onDemand` scene parks between renders. Every idle gap exceeded the
 *   module's own idle threshold and was discarded, so a panel opened but never
 *   streamed reported the seed verbatim — a hardcoded `60` presented as a
 *   measurement, on a display that may run at any rate.
 * - The peak was a running max that never decayed, so a single coalesced
 *   sub-millisecond frame ratcheted it permanently and dragged the derived
 *   refresh interval and CPU proxy with it.
 *
 * What is measured where:
 *
 * - `fps` / `frameMs` / `frameIntervalMs` come from {@link FrameStats}. `fps` is
 *   the cadence of *rendered* frames and `frameTimeMs` is the wall-clock cost of
 *   the last `render()` pass, so neither is a reciprocal of the other and a
 *   cheap frame on a parked scene no longer reads as a fast one.
 * - `displayHz` is calibrated separately by counting raw `requestAnimationFrame`
 *   ticks, because no engine field can carry it: `frameStats.fps` reports redraw
 *   cadence, and an `onDemand` scene deliberately redraws less often than the
 *   display refreshes. Reporting the panel's real capability needs the rAF rate
 *   itself.
 *
 * Memory is `performance.memory` (Chrome only, non-standard); absent elsewhere
 * and reported as `NaN` rather than a fabricated number.
 */

import type { Scene } from '@vectojs/core';

export interface PerfSample {
  /**
   * Rendered-frame cadence in Hz, or `NaN` before the engine has timed a pair
   * of frames.
   *
   * `NaN` rather than a placeholder integer: the panel renders it as `—`, which
   * is honest about having nothing to report yet. Any stand-in number here is
   * indistinguishable on screen from a real reading.
   */
  fps: number;
  /**
   * Scene loop mode, sampled every frame.
   *
   * Threaded into the panel so FPS health can stay neutral on a parked
   * `onDemand` scene (low fps is correct idle behaviour there, not a stall).
   * Sampled per frame rather than captured once because the shell flips the
   * mode when mounting/unmounting creations.
   */
  renderMode: 'always' | 'onDemand';
  /**
   * Measured display refresh rate in Hz from the rAF calibration, or `NaN`
   * until it completes.
   *
   * Reported alongside `fps` because on an `onDemand` scene the two legitimately
   * differ — a parked scene rendering 4 times a second on a 240Hz panel is
   * correct behaviour, not a stall, and only showing both makes that legible.
   */
  displayHz: number;
  /**
   * Latest measured rAF cadence in Hz, or `NaN` until the first window closes.
   *
   * {@link displayHz} is what the panel CAN do; this is what the page is getting.
   * They diverge when the main thread is saturated — measured 240.2 Hz idle
   * against 8.3 Hz under a ~120 ms/frame block, with focus untouched — and that
   * gap is the only starvation signal a page can honestly show, since
   * `document.hasFocus()` and `visibilityState` read the same in both cases.
   */
  rafHz: number;
  /** Wall-clock cost of the last render pass in ms, or `NaN` before the first. */
  frameMs: number;
  /** Smoothed interval between rendered frames in ms, or `NaN` before the first. */
  frameIntervalMs: number;
  /** JS heap used in MB (Chrome only, else `NaN`). */
  heapUsedMB: number;
  /** Heap limit in MB (Chrome only, else `NaN`). */
  heapLimitMB: number;
  /**
   * Render cost as a fraction of one display refresh interval (`1.0` ≈ a whole
   * interval spent rendering), or `NaN` until both inputs are known.
   *
   * Measured against the calibrated display rate, never a hardcoded 60: on a
   * 240Hz panel a 4ms frame is 96% of the budget, while against an assumed 60Hz
   * it would read as a comfortable 24% and hide the stall. Not an OS CPU
   * percentage — a real one needs `Worker` + `SharedArrayBuffer` or the DevTools
   * protocol.
   */
  cpuProxy: number;
}

/**
 * rAF ticks per measurement window.
 *
 * Enough to average out compositor jitter without making the field stay blank
 * long enough to look broken; at 60Hz a window closes in about a second, faster
 * on a high-refresh panel.
 */
const CALIBRATION_FRAMES = 60;

/**
 * Counts raw `requestAnimationFrame` ticks, continuously, in windows.
 *
 * Deliberately independent of the scene's loop. The engine throttles and skips
 * redraws by design, so measuring redraws cannot recover the panel's rate; this
 * runs its own chain of rAF callbacks.
 *
 * It keeps measuring rather than latching one reading, and that is the point.
 * Until 2026-08-05 calibration ran ONCE from the `PerfMonitor` constructor, set
 * `running = false`, and never ran again — so `DISPLAY` was a reading taken at
 * startup and then asserted for the rest of the session. That is wrong exactly
 * when it matters most: **a saturated main thread depresses rAF cadence
 * indistinguishably from an unfocused window.** Measured with the window focused
 * on its own workspace throughout (`hasFocus: true`, `visibilityState:
 * 'visible'` at every sample):
 *
 *     idle                                  240.2 Hz
 *     main thread blocked ~120 ms/frame       8.3 Hz
 *     after the block is released           240.2 Hz
 *
 * Nothing touched focus. So a panel that calibrated while its own document was
 * busy would report `DISPLAY 8 Hz` forever, and — because {@link PerfSample.fps}
 * is scored as a ratio against it — a genuinely bad frame rate would then be
 * coloured green for matching it.
 *
 * Two rates are therefore reported, because one number cannot carry both facts:
 *
 * - {@link hz} is the panel's *capability*: the fastest window observed. rAF
 *   cannot exceed vsync under default settings, so contention can only ever pull
 *   a window BELOW the true rate — never above it — which makes the maximum the
 *   correct estimator and makes it converge from below as soon as one window
 *   lands on an idle stretch.
 * - {@link currentHz} is the *latest* window: what the page is actually getting
 *   right now. A large gap between the two is starvation, and it is the one
 *   signal a page can legitimately show for it, since `hasFocus()` and
 *   `visibilityState` are unchanged in both the busy and the unfocused case.
 */
export class RefreshRateProbe {
  private frames = 0;
  private startTime = 0;
  private _hz = NaN;
  private _currentHz = NaN;
  private rafId = 0;
  private running = false;

  /**
   * The panel's measured refresh capability in Hz — the fastest window seen — or
   * `NaN` until the first window closes.
   */
  get hz(): number {
    return this._hz;
  }

  /**
   * The most recent window's rAF cadence in Hz, or `NaN` until the first closes.
   *
   * Well below {@link hz} means the page is not receiving frames at the rate the
   * display offers: a busy main thread, or a window the compositor has stopped
   * sending frame callbacks to.
   */
  get currentHz(): number {
    return this._currentHz;
  }

  start(): void {
    if (this.running || typeof requestAnimationFrame !== 'function') return;
    this.running = true;
    this.frames = 0;
    this.startTime = 0;
    const tick = (now: number): void => {
      if (!this.running) return;
      if (this.startTime === 0) {
        // The first callback of a window only establishes the origin — no
        // interval has been observed yet, so counting it would divide by one
        // fewer gap than the frames imply and over-report the rate.
        this.startTime = now;
      } else {
        this.frames++;
        if (this.frames >= CALIBRATION_FRAMES) {
          const elapsed = now - this.startTime;
          if (elapsed > 0) {
            const windowHz = (this.frames * 1000) / elapsed;
            this._currentHz = windowHz;
            // Max, not last: see the class docstring. Contention only ever
            // depresses a window, so the fastest one seen is the best estimate
            // of what the display can actually do.
            this._hz = Number.isFinite(this._hz) ? Math.max(this._hz, windowHz) : windowHz;
          }
          // Open the next window instead of stopping.
          this.frames = 0;
          this.startTime = 0;
        }
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** Stops measuring; keeps every rate already measured. */
  stop(): void {
    this.running = false;
    if (this.rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = 0;
  }
}

/** Rounds to one decimal place for display. */
function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : NaN;
}

export class PerfMonitor {
  private probe = new RefreshRateProbe();

  constructor() {
    this.probe.start();
  }

  /** Stops the refresh-rate calibration. Safe to call more than once. */
  destroy(): void {
    this.probe.stop();
  }

  /**
   * Builds a sample from the scene's own telemetry.
   *
   * Takes the `Scene` rather than a timestamp because there is nothing left to
   * time out here — the engine has already measured it on the loop that did the
   * work.
   */
  sample(scene: Scene): PerfSample {
    const stats = scene.frameStats;
    const mem = (
      performance as Performance & {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;

    // `frameStats` reports 0 for "not yet measured" on all three of these.
    // Passing that through would show a real 0 fps / 0 ms frame, so it is
    // mapped to NaN and rendered as `—`.
    const fps = stats.fps > 0 ? stats.fps : NaN;
    const frameMs = stats.frameTimeMs > 0 ? stats.frameTimeMs : NaN;
    const frameIntervalMs = stats.frameIntervalMs > 0 ? stats.frameIntervalMs : NaN;

    const displayHz = this.probe.hz;
    const cpuProxy =
      Number.isFinite(frameMs) && Number.isFinite(displayHz) && displayHz > 0
        ? frameMs / (1000 / displayHz)
        : NaN;

    return {
      fps: round1(fps),
      renderMode: stats.renderMode,
      displayHz: round1(displayHz),
      rafHz: round1(this.probe.currentHz),
      frameMs: round1(frameMs),
      frameIntervalMs: round1(frameIntervalMs),
      heapUsedMB: mem ? mem.usedJSHeapSize / 1_048_576 : NaN,
      heapLimitMB: mem ? mem.jsHeapSizeLimit / 1_048_576 : NaN,
      cpuProxy: Number.isFinite(cpuProxy) ? Math.round(cpuProxy * 100) / 100 : NaN,
    };
  }
}
