import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseBrowserCommandLine,
  scanBrowserProcesses,
  discoverBrowserInstances,
} from '../../connection/browser-discovery.js';

describe('parseBrowserCommandLine()', () => {
  it('extracts flags from a portable Brave launch line', () => {
    const info = parseBrowserCommandLine(
      "A:\\Programs\\Browsers\\brave-portable\\app\\brave.exe --user-data-dir=A:\\Programs\\Browsers\\brave-portable\\data --disable-brave-update --remote-debugging-port=9222",
    );
    expect(info.browserName).toBe('brave');
    expect(info.userDataDir).toBe('A:\\Programs\\Browsers\\brave-portable\\data');
    expect(info.port).toBe(9222);
  });

  it('handles double-quoted paths with spaces', () => {
    const info = parseBrowserCommandLine(
      '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Users\\A B\\Chrome Debug" --remote-debugging-port=9223',
    );
    expect(info.browserName).toBe('chrome');
    expect(info.userDataDir).toBe('C:\\Users\\A B\\Chrome Debug');
    expect(info.port).toBe(9223);
  });

  it('handles single-quoted paths', () => {
    const info = parseBrowserCommandLine(
      "brave.exe --user-data-dir='A:\\dir with spaces' --remote-debugging-port=9222",
    );
    expect(info.userDataDir).toBe('A:\\dir with spaces');
  });

  it('toggle-mode launch line: dir present, port absent', () => {
    const info = parseBrowserCommandLine(
      'brave.exe --user-data-dir=A:\\portable\\data --disable-brave-update',
    );
    expect(info.userDataDir).toBe('A:\\portable\\data');
    expect(info.port).toBeUndefined();
  });

  it('ignores non-browser processes', () => {
    const info = parseBrowserCommandLine('notepad.exe --some-flag');
    expect(info.browserName).toBeUndefined();
    expect(info.userDataDir).toBeUndefined();
  });

  it('recognizes browser variants (msedge, chrome-beta)', () => {
    expect(
      parseBrowserCommandLine('msedge.exe --remote-debugging-port=9222').browserName,
    ).toBe('msedge');
    expect(
      parseBrowserCommandLine('chrome-beta.exe --remote-debugging-port=9222')
        .browserName,
    ).toBe('chrome');
  });
});

describe('scanBrowserProcesses()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aggregates dirs/ports/browsers and never returns raw command lines', async () => {
    const fakeOutput = [
      'brave.exe --user-data-dir=A:\\p\\data --remote-debugging-port=9222',
      '',
      'chrome.exe --user-data-dir=C:\\ud',
      'notepad.exe --x',
    ].join('\n');

    const result = await scanBrowserProcesses({
      os: 'linux',
      runner: async () => fakeOutput,
    });

    expect(result.userDataDirs).toEqual(['A:\\p\\data', 'C:\\ud']);
    expect(result.ports).toEqual([9222]);
    expect(result.browsersRunning.sort()).toEqual(['brave', 'chrome']);
    // Privacy rule: raw command lines never appear in the result
    expect(JSON.stringify(result)).not.toContain('--user-data-dir=');
    expect(JSON.stringify(result)).not.toContain('--disable');
  });

  it('returns empty (non-fatal) when the runner fails', async () => {
    const result = await scanBrowserProcesses({
      os: 'win32',
      runner: async () => {
        throw new Error('powershell unavailable');
      },
    });
    expect(result).toEqual({ userDataDirs: [], ports: [], browsersRunning: [] });
  });

  it('windows path uses powershell with a browser filter', async () => {
    let captured: { file: string; args: string[] } | null = null;
    await scanBrowserProcesses({
      os: 'win32',
      runner: async (file, args) => {
        captured = { file, args };
        return '';
      },
    });
    expect(captured!.file).toBe('powershell.exe');
    expect(captured!.args.join(' ')).toContain('Win32_Process');
    expect(captured!.args.join(' ')).toContain('brave.exe');
  });

  it('posix path uses ps', async () => {
    let captured: { file: string } | null = null;
    await scanBrowserProcesses({
      os: 'linux',
      runner: async (file) => {
        captured = { file };
        return '';
      },
    });
    expect(captured!.file).toBe('ps');
  });
});

describe('discoverBrowserInstances() with extraPaths', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeInstanceDir(port: number, wsPath: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'cdp-discovery-'));
    writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n${wsPath}\n`);
    dirs.push(dir);
    return dir;
  }

  it('reads an approval-mode port file (port + ws path) from an extra dir', () => {
    const dir = makeInstanceDir(9223, '/devtools/browser/b691cb61-test');
    const instances = discoverBrowserInstances({ extraPaths: [dir] });
    expect(instances).toHaveLength(1);
    expect(instances[0].port).toBe(9223);
    expect(instances[0].wsUrl).toBe('ws://127.0.0.1:9223/devtools/browser/b691cb61-test');
    expect(instances[0].userDataDir).toBe(dir);
  });

  it('extra dirs are checked before platform candidates', () => {
    const dir = makeInstanceDir(9300, '/devtools/browser/first');
    const instances = discoverBrowserInstances({ extraPaths: [dir] });
    // The temp dir instance must be first regardless of platform candidates
    expect(instances[0].port).toBe(9300);
  });
});
