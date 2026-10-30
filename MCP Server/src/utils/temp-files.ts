/**
 * Temp-file management extracted from server.js.
 *
 * Screenshots, PDFs, large text output, and HAR dumps are written to
 * a session-scoped temp directory.  The manager auto-cleans old files
 * when the count exceeds a configurable threshold.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'fs';
import { join } from 'path';

// ─── TempFileManager ────────────────────────────────────────────────

export class TempFileManager {
  private readonly tempDir: string;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;

  constructor(config: {
    tempDir: string;
    maxTempFiles: number;
    maxTempAgeMs: number;
  }) {
    this.tempDir = config.tempDir;
    this.maxFiles = config.maxTempFiles;
    this.maxAgeMs = config.maxTempAgeMs;
  }

  // ── public ──────────────────────────────────────────────────────

  /** Ensure the temp directory exists (creates recursively). */
  ensureDir(): void {
    if (!existsSync(this.tempDir)) {
      mkdirSync(this.tempDir, { recursive: true });
    }
  }

  /**
   * Write a file into the temp directory, auto-cleaning old files first.
   *
   * @param name          Base file name (e.g. `"page-1719000000.png"`)
   * @param content       File content (string or Buffer)
   * @param encoding      Node encoding — defaults to `"utf8"`
   * @param sessionPrefix If supplied, the first 8 chars are prepended to the name
   * @returns             Absolute path of the written file
   */
  write(
    name: string,
    content: string | Buffer,
    encoding: BufferEncoding = 'utf8',
    sessionPrefix?: string,
  ): string {
    this.ensureDir();
    this.autoCleanup();

    const fileName = sessionPrefix
      ? `${sessionPrefix.substring(0, 8)}_${name}`
      : name;
    const filePath = join(this.tempDir, fileName);
    writeFileSync(filePath, content, encoding);
    return filePath;
  }

  /**
   * Remove temp files.
   *
   * @param sessionPrefix  If given, only files whose name starts with
   *                       the prefix are deleted.  Otherwise **all** files
   *                       in the temp directory are removed.
   * @returns Number of files deleted.
   */
  cleanup(sessionPrefix?: string): number {
    if (!existsSync(this.tempDir)) return 0;

    const files = readdirSync(this.tempDir);
    let count = 0;

    for (const f of files) {
      if (sessionPrefix && !f.startsWith(sessionPrefix.substring(0, 8)))
        continue;
      try {
        unlinkSync(join(this.tempDir, f));
        count++;
      } catch {
        /* best-effort */
      }
    }
    return count;
  }

  /**
   * Open a STREAMING append writer into the temp directory (5.4 WS11).
   *
   * fd held open for the stream's lifetime (never per-chunk writeFileSync —
   * O(file)); appends are synchronous and single-writer (chunk k completes
   * before k+1 starts). Bytes flow to `<name>.partial` — the file is NEVER
   * advertised as complete until `finalize()` renames it; `abandon()` keeps
   * the `.partial` orphan (discoverable by `clean_temp`, never auto-deleted).
   * A hard size cap (`maxBytes`, default 500MB) aborts with an actionable
   * error rather than filling the user's disk.
   */
  openStreamWriter(
    name: string,
    opts: { sessionPrefix?: string; maxBytes?: number } = {},
  ): TempStreamWriter {
    this.ensureDir();
    this.autoCleanup();
    const fileName = opts.sessionPrefix
      ? `${opts.sessionPrefix.substring(0, 8)}_${name}`
      : name;
    return new TempStreamWriter(join(this.tempDir, fileName), opts.maxBytes ?? 500 * 1024 * 1024);
  }

  /**
   * When the file count exceeds `maxFiles`, remove the oldest files
   * until we're at half the limit **or** they are older than `maxAgeMs`.
   */
  private autoCleanup(): void {
    if (!existsSync(this.tempDir)) return;

    const files = readdirSync(this.tempDir);
    if (files.length <= this.maxFiles) return;

    // Sort by modification time (oldest first)
    const withStats = files
      .map((f) => {
        const p = join(this.tempDir, f);
        try {
          return { path: p, mtime: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Array<{ path: string; mtime: number }>;

    withStats.sort((a, b) => a.mtime - b.mtime);

    const now = Date.now();
    let remaining = files.length;

    for (const { path, mtime } of withStats) {
      if (remaining <= this.maxFiles / 2 && now - mtime < this.maxAgeMs) break;
      try {
        unlinkSync(path);
        remaining--;
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * Streaming append writer for chunked artifacts (heap snapshots, raw traces).
 * fd held open across appends — never a per-chunk writeFileSync (O(file)).
 * The single-writer discipline lives in the caller: append synchronously in
 * the event-dispatch path, chunk k completing before k+1 starts.
 */
export class TempStreamWriter {
  readonly partialPath: string;
  private fd: number;
  private bytes = 0;
  private closed = false;

  constructor(
    readonly finalPath: string,
    private readonly maxBytes: number,
  ) {
    this.partialPath = `${finalPath}.partial`;
    this.fd = openSync(this.partialPath, 'a');
  }

  /** Current bytes appended. */
  get byteCount(): number {
    return this.bytes;
  }

  /**
   * Append one chunk synchronously. Throws ACTIONABLY on cap overrun — the
   * .partial orphan remains on disk (clean_temp discovers it).
   */
  write(chunk: string | Buffer): void {
    if (this.closed) throw new Error('TempStreamWriter is closed');
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (this.bytes + buf.length > this.maxBytes) {
      throw new Error(`Temp-file size cap reached (${(this.maxBytes / 1048576).toFixed(0)}MB) — aborting the artifact; it stays on disk as a *.partial file (clean_temp removes it).`);
    }
    writeSync(this.fd, buf);
    this.bytes += buf.length;
  }

  /** Close + atomically rename *.partial → the final path; returns it. */
  finalize(): string {
    if (this.closed) return this.finalPath;
    closeSync(this.fd);
    this.closed = true;
    renameSync(this.partialPath, this.finalPath);
    return this.finalPath;
  }

  /**
   * Close and KEEP the *.partial orphan on disk (never advertised complete).
   * Idempotent; call on errors or session death.
   */
  abandon(): void {
    if (this.closed) return;
    closeSync(this.fd);
    this.closed = true;
  }
}
