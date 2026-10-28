import { describe, it, expect, beforeEach } from 'vitest';
import { ModalStateManager } from '../../session/modal-state.js';
import { ActionableError } from '../../utils/error-handler.js';
import type { ModalState } from '../../session/modal-state.js';

function dialogModal(tabId: string): ModalState {
  return {
    type: 'dialog',
    tabId,
    details: { dialogType: 'alert', message: 'Hello!' },
    timestamp: Date.now(),
  };
}

function fileChooserModal(tabId: string): ModalState {
  return {
    type: 'filechooser',
    tabId,
    details: { multiple: false },
    timestamp: Date.now(),
  };
}

function debuggerModal(tabId: string): ModalState {
  return {
    type: 'debugger-paused',
    tabId,
    details: { reason: 'breakpoint', location: 'script.js:42' },
    timestamp: Date.now(),
  };
}

describe('ModalStateManager', () => {
  let modal: ModalStateManager;

  beforeEach(() => {
    modal = new ModalStateManager();
  });

  describe('setModal()', () => {
    it('stores modal for tab', () => {
      const m = dialogModal('tab1');
      modal.setModal('tab1', m);
      expect(modal.getModal('tab1')).toBe(m);
    });

    it('replaces existing modal', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      const m2 = fileChooserModal('tab1');
      modal.setModal('tab1', m2);
      expect(modal.getModal('tab1')).toBe(m2);
    });
  });

  describe('getModal()', () => {
    it('returns stored modal', () => {
      const m = dialogModal('tab1');
      modal.setModal('tab1', m);
      expect(modal.getModal('tab1')).toBe(m);
    });

    it('returns undefined when no modal set', () => {
      expect(modal.getModal('tab1')).toBeUndefined();
    });
  });

  describe('clearModal()', () => {
    it('removes modal', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      modal.clearModal('tab1');
      expect(modal.getModal('tab1')).toBeUndefined();
    });

    it('does nothing for nonexistent tab', () => {
      expect(() => modal.clearModal('nope')).not.toThrow();
    });
  });

  describe('clearAll()', () => {
    it('drops every modal state', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      modal.setModal('tab2', fileChooserModal('tab2'));
      modal.clearAll();
      expect(modal.getModal('tab1')).toBeUndefined();
      expect(modal.getModal('tab2')).toBeUndefined();
    });
  });

  describe('checkBlocked()', () => {
    it('returns null when no modal', () => {
      expect(modal.checkBlocked('tab1', 'page', 'snapshot')).toBeNull();
    });

    it('returns ActionableError when dialog blocks', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      const err = modal.checkBlocked('tab1', 'page', 'snapshot');

      expect(err).toBeInstanceOf(ActionableError);
      expect(err!.message).toContain('dialog');
      expect(err!.message).toContain('Hello!');
    });

    it('allows page.dialog when dialog is active', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      const err = modal.checkBlocked('tab1', 'page', 'dialog');
      expect(err).toBeNull();
    });

    it('blocks page.snapshot when dialog is active', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      const err = modal.checkBlocked('tab1', 'page', 'snapshot');
      expect(err).not.toBeNull();
    });

    it('allows interact.upload when filechooser is active', () => {
      modal.setModal('tab1', fileChooserModal('tab1'));
      const err = modal.checkBlocked('tab1', 'interact', 'upload');
      expect(err).toBeNull();
    });

    it('blocks other tools when filechooser is active', () => {
      modal.setModal('tab1', fileChooserModal('tab1'));
      const err = modal.checkBlocked('tab1', 'page', 'snapshot');
      expect(err).toBeInstanceOf(ActionableError);
      expect(err!.message).toContain('file chooser');
    });

    it('allows debug tools when debugger is paused', () => {
      modal.setModal('tab1', debuggerModal('tab1'));
      const err = modal.checkBlocked('tab1', 'debug', 'resume');
      expect(err).toBeNull();
    });

    it('allows debug with any action when paused', () => {
      modal.setModal('tab1', debuggerModal('tab1'));
      expect(modal.checkBlocked('tab1', 'debug', 'step_over')).toBeNull();
      expect(modal.checkBlocked('tab1', 'debug', 'call_stack')).toBeNull();
      expect(modal.checkBlocked('tab1', 'debug')).toBeNull();
    });

    it('blocks non-debug tools when debugger is paused', () => {
      modal.setModal('tab1', debuggerModal('tab1'));
      const err = modal.checkBlocked('tab1', 'page', 'snapshot');
      expect(err).toBeInstanceOf(ActionableError);
      expect(err!.message).toContain('Debugger is paused');
    });

    it('error includes location info when debugger paused', () => {
      modal.setModal('tab1', debuggerModal('tab1'));
      const err = modal.checkBlocked('tab1', 'interact', 'click');
      expect(err!.message).toContain('script.js:42');
    });

    it('does not block other tabs', () => {
      modal.setModal('tab1', dialogModal('tab1'));
      expect(modal.checkBlocked('tab2', 'page', 'snapshot')).toBeNull();
    });
  });
});
