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
  private sigwinchHandler?: () => void;

  constructor(opts: PipelineRunnerOpts) {
    this.state = opts.state;
    this.opts = opts.renderOpts;
  }

  /** Start the render loop and register signal handlers. */
  start(): void {
    const { isTTY, verbose } = this.opts;

    // Register SIGWINCH to update terminal width
    this.sigwinchHandler = () => {
      this.opts.width = process.stdout.columns ?? 80;
    };
    process.on('SIGWINCH', this.sigwinchHandler);

    // Register SIGINT for clean partial summary
    this.sigintHandler = () => {
      this.state.aborted = true;
      this.stop();
      this.printSummary();
      process.exit(130);
    };
    process.on('SIGINT', this.sigintHandler);

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
