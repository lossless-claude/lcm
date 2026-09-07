/**
 * Lifecycle orchestrator for the ninja CLI renderer.
 * Manages the render loop, SIGINT/SIGWINCH handlers, and session iteration.
 */

import type { ProgressState } from './progress-state.js';
import { renderFrame, FRAME_LINES, type RenderOpts } from './render-frame.js';
import { printSummary } from './render-summary.js';

export interface PipelineRunnerOpts {
  state: ProgressState;
  renderOpts: RenderOpts;
  /** Called once the runner has started (before session iteration begins) */
  onReady?: () => void;
}

/**
 * NinjaRenderer — manages the live display lifecycle.
 *
 * Usage:
 *   const renderer = new NinjaRenderer({ state, renderOpts });
 *   renderer.start();
 *   // ... mutate state ...
 *   renderer.sessionDone(lastResult);  // emit non-TTY/verbose line
 *   renderer.stop();                   // stop render loop
 *   renderer.printSummary();
 */
export class NinjaRenderer {
  private state: ProgressState;
  private opts: RenderOpts;
  private intervalId?: ReturnType<typeof setInterval>;
  private firstFrame = true;
  private sigintHandler?: () => void;
  private sigtermHandler?: () => void;
  private sigwinchHandler?: () => void;
  private inFlight = 0;
  private drainWaiter: (() => void) | null = null;
  private signalReceived: { code: number } | null = null;

  constructor(opts: PipelineRunnerOpts) {
    this.state = opts.state;
    this.opts = opts.renderOpts;
  }

  /**
   * Mark an in-flight unit of work (e.g. a /compact request). The first signal
   * waits for in-flight work to finish before exiting, so a killed run never
   * leaves a session half-recorded — resume either sees it done or redoes it.
   * A second signal exits at once, so a hung request can still be interrupted.
   * Returns a release function; call it when the work settles.
   */
  trackInFlight(): () => void {
    this.inFlight++;
    return () => {
      this.inFlight--;
      if (this.inFlight === 0 && this.drainWaiter) {
        const waiter = this.drainWaiter;
        this.drainWaiter = null;
        waiter();
      }
    };
  }

  /** True after SIGINT/SIGTERM — loops should stop starting new work. */
  get shouldStop(): boolean {
    return this.state.aborted === true;
  }

  private _waitForInFlight(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.drainWaiter = resolve;
    });
  }

  private _onSignal(code: number): void {
    if (this.signalReceived) {
      // Second signal: stop waiting for the drain and exit now.
      this.stop();
      process.exit(code);
      return;
    }
    this.signalReceived = { code };
    this.state.aborted = true;
    void this._waitForInFlight().then(() => {
      this.stop();
      this.printSummary();
      process.exit(code);
    });
  }

  /** Start the render loop and register signal handlers. */
  start(): void {
    const { isTTY, verbose } = this.opts;

    // Register SIGWINCH to update terminal width
    this.sigwinchHandler = () => {
      this.opts.width = process.stdout.columns ?? 80;
    };
    process.on('SIGWINCH', this.sigwinchHandler);

    // SIGINT/SIGTERM: let in-flight work finish (or be marked incomplete)
    // before exiting, so a resumed run doesn't duplicate or skip it.
    // A repeated signal exits immediately.
    this.sigintHandler = () => this._onSignal(130);
    process.on('SIGINT', this.sigintHandler);
    this.sigtermHandler = () => this._onSignal(143);
    process.on('SIGTERM', this.sigtermHandler);

    if (isTTY && !verbose) {
      // Emit blank lines to reserve space for the 3-line frame
      process.stdout.write('\n\n\n');
      this.firstFrame = false;

      // 16 fps render loop
      this.intervalId = setInterval(() => {
        this._writeFrame();
      }, 62);
    }
  }

  /** Stop the render loop and remove signal handlers. */
  stop(): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    if (this.sigintHandler) {
      process.removeListener('SIGINT', this.sigintHandler);
      this.sigintHandler = undefined;
    }
    if (this.sigtermHandler) {
      process.removeListener('SIGTERM', this.sigtermHandler);
      this.sigtermHandler = undefined;
    }
    if (this.sigwinchHandler) {
      process.removeListener('SIGWINCH', this.sigwinchHandler);
      this.sigwinchHandler = undefined;
    }
    // Write one final frame to reflect the completed state
    if (this.opts.isTTY && !this.opts.verbose) {
      this._writeFrame();
    }
  }

  /**
   * Called when a session finishes.
   * In non-TTY or verbose mode, emits a log line.
   * In TTY non-verbose, the render loop handles it.
   */
  sessionDone(): void {
    const { isTTY, verbose } = this.opts;
    if (!isTTY || verbose) {
      const line = renderFrame(this.state, this.opts, 0);
      if (line) process.stdout.write(line);
    }
  }

  /** Print the final summary. */
  printSummary(): void {
    // In TTY non-verbose mode we need to move past the live frame
    if (this.opts.isTTY && !this.opts.verbose) {
      process.stdout.write('\n');
    }
    printSummary(this.state, this.opts);
  }

  /** Update the render opts (e.g. after SIGWINCH) */
  updateOpts(patch: Partial<RenderOpts>): void {
    Object.assign(this.opts, patch);
  }

  private _writeFrame(): void {
    const frame = renderFrame(this.state, this.opts, this.firstFrame ? 0 : FRAME_LINES);
    this.firstFrame = false;
    if (frame) process.stdout.write(frame);
  }
}
