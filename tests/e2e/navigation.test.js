import { createClient } from '../helpers/client.js';
import { getSharedEnv } from './sharedEnv.js';

describe('Navigation', () => {
  let serverUrl;
  let testSiteUrl;
  
  beforeAll(() => {
    const env = getSharedEnv();
    serverUrl = env.serverUrl;
    testSiteUrl = env.testSiteUrl;
  });
  
  // Server lifecycle managed by globalSetup/globalTeardown
  
  test('navigate to URL', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab();
      
      const result = await client.navigate(tabId, `${testSiteUrl}/pageA`);
      
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageA');
      
      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Welcome to Page A');
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigates to a bare image without ending the shared session', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId: existingTabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const { tabId } = await client.createTab();
      const result = await client.navigate(tabId, `${testSiteUrl}/bare-image`);

      expect(result.ok).toBe(true);
      expect(result.url).toContain('/bare-image');

      const existingTabSnapshot = await client.getSnapshot(existingTabId);
      expect(existingTabSnapshot.snapshot).toContain('Welcome to Page A');
    } finally {
      await client.cleanup();
    }
  });

  test('keeps sibling tabs alive when a no-proxy navigation times out', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId: existingTabId } = await client.createTab(`${testSiteUrl}/pageA`);
      const { tabId } = await client.createTab();

      await expect(client.request(
        'POST',
        `/tabs/${tabId}/navigate`,
        { userId: client.userId, url: `${testSiteUrl}/slow-navigation` },
        { timeout: 45000 },
      )).rejects.toMatchObject({ status: 500 });

      const existingTabSnapshot = await client.getSnapshot(existingTabId);
      expect(existingTabSnapshot.snapshot).toContain('Welcome to Page A');
    } finally {
      await client.cleanup();
    }
  }, 60000);

  test('reports a destination 404 without discarding the rendered page', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab();
      const result = await client.navigate(tabId, `${testSiteUrl}/not-found`);

      expect(result).toMatchObject({ ok: true, httpStatus: 404, navigationOk: false });
      const snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Cannot GET /not-found');
    } finally {
      await client.cleanup();
    }
  });

  test('reports a destination 404 from an initial URL without discarding the rendered page', async () => {
    const client = createClient(serverUrl);

    try {
      const result = await client.createTab(`${testSiteUrl}/not-found`);

      expect(result).toMatchObject({ httpStatus: 404, navigationOk: false });
      const snapshot = await client.getSnapshot(result.tabId);
      expect(snapshot.snapshot).toContain('Cannot GET /not-found');
    } finally {
      await client.cleanup();
    }
  });

  test('does not report an upstream 503 page as a successful navigation', async () => {
    const client = createClient(serverUrl);

    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.getSnapshot(tabId);
      await expect(client.navigate(tabId, `${testSiteUrl}/unavailable`)).rejects.toMatchObject({
        status: 502,
        data: expect.objectContaining({ code: 'destination_unavailable' }),
      });
      const snapshot = await client.getSnapshot(tabId, { offset: 1 });
      expect(snapshot.snapshot).toContain('Temporarily unavailable');
    } finally {
      await client.cleanup();
    }
  });

  test('navigate back', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);
      
      // Verify we're on page B
      let snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page B');
      
      // Go back
      const result = await client.back(tabId);
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageA');
      
      snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page A');
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigate forward', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);
      await client.back(tabId);
      
      // Verify we're back on page A
      let snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page A');
      
      // Go forward
      const result = await client.forward(tabId);
      expect(result.ok).toBe(true);
      expect(result.url).toContain('/pageB');
      
      snapshot = await client.getSnapshot(tabId);
      expect(snapshot.snapshot).toContain('Page B');
    } finally {
      await client.cleanup();
    }
  });
  
  test('refresh page', async () => {
    const client = createClient(serverUrl);
    
    try {
      // Use the refresh counter page
      const { tabId } = await client.createTab(`${testSiteUrl}/refresh-test`);
      
      let snapshot = await client.getSnapshot(tabId);
      const initialMatch = snapshot.snapshot.match(/Count: (\d+)/);
      const initialCount = initialMatch ? parseInt(initialMatch[1]) : 0;
      
      // Refresh the page
      const result = await client.refresh(tabId);
      expect(result.ok).toBe(true);
      
      snapshot = await client.getSnapshot(tabId);
      const newMatch = snapshot.snapshot.match(/Count: (\d+)/);
      const newCount = newMatch ? parseInt(newMatch[1]) : 0;
      
      // Count should have incremented
      expect(newCount).toBe(initialCount + 1);
    } finally {
      await client.cleanup();
    }
  });
  
  test('navigation updates visited URLs', async () => {
    const client = createClient(serverUrl);
    
    try {
      const { tabId } = await client.createTab(`${testSiteUrl}/pageA`);
      await client.navigate(tabId, `${testSiteUrl}/pageB`);
      
      const stats = await client.getStats(tabId);
      
      expect(stats.visitedUrls).toContain(`${testSiteUrl}/pageA`);
      expect(stats.visitedUrls).toContain(`${testSiteUrl}/pageB`);
    } finally {
      await client.cleanup();
    }
  });
});
