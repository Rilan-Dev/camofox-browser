import { describe, expect, test } from '@jest/globals';
import { contextIdentityOptions, launchLocale } from '../../lib/browser-identity.js';

describe('browser identity options', () => {
  test('leaves direct sessions without a configured identity untouched', () => {
    expect(contextIdentityOptions({ hasProxy: false, directIdentity: null })).toEqual({});
    expect(launchLocale({ hasProxy: false, directIdentity: null })).toBeUndefined();
  });

  test('uses a complete configured identity only for direct sessions', () => {
    const directIdentity = { locale: 'en-AU', timezoneId: 'Australia/Sydney' };
    expect(contextIdentityOptions({ hasProxy: false, directIdentity })).toEqual(directIdentity);
    expect(launchLocale({ hasProxy: false, directIdentity })).toBe('en-AU');
  });

  test('leaves proxy identity to Camoufox GeoIP', () => {
    const directIdentity = { locale: 'en-AU', timezoneId: 'Australia/Sydney' };
    expect(contextIdentityOptions({ hasProxy: true, directIdentity })).toEqual({ permissions: ['geolocation'] });
    expect(launchLocale({ hasProxy: true, directIdentity })).toBeUndefined();
  });
});
