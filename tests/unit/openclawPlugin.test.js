import { jest } from '@jest/globals';
import register from '../../plugin.js';

describe('OpenClaw plugin registration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('registers scoped gateway health methods using the current API', async () => {
    const gatewayMethods = new Map();
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'ok', engine: 'camoufox' }),
    }));
    global.fetch = fetchMock;

    register({
      config: {},
      pluginConfig: { autoStart: false },
      logger: { info: jest.fn(), error: jest.fn() },
      registerTool: jest.fn(),
      registerCommand: jest.fn(),
      registerCli: jest.fn(),
      registerGatewayMethod: (name, handler, options) => {
        gatewayMethods.set(name, { handler, options });
      },
    });

    expect(gatewayMethods.get('camofox.health').options).toEqual({ scope: 'operator.admin' });
    expect(gatewayMethods.get('camofox.status').options).toEqual({ scope: 'operator.admin' });

    const respond = jest.fn();
    await gatewayMethods.get('camofox.health').handler({ params: {}, respond });

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:9377/health', expect.any(Object));
    expect(respond).toHaveBeenCalledWith(true, {
      status: 'ok',
      engine: 'camoufox',
    });
  });
});
