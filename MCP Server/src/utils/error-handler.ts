/**
 * Actionable error system for CDP Browser MCP Server.
 *
 * Every error tells the agent WHAT went wrong and HOW to fix it,
 * so LLM agents can self-recover without human intervention.
 */

// ─── ActionableError ────────────────────────────────────────────────

export class ActionableError extends Error {
  public readonly fix: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, fix: string, context?: Record<string, unknown>) {
    super(message);
    this.name = 'ActionableError';
    this.fix = fix;
    this.context = context;
  }

  toToolResult(): { content: Array<{ type: string; text: string }>; isError: true } {
    const parts = [`### Error\n${this.message}`, `\n### How to fix\n${this.fix}`];
    if (this.context) {
      parts.push(`\n### Context\n${JSON.stringify(this.context, null, 2)}`);
    }
    return {
      content: [{ type: 'text', text: parts.join('\n') }],
      isError: true,
    };
  }
}

// ─── Domain-unsupported error (capability gate) ─────────────────────

/**
 * Thrown by `DomainCapabilities.require` when the connected browser does not
 * implement a CDP domain/method (e.g. Brave/Chrome builds that omit a domain).
 * `wrapError` recognizes it so unsupported-feature failures render with a
 * proper "How to fix" instead of the generic fallback.
 */
export class DomainUnsupportedError extends Error {
  public readonly domain: string;
  public readonly minChrome?: string;

  constructor(message: string, domain: string, minChrome?: string) {
    super(message);
    this.name = 'DomainUnsupportedError';
    this.domain = domain;
    this.minChrome = minChrome;
  }
}

// ─── Error Catalog ──────────────────────────────────────────────────

