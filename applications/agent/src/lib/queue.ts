import fs from 'node:fs';
import path from 'node:path';

/**
 * A local, append-only line queue for samples the ingest endpoint hasn't accepted yet.
 * Bounded (`maxLines`, FIFO-evict-oldest) so a long outage degrades to
 * "lost the oldest minutes" instead of an unbounded file - see
 * `config.queue.maxLines` for the exact number and why.
 */
export class SampleQueue {
  private readonly filePath: string;
  private readonly maxLines: number;

  constructor(stateDir: string, maxLines: number) {
    this.filePath = path.join(stateDir, 'queue.jsonl');
    this.maxLines = maxLines;
  }

  /** Reads every queued line, oldest first. Corrupt lines are dropped, not fatal to the rest. */
  readAll(): string[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs
      .readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
  }

  /** Replaces the queue file contents with exactly these lines (used after a partial flush). */
  replaceAll(lines: readonly string[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (lines.length === 0) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${lines.join('\n')}\n`);
    fs.renameSync(tmpPath, this.filePath);
  }

  /** Appends one line, evicting the oldest queued line(s) first if that would exceed `maxLines`. */
  push(line: string): void {
    const existing = this.readAll();
    const next = [...existing, line];
    const overflow = next.length - this.maxLines;
    this.replaceAll(overflow > 0 ? next.slice(overflow) : next);
  }

  get size(): number {
    return this.readAll().length;
  }
}
