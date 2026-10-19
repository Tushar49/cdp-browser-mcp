import { describe, it, expect } from 'vitest';
import { allScenarios } from '../agent-suite/index.js';

describe('agent test suite scenarios', () => {
  it('has all 6 scenarios', () => {
    expect(allScenarios).toHaveLength(6);
  });

  it('every scenario id is unique', () => {
    const ids = allScenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const s of allScenarios) {
    describe(s.id, () => {
      it('has required fields', () => {
        expect(s.description).toBeTruthy();
        expect(s.url).toBeTruthy();
        expect(s.steps.length).toBeGreaterThan(0);
        expect(s.successCriteria).toBeTruthy();
        expect(Array.isArray(s.preconditions)).toBe(true);
        expect(Array.isArray(s.knownFailures)).toBe(true);
      });

      it('uses known step actions', () => {
        const validActions = [
          'navigate',
          'click',
          'wait_modal',
          'fill_form',
          'verify',
          'eval',
          'wait',
          'snapshot',
        ];
        for (const step of s.steps) {
          expect(validActions).toContain(step.action);
        }
      });

      it('documents at least one known failure mode', () => {
        expect(s.knownFailures.length).toBeGreaterThan(0);
      });
    });
  }
});