export const Errors = {
  /** No browser found with remote debugging enabled on the given port. */
  noBrowser(port: number): ActionableError {
    return new ActionableError(
      `Cannot connect to browser on port ${port}. No browser found with remote debugging enabled.`,
      'Enable remote debugging in your browser:\n' +
        '• Chrome: chrome://flags → #enable-remote-debugging → Enabled → Relaunch\n' +
        '• Edge: edge://flags → #enable-remote-debugging → Enabled → Relaunch\n' +
        '• Brave: brave://flags → #enable-remote-debugging → Enabled → Relaunch\n' +
        `• Or launch with --remote-debugging-port=${port}`,
      { port },
    );
  },

  /** Element uid not found — the page likely changed since the last snapshot. */
  staleRef(uid: number): ActionableError {
    return new ActionableError(
      `Element ref=${uid} not found — the page may have changed since the last snapshot.`,
      "Take a new snapshot with the page tool (action: 'snapshot') and use a uid from the fresh snapshot.",
      { uid },
    );
  },

  /** Tab was closed or the session was disconnected. */
  tabNotFound(tabId: string): ActionableError {
    return new ActionableError(
      `Tab [${tabId}] not found — it may have been closed or the session expired.`,
      "Use the tabs tool (action: 'list') to see available tabs, then retry with a valid tabId.",
      { tabId },
    );
  },

  /** Agent session expired due to inactivity. */
  sessionExpired(ttlSeconds: number): ActionableError {
    return new ActionableError(
      `Session expired after ${ttlSeconds}s of inactivity. All tab locks have been released.`,
      "Start a new session by making any tool call. Re-acquire tabs with the tabs tool (action: 'list' or 'new').",
      { ttlSeconds },
    );
  },

  /** Navigation timed out before the page finished loading. */
  navigationTimeout(url: string, timeoutMs: number): ActionableError {
    return new ActionableError(
      `Navigation to "${url}" timed out after ${timeoutMs}ms.`,
      'The page may be slow or unresponsive. Try:\n' +
        "• Increase the timeout parameter\n" +
        "• Use waitUntil: 'domcontentloaded' or 'commit' instead of 'load'\n" +
        '• Check if the URL is correct and accessible',
      { url, timeoutMs },
    );
  },

  /** Couldn't select a value from a dropdown. */
  comboboxFailed(value: string, available?: string[]): ActionableError {
    const availableInfo = available?.length
      ? `\nAvailable options: ${available.join(', ')}`
      : '';
    return new ActionableError(
      `Option "${value}" not found in dropdown.${availableInfo}`,
      'Try one of these:\n' +
        '• Check available options by taking a snapshot of the expanded dropdown\n' +
        '• Use the exact text or value from the option list\n' +
        '• For custom dropdowns: click to open, take a snapshot, then click the option directly',
      { value, available },
    );
  },

  /** Server is not connected to any browser instance. */
  notConnected(): ActionableError {
    return new ActionableError(
      'Server is not connected to any browser.',
      'Ensure a Chromium-based browser (Chrome, Edge, Brave) is running with remote debugging enabled.\n' +
        "Use the browser tool (action: 'profiles') to discover running instances, then connect.",
    );
  },

  /** CDP target was detached — the tab crashed or navigated away. */
  targetDetached(tabId: string): ActionableError {
    return new ActionableError(
      `CDP target detached for tab [${tabId}] — the tab may have crashed, been closed, or navigated cross-process.`,
      "Use the tabs tool (action: 'list') to check if the tab still exists.\n" +
        'If it does, retry the operation — a new CDP session will be established automatically.',
      { tabId },
    );
  },

  /** Frame not found in the current page. */
  frameNotFound(frameId: string): ActionableError {
    return new ActionableError(
      `Frame "${frameId}" not found in the page.`,
      "Take a new snapshot — frame references change after navigation.\n" +
        "The snapshot output shows available frames as [frame N] prefixes.",
      { frameId },
    );
  },

  /** Element exists but can't be interacted with. */
  elementNotInteractable(uid: number, reason: string): ActionableError {
    return new ActionableError(
      `Element ref=${uid} is not interactable: ${reason}`,
      'Common fixes:\n' +
        '• If hidden: scroll to the element or expand its parent container\n' +
        '• If disabled: wait for a prerequisite action to complete\n' +
        '• If covered: dismiss overlays or modals blocking the element\n' +
        '• If zero-size: the element may be collapsed — interact with a parent',
      { uid, reason },
    );
  },

  /** File path for upload doesn't exist on disk. */
  fileNotFound(path: string): ActionableError {
    return new ActionableError(
      `File not found: "${path}"`,
      'Provide an absolute file path that exists on the local filesystem.\n' +
        'Verify the path is correct and the file has not been moved or deleted.',
      { path },
    );
  },

  /** Raw CDP protocol error wrapper. */
  cdpError(method: string, errorMsg: string): ActionableError {
    return new ActionableError(
      `CDP protocol error in ${method}: ${errorMsg}`,
      'This is a low-level browser protocol error. Common causes:\n' +
        '• The target page navigated away during the operation — retry\n' +
        '• Invalid parameters were passed — check the CDP documentation\n' +
        '• The browser is in an unexpected state — try taking a fresh snapshot',
      { method, errorMsg },
    );
  },

  /** A JavaScript dialog (alert/confirm/prompt) is blocking the page. */
  dialogBlocking(dialogType: string, message?: string): ActionableError {
    const preview = message ? ` "${message.substring(0, 100)}"` : '';
    return new ActionableError(
      `A JavaScript ${dialogType} dialog is blocking the page.${preview}`,
      "Handle the dialog first using the page tool:\n" +
        "→ action: 'dialog', accept: true (to accept) or accept: false (to dismiss)\n" +
        'No other actions will work until the dialog is handled.',
      { dialogType, message },
    );
  },

  /** Debugger is paused — resume before performing other operations. */
  debuggerPaused(reason?: string, location?: string): ActionableError {
    const locInfo = location ? `\nPaused at: ${location}` : '';
    return new ActionableError(
      `Debugger is paused on this tab.${locInfo}${reason ? `\nReason: ${reason}` : ''}`,
      "Resume execution or step through the code using the debug tool:\n" +
        "→ action: 'resume' to continue execution\n" +
        "→ action: 'step_over', 'step_into', or 'step_out' to step through code\n" +
        "→ action: 'call_stack' or 'evaluate_on_frame' to inspect state\n" +
        'The tab will auto-resume after 30s if not handled.',
      { reason, location },
    );
  },

  /** Tab is locked by another agent session. */
  tabLocked(tabId: string, ownerSessionId: string): ActionableError {
    return new ActionableError(
      `Tab [${tabId}] is locked by another agent session (${ownerSessionId.substring(0, 8)}…).`,
      "Either:\n" +
        "• Use exclusive: false to access the tab without locking\n" +
        "• End the other session with the cleanup tool (action: 'session')\n" +
        "• Use a different tab",
      { tabId, ownerSessionId },
    );
  },

  /** WebSocket connection to the browser was lost. */
  connectionLost(): ActionableError {
    return new ActionableError(
      'WebSocket connection to the browser was lost.',
      'The browser may have been closed or crashed.\n' +
        'Restart the browser with remote debugging enabled and retry the operation.\n' +
        'The server will attempt to reconnect automatically on the next tool call.',
    );
  },

  /** CDP method timed out. */
  cdpTimeout(method: string, timeoutMs: number): ActionableError {
    return new ActionableError(
      `${method}: timed out after ${timeoutMs}ms.`,
      'The operation took too long. Try:\n' +
        '• Increase the timeout parameter\n' +
        '• Check if the page is responsive (heavy JS may be blocking)\n' +
        '• For navigation, use a less strict waitUntil option',
      { method, timeoutMs },
    );
  },

  /** CSS selector did not match any element. */
  selectorNotFound(selector: string): ActionableError {
    return new ActionableError(
      `No element matches selector "${selector}".`,
      "Take a snapshot to see the current page structure, then:\n" +
        '• Use a uid from the snapshot instead of a CSS selector\n' +
        '• Verify the selector matches an element that is currently visible\n' +
        '• Check for iframes — CSS selectors only match top-level elements',
      { selector },
    );
  },

  /** File chooser dialog was not triggered in time. */
  fileChooserTimeout(timeoutMs: number): ActionableError {
    return new ActionableError(
      `No file input or file chooser dialog found within ${timeoutMs / 1000}s.`,
      'If a popup window opened (e.g. Google Drive Picker):\n' +
        "• Use tabs tool (action: 'list') to find the popup window\n" +
        '• Snapshot the popup to find its file input or upload button\n' +
        '• Use interact.upload with uid/selector targeting the file input in the popup',
      { timeoutMs },
    );
  },
} as const;

