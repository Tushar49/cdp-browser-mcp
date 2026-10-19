/**
 * Shared types for the agent test suite.
 *
 * Scenarios are declarative data: they describe WHAT to do on a tough site,
 * not HOW. The runner translates each step into MCP tool calls for either
 * cdp-mcp or playwright-mcp.
 */

export interface ScenarioStep {
  /** One of: navigate | click | wait_modal | fill_form | verify | eval | wait | snapshot */
  action: string;
  /** Element target (text+role, raw selector, or named modal/page identifier) */
  target?: string | { text?: string; role?: string; selector?: string };
  /** Field values for fill_form steps */
  fields?: Record<string, string>;
  /** Human-readable success criteria for verify steps */
  criteria?: string;
}

export interface Scenario {
  /** Stable kebab-case identifier, e.g. 'linkedin-easy-apply' */
  id: string;
  /** One-sentence description of the scenario */
  description: string;
  /** Target URL (may contain `{placeholders}` resolved at run time) */
  url: string;
  /** Things that must be true before the runner starts (auth, env, etc) */
  preconditions: string[];
  /** Ordered list of steps the runner must execute */
  steps: ScenarioStep[];
  /** Known site-specific failure modes documented from prior usage */
  knownFailures: string[];
  /** What "success" looks like for this scenario */
  successCriteria: string;
}

export interface RunResult {
  scenarioId: string;
  runner: 'cdp-mcp' | 'playwright-mcp';
  success: boolean;
  totalToolCalls: number;
  totalOutputBytes: number;
  durationMs: number;
  /** ID of the step that failed, if any */
  failedStep?: string;
  /** Free-form notes captured during the run */
  notes: string[];
}
