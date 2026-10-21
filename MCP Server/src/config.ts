/**
 * Configuration loader for the CDP Browser MCP Server.
 *
 * All environment-variable reading is centralised here so the rest of
 * the codebase works with a strongly-typed {@link ServerConfig} object.
 */

import type { ServerConfig, CleanupStrategy } from './types.js';

/**
 * Read environment variables and return a fully-populated {@link ServerConfig}.
 *
 * Defaults are chosen for a local development workflow:
 *  - Tiered timeouts (action < snapshot < navigation ≤ global)
 *  - `defaultCleanupStrategy` is `"detach"` so tabs survive session expiry
 */
export function loadConfig(): ServerConfig {
  return {
    cdpHost: process.env.CDP_HOST || '127.0.0.1',
    cdpPort: parseInt(process.env.CDP_PORT || '9222', 10),

    // Tiered timeouts
    actionTimeout: parseInt(process.env.CDP_ACTION_TIMEOUT || '10000', 10),
    navigationTimeout: parseInt(process.env.CDP_NAVIGATION_TIMEOUT || '60000', 10),
    snapshotTimeout: parseInt(process.env.CDP_SNAPSHOT_TIMEOUT || '15000', 10),
    globalTimeout: parseInt(process.env.CDP_TIMEOUT || '60000', 10),

    sessionTTL: parseInt(process.env.CDP_SESSION_TTL || '300000', 10),
    debuggerTimeout: parseInt(process.env.CDP_DEBUGGER_TIMEOUT || '30000', 10),

    // Default to "detach" so tabs are preserved when a session expires
    defaultCleanupStrategy:
      (process.env.CDP_CLEANUP_STRATEGY as CleanupStrategy) || 'detach',

    maxInlineLen: 60_000,
    tempDir: process.env.CDP_TEMP_DIR || '', // resolved at runtime
    maxTempFiles: 50,
    maxTempAgeMs: 30 * 60 * 1000, // 30 minutes

    autoConnectProfile: process.env.CDP_PROFILE || '',

    /** Extra User Data dir checked first during discovery (CDP_USER_DATA). */
    userDataDir: process.env.CDP_USER_DATA || '',

    /** Process command-line scan on discovery failure (default ON). */
    processScan: process.env.CDP_PROCESS_SCAN !== 'false',

    slimMode: process.env.CDP_SLIM_MODE === 'true',
  };
}