// ─── Pattern-matching error wrapper ─────────────────────────────────

/**
 * Wraps an unknown error into an ActionableError.
 * If already an ActionableError, returns it unchanged.
 * Otherwise, tries to pattern-match the error message to a known error catalog entry.
 */
export function wrapError(error: unknown): ActionableError {
  if (error instanceof ActionableError) return error;
  if (error instanceof DomainUnsupportedError) {
    return new ActionableError(
      error.message,
      'Update Chrome/Brave to a version that supports this feature, or use a different browser for this capability.',
      { domain: error.domain, minChrome: error.minChrome },
    );
  }

  const msg = error instanceof Error ? error.message : String(error);

  // CDP target / session errors
  if (msg.includes('No target with given id') || msg.includes('Target closed'))
    return Errors.targetDetached('unknown');
  if (msg.includes('Session with given id not found'))
    return Errors.targetDetached('unknown');

  // Connection errors
  if (msg.includes('WebSocket closed') || msg.includes('WebSocket is not open'))
    return Errors.connectionLost();
  if (msg.includes('Cannot connect to browser'))
    return Errors.noBrowser(9222);

  // Element errors
  if (/ref=\d+.*not found/i.test(msg)) {
    const match = msg.match(/ref=(\d+)/);
    return Errors.staleRef(match ? parseInt(match[1], 10) : 0);
  }
  if (msg.includes('Element not found') && msg.includes('('))
    return Errors.selectorNotFound(msg.match(/\(([^)]+)\)/)?.[1] ?? 'unknown');

  // Timeout errors
  if (msg.includes('timed out')) {
    const methodMatch = msg.match(/^(.+?):\s*timed out/);
    const timeoutMatch = msg.match(/\((\d+)ms\)/);
    if (methodMatch) {
      return Errors.cdpTimeout(
        methodMatch[1],
        timeoutMatch ? parseInt(timeoutMatch[1], 10) : 30000,
      );
    }
  }
  if (msg.includes('Navigation timeout'))
    return Errors.navigationTimeout('unknown', 30000);

  // Element interactability
  if (msg.includes('has zero size'))
    return Errors.elementNotInteractable(0, 'Element has zero size — it may be hidden or collapsed.');
  if (msg.includes('is disabled'))
    return Errors.elementNotInteractable(0, 'Element is disabled.');
  if (msg.includes('pointer-events: none'))
    return Errors.elementNotInteractable(0, 'Element has pointer-events: none — it may be covered by an overlay.');
  if (msg.includes('not visible') || msg.includes('visibility') && msg.includes('hidden'))
    return Errors.elementNotInteractable(0, 'Element is not visible.');

  // Dialog / debugger guards
  if (msg.includes('dialog is blocking'))
    return Errors.dialogBlocking('unknown');
  if (msg.includes('Debugger is paused'))
    return Errors.debuggerPaused();

  // Option not found in dropdown
  if (msg.includes('Option not found'))
    return Errors.comboboxFailed(msg.match(/Option not found.*?:\s*(.+?)(?:\.|$)/)?.[1] ?? 'unknown');

  // File chooser
  if (msg.includes('file chooser') || msg.includes('file input'))
    return Errors.fileChooserTimeout(30000);

  // Fallback: unknown error with generic recovery advice
  return new ActionableError(
    msg,
    'Check the error message for details. Try taking a fresh snapshot with the page tool (action: \'snapshot\').',
  );
}
