/**
 * Modal state management for CDP Browser MCP Server.
 *
 * Tracks tab-level modal states (dialogs, file choosers, debugger pauses)
 * that block normal interaction. When a modal is active, all tool calls
 * on that tab are blocked with an ActionableError that tells the agent
 * exactly how to resolve it.
 *
 * ─── Integration ─────────────────────────────────────────────────────
 * Wired in src/index.ts via CDP event subscriptions:
 *
 *  - `Page.javascriptDialogOpening` → setModal(tabId, { type: 'dialog' })
 *  - `Page.javascriptDialogClosed`  → clearModal(tabId)
 *  - `Debugger.paused`              → setModal(tabId, { type: 'debugger-paused' })
 *  - `Debugger.resumed`             → clearModal(tabId)
 *
 * Before every tool dispatch, `preprocessToolCall()` calls:
 *   ctx.modalStates.checkBlocked(tabId, toolName, action)
 * ────────────────────────────────────────────────────────────────────
 */

import { ActionableError } from '../utils/error-handler.js';

// ─── Types ──────────────────────────────────────────────────────────

export type ModalType = 'dialog' | 'filechooser' | 'debugger-paused';

export interface ModalDetails {
  /** Dialog subtype (alert, confirm, prompt, beforeunload). */
  dialogType?: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** Dialog message text. */
  message?: string;
  /** Default text for prompt dialogs. */
  defaultPrompt?: string;
  /** Whether the file chooser accepts multiple files. */
  multiple?: boolean;
  /** Debugger pause reason (e.g. "breakpoint", "exception"). */
  reason?: string;
  /** Source location where the debugger paused. */
  location?: string;
}

export interface ModalState {
  type: ModalType;
  tabId: string;
  details: ModalDetails;
  timestamp: number;
}

// ─── ModalStateManager ──────────────────────────────────────────────

export class ModalStateManager {
  /** Active modals keyed by tab target ID. One modal per tab. */
  private modals = new Map<string, ModalState>();

  /** Set a modal state for a tab, replacing any existing modal. */
  setModal(tabId: string, modal: ModalState): void {
    this.modals.set(tabId, modal);
  }

  /** Clear the modal state after the modal has been handled. */
  clearModal(tabId: string): void {
    this.modals.delete(tabId);
  }

  /** Drop every modal state (tab destroyed, browser disconnected/restarted). */
  clearAll(): void {
    this.modals.clear();
  }

  /** Get the active modal for a tab, or undefined if none. */
  getModal(tabId: string): ModalState | undefined {
    return this.modals.get(tabId);
  }

  /**
   * Check whether a tool call should be blocked by an active modal.
   *
   * Returns `null` if the tool is allowed to proceed, or an
   * `ActionableError` with recovery instructions if blocked.
   *
   * Tools that *resolve* the modal are always allowed through:
   *  - dialog  → page tool with action "dialog"
   *  - filechooser → interact tool with action "upload"
   *  - debugger-paused → any debug tool action
   */
  checkBlocked(tabId: string, toolName: string, action?: string): ActionableError | null {
    const modal = this.modals.get(tabId);
    if (!modal) return null;

    // Allow the tool that resolves this modal type
    if (modal.type === 'dialog' && toolName === 'page' && action === 'dialog') return null;
    if (modal.type === 'filechooser' && toolName === 'interact' && action === 'upload') return null;
    if (modal.type === 'debugger-paused' && toolName === 'debug') return null;

    // Block everything else with an actionable error
    switch (modal.type) {
      case 'dialog': {
        const preview = modal.details.message?.substring(0, 100) ?? '';
        return new ActionableError(
          `A ${modal.details.dialogType ?? 'unknown'} dialog is blocking this tab: "${preview}"`,
          `Handle the dialog first: page({ action: "dialog", tabId: "${tabId}", accept: true })` +
            (modal.details.dialogType === 'prompt'
              ? `\nFor prompts, add: text: "your response"`
              : ''),
          { dialogType: modal.details.dialogType, message: modal.details.message },
        );
      }

      case 'filechooser':
        return new ActionableError(
          'A file chooser dialog is open on this tab.',
          `Upload files: interact({ action: "upload", tabId: "${tabId}", files: ["/path/to/file.pdf"] })` +
            `\nOr cancel: interact({ action: "upload", tabId: "${tabId}", files: [] })`,
        );

      case 'debugger-paused':
        return new ActionableError(
          `Debugger is paused on this tab.${modal.details.location ? ` At: ${modal.details.location}` : ''}`,
          `Resume: debug({ action: "resume", tabId: "${tabId}" })` +
            '\nOr step through: debug({ action: "step_over" | "step_into" | "step_out" })',
          { reason: modal.details.reason, location: modal.details.location },
        );

      default:
        return null;
    }
  }
}
