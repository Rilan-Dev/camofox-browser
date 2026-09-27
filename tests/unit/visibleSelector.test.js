import { describe, expect, test } from '@jest/globals';
import { visibleSelectorCandidate } from '../../lib/visible-selector.js';

describe('visibleSelectorCandidate', () => {
  test('constrains a simple selector to visible elements', () => {
    expect(visibleSelectorCandidate('.menu-item:nth-child(3)')).toBe('.menu-item:nth-child(3):visible');
  });

  test('does not alter a selector that already requires visibility', () => {
    expect(visibleSelectorCandidate('button:visible')).toBeNull();
  });

  test('does not alter comma-separated selector lists', () => {
    expect(visibleSelectorCandidate('a.primary, button.primary')).toBeNull();
  });

  test('rejects blank and non-string selectors', () => {
    expect(visibleSelectorCandidate('   ')).toBeNull();
    expect(visibleSelectorCandidate(null)).toBeNull();
  });
});
