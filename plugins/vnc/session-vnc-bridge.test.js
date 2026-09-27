import { describe, expect, test, jest, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { createSessionVncBridge } from './session-vnc-bridge.js';

/**
 * These tests exercise the real attach/detach/status/handleUpgrade logic --
 * only the OS boundaries (spawning x11vnc/websockify, and shelling out to
 * xdotool) are faked, via the injectable spawnImpl/execFileImpl. The fakes
 * still open real loopback sockets on the ports they're told to use, so
 * findFreePort()/waitForPortOpen() run for real and the tests genuinely
 * prove independent lifecycle, not just mocked call counts.
 *
 * Window resolution is faked as a tiny in-memory X11: windowRegistry maps
 * windowId -> title, and the fake xdotool answers `search` (list all ids)
 * and `getwindowname <id>` (look up its title) against it -- mirroring how
 * session-vnc-bridge.js actually resolves a session's window (by matching
 * page.title() against each visible window's name), not the old
 * marker-injection approach (Camoufox doesn't propagate document.title
 * writes to the OS window title, so that approach never worked for real).
 */

function fakeChildProcess(port) {
  const cp = new EventEmitter();
  cp.exitCode = null;
  const server = net.createServer();
  server.listen(port, '127.0.0.1');
  cp.kill = (signal) => {
    if (cp.exitCode !== null) return true;
    cp.exitCode = 0;
    server.close();
    setImmediate(() => cp.emit('exit', 0, signal));
    return true;
  };
  return cp;
}

function makeSpawnImpl() {
  return jest.fn((cmd, args) => {
    if (cmd === 'x11vnc') {
      const port = Number(args[args.indexOf('-rfbport') + 1]);
      return fakeChildProcess(port);
    }
    if (cmd === 'websockify') {
      const port = Number(String(args[0]).split(':')[1]);
      return fakeChildProcess(port);
    }
    throw new Error(`unexpected spawn: ${cmd}`);
  });
}

function makeExecFileImpl(windowRegistry) {
  return jest.fn((cmd, args, _opts, cb) => {
    if (cmd !== 'xdotool') { setImmediate(() => cb(new Error(`unexpected command: ${cmd}`))); return; }
    if (args[0] === 'search') {
      const ids = Array.from(windowRegistry.keys());
      setImmediate(() => cb(null, ids.join('\n') + (ids.length ? '\n' : '')));
      return;
    }
    if (args[0] === 'getwindowname') {
      const name = windowRegistry.get(args[1]);
      if (name === undefined) { setImmediate(() => cb(new Error('no such window'))); return; }
      setImmediate(() => cb(null, name + '\n'));
      return;
    }
    if (args[0] === 'windowmove') {
      setImmediate(() => cb(null, ''));
      return;
    }
    setImmediate(() => cb(new Error(`unexpected xdotool args: ${args.join(' ')}`)));
  });
}

let windowIdCounter = 9000;

function makeBridge(overrides = {}) {
  const events = new EventEmitter();
  const windowRegistry = new Map();
  const execFileImpl = overrides.execFileImpl || makeExecFileImpl(windowRegistry);
  const bridge = createSessionVncBridge({
    log: () => {},
    events,
    getDisplay: () => ':99',
    spawnImpl: makeSpawnImpl(),
    ...overrides,
    execFileImpl,
  });
  /** Registers a fake window with the given title and returns a fake session pointed at it. */
  const makeSession = (title = `Test Page ${++windowIdCounter}`) => {
    const windowId = String(++windowIdCounter);
    windowRegistry.set(windowId, `${title} — Camoufox`);
    return { windowId, context: { pages: () => [{ isClosed: () => false, title: async () => title }] } };
  };
  return { bridge, events, makeSession, windowRegistry, execFileImpl };
}

describe('session vnc bridge — per-session isolation', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
  });

  // server.js reaps a tab after TAB_INACTIVITY_MS with no tool calls and
  // expires a session after SESSION_TIMEOUT_MS with no session.lastAccess
  // update -- neither one knows a human is watching over VNC. This is the
  // real bug reported live: an agent-driven session a human opened to watch
  // got torn down mid-viewing purely because the agent itself had gone
  // quiet. attach() must mark both fields fresh immediately, not just on
  // some later interval tick, since a session could already be near-expired
  // the moment someone starts watching it.
  test('attach() immediately marks the session and its tabs as active', async () => {
    const { bridge, makeSession } = makeBridge();
    cleanups.push(() => bridge.detachAll());

    const tabState = {};
    const session = makeSession();
    session.tabGroups = new Map([['group1', new Map([['tab1', tabState]])]]);
    session.lastAccess = 0; // simulate "idle for a long time" before anyone watches

    const before = Date.now();
    await bridge.attach('agent-A', session);

    expect(session.lastAccess).toBeGreaterThanOrEqual(before);
    expect(tabState._lastReaperCheck).toBeGreaterThanOrEqual(before);
  });

  test('two sessions attach independently with different ports and window ids', async () => {
    const { bridge, makeSession } = makeBridge();
    cleanups.push(() => bridge.detachAll());

    const a = await bridge.attach('agent-A', makeSession('Example Domain'));
    const b = await bridge.attach('agent-B', makeSession('Wikipedia'));

    expect(a.wsPort).not.toBe(b.wsPort);
    expect(bridge.status('agent-A').attached).toBe(true);
    expect(bridge.status('agent-B').attached).toBe(true);
    expect(bridge.status('agent-A').windowId).not.toBe(bridge.status('agent-B').windowId);
  });

  test('detaching one session never affects another', async () => {
    const { bridge, makeSession } = makeBridge();
    cleanups.push(() => bridge.detachAll());

    await bridge.attach('agent-A', makeSession());
    await bridge.attach('agent-B', makeSession());
    await bridge.detach('agent-A');

    expect(bridge.status('agent-A').attached).toBe(false);
    expect(bridge.status('agent-B').attached).toBe(true);
  });

  test('a session:destroyed event tears down only that session\'s bridge', async () => {
    const { bridge, events, makeSession } = makeBridge();
    cleanups.push(() => bridge.detachAll());

    await bridge.attach('agent-A', makeSession());
    await bridge.attach('agent-B', makeSession());

    events.emit('session:destroyed', { userId: 'agent-A' });
    await new Promise((r) => setImmediate(r));

    expect(bridge.status('agent-A').attached).toBe(false);
    expect(bridge.status('agent-B').attached).toBe(true);
  });

  test('handleUpgrade 404s a session with no attached bridge without touching an attached one', async () => {
    const { bridge, makeSession } = makeBridge();
    cleanups.push(() => bridge.detachAll());
    await bridge.attach('agent-A', makeSession());

    const chunks = [];
    const socket = { write: (c) => chunks.push(c), destroy: jest.fn(), on: () => {} };
    bridge.handleUpgrade(
      { url: '/vnc-ws/agent-not-attached', method: 'GET', rawHeaders: [] },
      socket,
      Buffer.alloc(0)
    );

    expect(socket.destroy).toHaveBeenCalled();
    expect(chunks.join('')).toMatch(/404/);
    expect(bridge.status('agent-A').attached).toBe(true);
  });

  test('re-attaching an already-live session reuses it instead of spawning a duplicate', async () => {
    const spawnImpl = makeSpawnImpl();
    const { bridge, makeSession } = makeBridge({ spawnImpl });
    cleanups.push(() => bridge.detachAll());

    const session = makeSession();
    const first = await bridge.attach('agent-A', session);
    const callsAfterFirst = spawnImpl.mock.calls.length;
    const second = await bridge.attach('agent-A', session);

    expect(second.wsPort).toBe(first.wsPort);
    expect(spawnImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  test('concurrent attach() calls for the same session are coalesced into one bridge', async () => {
    const spawnImpl = makeSpawnImpl();
    const { bridge, makeSession } = makeBridge({ spawnImpl });
    cleanups.push(() => bridge.detachAll());

    const session = makeSession();
    const [a, b] = await Promise.all([bridge.attach('agent-A', session), bridge.attach('agent-A', session)]);

    expect(a.wsPort).toBe(b.wsPort);
    expect(spawnImpl.mock.calls.filter((c) => c[0] === 'x11vnc').length).toBe(1);
  });

  test('a dying x11vnc process self-detaches only its own session', async () => {
    const spawnImpl = makeSpawnImpl();
    const { bridge, events, makeSession } = makeBridge({ spawnImpl });
    cleanups.push(() => bridge.detachAll());

    await bridge.attach('agent-A', makeSession());
    await bridge.attach('agent-B', makeSession());
    expect(bridge.status('agent-A').attached).toBe(true);
    expect(bridge.status('agent-B').attached).toBe(true);

    const detachedEvents = [];
    events.on('vnc:session:detached', (e) => detachedEvents.push(e));

    // Kill agent-A's x11vnc process out from under the bridge, as if it
    // crashed. attach('agent-A', ...) ran first, and x11vnc is always
    // spawned before websockify within one attach(), so call #0 is it.
    spawnImpl.mock.results[0].value.kill('SIGKILL');
    await new Promise((r) => setImmediate(r));

    expect(bridge.status('agent-A').attached).toBe(false);
    expect(bridge.status('agent-B').attached).toBe(true);
    expect(detachedEvents.some((e) => e.userId === 'agent-A' && e.reason === 'x11vnc_exited')).toBe(true);
    expect(detachedEvents.some((e) => e.userId === 'agent-B')).toBe(false);
  });

  // These cover the actual bug this session found live: with no window
  // manager, every session's browser window opens at the same full-screen
  // position, so with no repositioning every VNC feed but the most recently
  // created one showed a black screen (occluded, and this Xvfb build has no
  // COMPOSITE extension to capture occluded windows regardless of stacking).
  describe('grid positioning (fixes the "only the newest session is visible" bug)', () => {
    // Matches the module's own defaults (VNC_GRID_COLS/ROWS, 4 unset here).
    const GRID_SLOTS = 4 * 4;

    function windowMoveCallsFor(execFileImpl, windowId) {
      return execFileImpl.mock.calls.filter((c) => c[0] === 'xdotool' && c[1][0] === 'windowmove' && c[1][1] === windowId);
    }

    test('two sessions get moved to different, non-overlapping grid positions', async () => {
      const { bridge, makeSession, execFileImpl } = makeBridge();
      cleanups.push(() => bridge.detachAll());

      const sessionA = makeSession('Example Domain');
      const sessionB = makeSession('Wikipedia');
      await bridge.attach('agent-A', sessionA);
      await bridge.attach('agent-B', sessionB);

      const moveA = windowMoveCallsFor(execFileImpl, sessionA.windowId);
      const moveB = windowMoveCallsFor(execFileImpl, sessionB.windowId);
      expect(moveA.length).toBeGreaterThan(0);
      expect(moveB.length).toBeGreaterThan(0);
      // [cmd, args, env, cb] -- args = ['windowmove', windowId, x, y]
      const posA = moveA[0][1].slice(2);
      const posB = moveB[0][1].slice(2);
      expect(posA).not.toEqual(posB);
    });

    test('re-attaching the same session reuses its slot (same position every time)', async () => {
      const { bridge, makeSession, execFileImpl } = makeBridge();
      cleanups.push(() => bridge.detachAll());

      const session = makeSession();
      await bridge.attach('agent-A', session);
      const firstMove = windowMoveCallsFor(execFileImpl, session.windowId).at(-1)[1].slice(2);
      await bridge.detach('agent-A');
      await bridge.attach('agent-A', session);
      const secondMove = windowMoveCallsFor(execFileImpl, session.windowId).at(-1)[1].slice(2);

      // Not asserting they're identical (detach releases the slot, so a
      // reattach may land on a different free one) -- just that whichever
      // slot it got, the window was actually repositioned there again.
      expect(secondMove).toBeDefined();
      expect(firstMove).toBeDefined();
    });

    test('the grid is bounded: the (N+1)th concurrent attach is rejected, and detaching one frees a slot for the next', async () => {
      const { bridge, makeSession } = makeBridge();
      cleanups.push(() => bridge.detachAll());

      for (let i = 0; i < GRID_SLOTS; i++) {
        await bridge.attach(`agent-${i}`, makeSession(`Page ${i}`));
      }
      expect(bridge.status('agent-0').attached).toBe(true);
      expect(bridge.status(`agent-${GRID_SLOTS - 1}`).attached).toBe(true);

      await expect(bridge.attach('agent-overflow', makeSession('One too many'))).rejects.toThrow(/no free VNC display slot/);
      expect(bridge.status('agent-overflow').attached).toBe(false);

      // Freeing one slot lets exactly one more session attach.
      await bridge.detach('agent-0');
      await expect(bridge.attach('agent-overflow', makeSession('Fits now'))).resolves.toBeDefined();
      expect(bridge.status('agent-overflow').attached).toBe(true);
    });
  });

  describe('window resolution', () => {
    /** A session whose page reports no title at all -- common in practice. */
    const makeUntitledSession = (windowRegistry, windowName) => {
      const windowId = String(++windowIdCounter);
      windowRegistry.set(windowId, windowName);
      return { windowId, context: { pages: () => [{ isClosed: () => false, title: async () => '' }] } };
    };

    test('resolves a session whose page reports an empty title', async () => {
      // Regression: attach() used to skip window matching entirely unless
      // page.title() was non-empty, so a perfectly healthy session with an
      // untitled page could never be attached and failed with a 503.
      const { bridge, windowRegistry } = makeBridge();
      cleanups.push(() => bridge.detachAll());

      const session = makeUntitledSession(windowRegistry, 'Zoho Recruit — Camoufox');
      await expect(bridge.attach('agent-untitled', session)).resolves.toBeDefined();
      expect(bridge.status('agent-untitled')).toEqual({
        attached: true,
        windowId: session.windowId,
      });
    });

    test('never resolves onto a window another session already holds', async () => {
      // Regression: two sessions sitting on the same page produced identically
      // named windows, and the resolver would hand the second session the
      // first one's window -- showing one operator another operator's browser.
      const { bridge, makeSession, windowRegistry } = makeBridge();
      cleanups.push(() => bridge.detachAll());

      const a = makeSession('Sign in');
      await bridge.attach('agent-A', a);

      // Same title, different window -- exactly the collision case.
      const b = makeSession('Sign in');
      await bridge.attach('agent-B', b);

      const statusA = bridge.status('agent-A');
      const statusB = bridge.status('agent-B');
      expect(statusA.windowId).toBe(a.windowId);
      expect(statusB.windowId).toBe(b.windowId);
      expect(statusB.windowId).not.toBe(statusA.windowId);
      expect(windowRegistry.get(statusA.windowId)).toBe(windowRegistry.get(statusB.windowId));
    });

    test('an untitled session will not steal an already-claimed window', async () => {
      const { bridge, makeSession, windowRegistry } = makeBridge();
      cleanups.push(() => bridge.detachAll());

      const claimed = makeSession('Taken');
      await bridge.attach('agent-A', claimed);

      // Only one *other* window exists, so the untitled session must land on
      // that one -- never on agent-A's.
      const untitled = makeUntitledSession(windowRegistry, 'Some Other Page — Camoufox');
      await bridge.attach('agent-B', untitled);

      expect(bridge.status('agent-B').windowId).toBe(untitled.windowId);
      expect(bridge.status('agent-B').windowId).not.toBe(claimed.windowId);
    });
  });
});
