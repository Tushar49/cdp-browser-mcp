/**
 * Runs a Scenario via either cdp-mcp or playwright-mcp and records metrics.
 *
 * THIS IS A SCAFFOLD. Live runs require:
 * - Real network access
 * - Credentials in env (e.g. LINKEDIN_USER, LINKEDIN_PASS)
 * - Captcha tokens for reCAPTCHA scenarios
 * - A Playwright MCP server alongside our CDP MCP server (for compare mode)
 *
 * For CI: run with --record to capture HAR + screenshots, replay deterministically.
 *
 * See `./README.md` for the full activation plan.
 */
import type { Scenario, RunResult } from './types.js';

export interface RunOptions {
  /** Record a HAR + screenshots for future deterministic replay */
  record?: boolean;
  /** Replay from a previously recorded HAR file */
  replay?: string;
}

export async function runScenario(
  _scenario: Scenario,
  _runner: 'cdp-mcp' | 'playwright-mcp',
  _opts: RunOptions = {},
): Promise<RunResult> {
  throw new Error(
    'Live run not implemented in this session. See BACKLOG E for activation plan.',
  );
}

export interface CompareResult {
  cdp: RunResult;
  playwright: RunResult;
  winner: 'cdp-mcp' | 'playwright-mcp' | 'tie';
  metrics: {
    /** cdp - playwright (negative => cdp used fewer calls) */
    toolCallDelta: number;
    /** cdp - playwright (negative => cdp produced less output) */
    bytesDelta: number;
    /** cdp - playwright (negative => cdp ran faster) */
    durationDelta: number;
  };
}

/**
 * Run BOTH runners on the same scenario and produce a comparison.
 */
export async function compareScenario(_scenario: Scenario): Promise<CompareResult> {
  throw new Error(
    'Live compare not implemented in this session. See BACKLOG E for activation plan.',
  );
}
