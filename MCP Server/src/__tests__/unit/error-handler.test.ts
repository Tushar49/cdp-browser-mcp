import { describe, it, expect } from 'vitest';
import { ActionableError, DomainUnsupportedError, Errors, wrapError } from '../../utils/error-handler.js';

describe('ActionableError', () => {
  it('has message, fix, context properties', () => {
    const err = new ActionableError('Something broke', 'Fix it', { key: 'val' });
    expect(err.message).toBe('Something broke');
    expect(err.fix).toBe('Fix it');
    expect(err.context).toEqual({ key: 'val' });
    expect(err.name).toBe('ActionableError');
  });

  it('extends Error', () => {
    const err = new ActionableError('msg', 'fix');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ActionableError);
  });

  it('context is optional', () => {
    const err = new ActionableError('msg', 'fix');
    expect(err.context).toBeUndefined();
  });

  describe('toToolResult()', () => {
    it('returns correct MCP format with isError: true', () => {
      const err = new ActionableError('Oops', 'Try again');
      const result = err.toToolResult();

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('### Error');
      expect(result.content[0].text).toContain('Oops');
      expect(result.content[0].text).toContain('### How to fix');
      expect(result.content[0].text).toContain('Try again');
    });

    it('includes context when present', () => {
      const err = new ActionableError('Oops', 'Fix', { port: 9222 });
      const result = err.toToolResult();
      expect(result.content[0].text).toContain('### Context');
      expect(result.content[0].text).toContain('"port": 9222');
    });

    it('omits context section when context is undefined', () => {
      const err = new ActionableError('Oops', 'Fix');
      const result = err.toToolResult();
      expect(result.content[0].text).not.toContain('### Context');
    });
  });
});

describe('Errors catalog', () => {
  it('noBrowser returns ActionableError with port info', () => {
    const err = Errors.noBrowser(9333);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('9333');
    expect(err.context).toEqual({ port: 9333 });
  });

  it('staleRef returns ActionableError with uid info', () => {
    const err = Errors.staleRef(42);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('ref=42');
    expect(err.fix).toContain('snapshot');
    expect(err.context).toEqual({ uid: 42 });
  });

  it('tabNotFound returns ActionableError with tabId', () => {
    const err = Errors.tabNotFound('ABC123');
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('ABC123');
  });

  it('sessionExpired returns ActionableError with ttl', () => {
    const err = Errors.sessionExpired(300);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('300');
  });

  it('navigationTimeout returns ActionableError', () => {
    const err = Errors.navigationTimeout('https://example.com', 30000);
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('example.com');
    expect(err.message).toContain('30000');
  });

  it('notConnected returns ActionableError', () => {
    const err = Errors.notConnected();
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('not connected');
  });

  it('dialogBlocking returns ActionableError with dialog info', () => {
    const err = Errors.dialogBlocking('alert', 'Hello world');
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('alert');
    expect(err.message).toContain('Hello world');
  });

  it('debuggerPaused returns ActionableError', () => {
    const err = Errors.debuggerPaused('breakpoint', 'file.js:10');
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('file.js:10');
  });

  it('tabLocked returns ActionableError', () => {
    const err = Errors.tabLocked('tab1', 'session-abc-123');
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('tab1');
  });

  it('connectionLost returns ActionableError', () => {
    const err = Errors.connectionLost();
    expect(err).toBeInstanceOf(ActionableError);
    expect(err.message).toContain('WebSocket');
  });
});

describe('wrapError()', () => {
  it('returns ActionableError unchanged', () => {
    const original = new ActionableError('original', 'fix');
    const wrapped = wrapError(original);
    expect(wrapped).toBe(original);
  });

  it('converts DomainUnsupportedError into an actionable error with fix + context', () => {
    const original = new DomainUnsupportedError(
      'This browser does not support the CDP "WebAuthn" feature (requires Chrome 150+).',
      'WebAuthn',
      '150',
    );
    const wrapped = wrapError(original);
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('WebAuthn');
    expect(wrapped.fix).toContain('Update Chrome/Brave');
    expect(wrapped.context).toEqual({ domain: 'WebAuthn', minChrome: '150' });
  });

  it('maps "No target with given id" to targetDetached', () => {
    const wrapped = wrapError(new Error('No target with given id found'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('detached');
  });

  it('maps "Target closed" to targetDetached', () => {
    const wrapped = wrapError(new Error('Target closed'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('detached');
  });

  it('maps "WebSocket closed" to connectionLost', () => {
    const wrapped = wrapError(new Error('WebSocket closed unexpectedly'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('WebSocket');
  });

  it('maps "WebSocket is not open" to connectionLost', () => {
    const wrapped = wrapError(new Error('WebSocket is not open'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('WebSocket');
  });

  it('maps stale ref pattern to staleRef error', () => {
    const wrapped = wrapError(new Error('ref=42 not found'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('ref=42');
  });

  it('maps "Navigation timeout" to navigationTimeout', () => {
    const wrapped = wrapError(new Error('Navigation timeout exceeded'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('Navigation');
  });

  it('wraps unknown errors with generic fix', () => {
    const wrapped = wrapError(new Error('Something totally unexpected'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toBe('Something totally unexpected');
    expect(wrapped.fix).toContain('snapshot');
  });

  it('wraps non-Error values (string)', () => {
    const wrapped = wrapError('string error');
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toBe('string error');
  });

  it('maps "has zero size" to elementNotInteractable', () => {
    const wrapped = wrapError(new Error('Element has zero size'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('not interactable');
  });

  it('maps "is disabled" to elementNotInteractable', () => {
    const wrapped = wrapError(new Error('Element is disabled'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('not interactable');
  });

  it('maps "dialog is blocking" to dialogBlocking', () => {
    const wrapped = wrapError(new Error('A dialog is blocking the page'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('dialog');
  });

  it('maps "Debugger is paused" to debuggerPaused', () => {
    const wrapped = wrapError(new Error('Debugger is paused'));
    expect(wrapped).toBeInstanceOf(ActionableError);
    expect(wrapped.message).toContain('Debugger is paused');
  });
});
