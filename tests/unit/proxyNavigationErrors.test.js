import fs from 'fs';
import path from 'path';
import { describe, expect, test } from '@jest/globals';

const serverSource = fs.readFileSync(path.join(process.cwd(), 'server.js'), 'utf8');

describe('proxy navigation error detection', () => {
  test('rotates a proxy session after Firefox connection failures', () => {
    const match = serverSource.match(/function isProxyError\(err\) \{[\s\S]*?\n\}/);

    expect(match).not.toBeNull();
    expect(match[0]).toContain("msg.includes('NS_ERROR_CONNECTION_REFUSED')");
    expect(match[0]).toContain("msg.includes('NS_ERROR_NET_RESET')");
    expect(match[0]).toContain("msg.includes('NS_ERROR_NET_TIMEOUT')");
    expect(match[0]).toContain("msg.includes('NS_ERROR_UNKNOWN_HOST')");
  });
});
