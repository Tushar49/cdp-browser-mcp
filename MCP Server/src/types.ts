/**
 * Core type definitions for the CDP Browser MCP Server.
 *
 * These types model every major data shape used across the server:
 * configuration, CDP protocol messages, session/tab management,
 * accessibility tree nodes, and tool registration.
 */

import type { CDPClient } from './connection/cdp-client.js';
import type { HealthMonitor } from './connection/health-monitor.js';
import type { DomainCapabilities } from './connection/capabilities.js';
import type { DomainManager } from './connection/domain-manager.js';
import type { TabSessionService } from './connection/tab-session-service.js';
import type { SessionManager } from './session/session-manager.js';
import type { TabOwnership } from './session/tab-ownership.js';
import type { ModalStateManager } from './session/modal-state.js';
import type { SnapshotCache } from './snapshot/cache.js';
import type { ElementResolver } from './snapshot/element-resolver.js';

// ─── Cleanup Strategy ───────────────────────────────────────────────

/** How tabs are handled when an agent session expires. */
export type CleanupStrategy = 'close' | 'detach' | 'none';

// ─── Server Configuration ───────────────────────────────────────────

export interface ServerConfig {
  cdpHost: string;
  cdpPort: number;

  /** Element action timeout (click, type, etc.) */
  actionTimeout: number;
  /** Page navigation timeout */
  navigationTimeout: number;
  /** Accessibility snapshot timeout */
  snapshotTimeout: number;
  /** Catch-all / legacy timeout */
  globalTimeout: number;

  /** Agent session time-to-live */
  sessionTTL: number;
  /** Debugger auto-resume timeout */
  debuggerTimeout: number;

  /** Default cleanup strategy for new sessions */
  defaultCleanupStrategy: CleanupStrategy;

  /** Max characters before content is written to a temp file */
  maxInlineLen: number;
  /** Directory for temp files (screenshots, PDFs, etc.) — resolved at runtime */
  tempDir: string;
  /** Maximum number of temp files before auto-cleanup kicks in */
  maxTempFiles: number;
  /** Maximum age (ms) before a temp file is eligible for cleanup */
  maxTempAgeMs: number;

  /** If set, auto-connect to this Chrome instance/profile on startup */
  autoConnectProfile: string;

  /** Extra User Data dir checked first during discovery (CDP_USER_DATA) */
  userDataDir: string;

  /** Process command-line scan on discovery failure (CDP_PROCESS_SCAN, default ON) */
  processScan: boolean;

  /** Actionability gate before element interactions (CDP_AUTO_WAIT, default ON) */
  autoWait: boolean;

  /** If true, expose 6 slim tools instead of 15 full tools (for small-context models) */
  slimMode: boolean;
}

// ─── MCP Tool Result ────────────────────────────────────────────────

export interface ToolResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Standard MCP tool response envelope. */
export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
  /** Index signature for MCP SDK compatibility. */
  [key: string]: unknown;
}

// ─── CDP Protocol Messages ──────────────────────────────────────────

/** Outbound CDP command. */
export interface CDPMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** CDP response to a command. */
export interface CDPResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/** CDP event pushed by the browser. */
export interface CDPEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

// ─── Session & Tab Management ───────────────────────────────────────

/** Agent session metadata. */
export interface SessionInfo {
  id: string;
  createdAt: number;
  lastActivity: number;
  cleanupStrategy: CleanupStrategy;
  tabIds: Set<string>;
}

/** Lightweight tab descriptor. */
export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
  type: string;
  sessionId?: string;
  exclusive: boolean;
}

// ─── Browser Discovery ──────────────────────────────────────────────

/** Chrome profile metadata parsed from Local State. */
export interface ProfileInfo {
  name: string;
  email?: string;
  directory: string;
}

/** A running Chromium-based browser instance. */
export interface BrowserInstance {
  name: string;
  port: number;
  wsUrl: string;
  userDataDir: string;
  profiles: ProfileInfo[];
}

// ─── Accessibility Tree ─────────────────────────────────────────────

/** A single node in the Chrome accessibility (AX) tree. */
export interface AXNode {
  role: string;
  name: string;
  uid?: number;
  backendNodeId: number;
  children?: AXNode[];
  properties?: Record<string, unknown>;
}

