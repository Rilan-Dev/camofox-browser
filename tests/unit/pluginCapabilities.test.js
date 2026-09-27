import { describe, expect, test } from '@jest/globals';
import { createVirtualDisplayRegistry } from '../../lib/plugin-capabilities.js';

describe('virtual display plugin capability', () => {
  test('uses the registered plugin provider instead of the default provider', () => {
    const registry = createVirtualDisplayRegistry(() => ({ owner: 'core' }));

    registry.register('vnc', () => ({ owner: 'vnc' }));

    expect(registry.owner).toBe('vnc');
    expect(registry.create()).toEqual({ owner: 'vnc' });
  });

  test('rejects a second plugin provider instead of relying on load order', () => {
    const registry = createVirtualDisplayRegistry(() => ({ owner: 'core' }));
    registry.register('vnc', () => ({ owner: 'vnc' }));

    expect(() => registry.register('other-display', () => ({ owner: 'other' }))).toThrow(
      '"vnc" already owns the capability; "other-display" cannot also provide it'
    );
  });
});