// ─── Tool Registration ──────────────────────────────────────────────

/** Signature for a tool action handler. */
export type ToolHandler = (
  ctx: ServerContext,
  params: Record<string, unknown>,
) => Promise<ToolResult>;

/** Describes one tool that can be registered with the MCP server. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

// ─── CDP Event Pipeline State ───────────────────────────────────────

/** Tracked network request entry. */
export interface NetworkRequestEntry {
  id: string;
  url: string;
  method: string;
  type: string;
  ts: number;
  status: number | null;
  mimeType: string | null;
  size: number | null;
}

/** Tracked download entry. */
export interface DownloadEntry {
  guid: string;
  url: string;
  suggestedFilename: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
  ts: number;
}

/** Pending JavaScript dialog info. */
export interface PendingDialog {
  type: string;
  message: string;
  defaultPrompt: string;
  url: string;
  ts: number;
}

/** Active find session state for a tab (page.find / find_next / find_stop). */
export interface FindState {
  text: string;
  caseSensitive: boolean;
  count: number;
  ordinal: number;
}

/** Debugger paused state for a tab. */
export interface PausedTabInfo {
  reason: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP callFrames are untyped
  callFrames: any[];
  hitBreakpoints: string[];
  ts: number;
}

/** Pending fetch request info. */
export interface FetchRequestInfo {
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  resourceType: string;
  ts: number;
}

/** File chooser handler callback. */
export type FileChooserHandler = (
  sessionId: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- CDP event params are untyped
  params: any,
) => void;

// ─── Dependency-Injection Context ───────────────────────────────────

/**
 * ServerContext is the DI container threaded through every tool handler.
 * It provides access to configuration, the active CDP connection, session
 * state, and shared helpers — without any tool needing global imports.
 */
export interface ServerContext {
  /** CDP domain capability report (5.1.0 B1) — feature-detection backbone */
  capabilities: DomainCapabilities;

  config: ServerConfig;

  /** The active CDP WebSocket client. */
  cdpClient: CDPClient;

  /** Connection health monitor with auto-reconnect. */
  healthMonitor: HealthMonitor;

  /** Lazy CDP domain enablement manager. */
  domainManager: DomainManager;

  /** Send a CDP command and await its result. */
  sendCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>;

  /** Shared per-tab CDP session management. */
  tabSessions: TabSessionService;

  /** Agent session lifecycle manager. */
  sessions: SessionManager;

  /** Tab ownership and locking for multi-agent isolation. */
  tabOwnership: TabOwnership;

  /** Tracks tab-level modal states (dialogs, file choosers, debugger pauses). */
  modalStates: ModalStateManager;

  /** Per-process fallback session ID. */
  processSessionId: string;

  /** Snapshot cache for incremental/diff snapshots. */
  snapshotCache: SnapshotCache;

  /** Per-tab ElementResolver for stable uid refs across snapshots. */
  elementResolvers: Map<string, ElementResolver>;

  // ─── Event Pipeline State Stores ──────────────────────────────────

  /** Per-session console log buffer (sessionId → log entries). */
  consoleLogs: Map<string, Array<{ level: string; text: string; ts: number; url: string }>>;

  /** Per-session network request tracker (sessionId → Map<requestId, request>). */
  networkReqs: Map<string, Map<string, NetworkRequestEntry>>;

  /** Per-session download tracker (sessionId → downloads). */
  downloads: Map<string, DownloadEntry[]>;

  /** Per-session pending dialog tracker (sessionId → dialogs). */
  pendingDialogs: Map<string, PendingDialog[]>;
  /** Per-tab find session state (page.find). */
  findState: Map<string, FindState>;

  /** Per-session file chooser handler callbacks (sessionId → handlers). */
  pendingFileChoosers: Map<string, FileChooserHandler[]>;

  /** Per-session debugger pause state (sessionId → pause info). */
  pausedTabs: Map<string, PausedTabInfo>;

  /** Per-session pending fetch requests (sessionId → Map<requestId, info>). */
  pendingFetchRequests: Map<string, Map<string, FetchRequestInfo>>;
}
