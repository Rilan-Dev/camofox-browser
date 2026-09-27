/**
 * Per-session VNC bridge.
 *
 * The global vnc-watcher (vnc-launcher.js) attaches ONE x11vnc to the whole
 * shared Xvfb display. That is fine for a single supervisor overview, but
 * every session's BrowserContext (see getSession() in server.js) opens its
 * own top-level browser window on that SAME display -- so a single VNC feed
 * shows every session's window overlaid on top of every other one, and
 * "the latest session" visually replaces whichever one a viewer had open.
 *
 * This module gives each session its own independently addressable live
 * view: on attach() it locates that session's specific X11 window and spins
 * up a DEDICATED x11vnc (clipped to just that window via -id) paired with a
 * dedicated websockify instance. The heavy parts (Xvfb, the browser process
 * itself) stay shared; only the VNC *capture* is isolated per session, which
 * is why this scales to many concurrent interactive sessions cheaply.
 *
 * Invariant this module exists to enforce: attaching, detaching, or closing
 * one session's view must never affect any other session's bridge -- there
 * is no shared/global "current" VNC connection here, only a Map keyed by
 * userId.
 */

import { spawn } from './spawn.js';
import net from 'node:net';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOW_LOOKUP_TIMEOUT_MS = 4000;
const WINDOW_LOOKUP_POLL_MS = 120;
const VNC_READY_TIMEOUT_MS = 2500;
const VNC_READY_POLL_MS = 100;
const VNC_PORT_RANGE_START = 16100;
const WS_PORT_RANGE_START = 16300;
const PORT_RANGE_SIZE = 400;
// How long to let a bridge child exit on SIGTERM before SIGKILLing it.
const PROC_KILL_GRACE_MS = 2000;

// server.js reaps a tab after TAB_INACTIVITY_MS (default 5 min) with no
// Playwright tool calls, and expires a whole session after SESSION_TIMEOUT_MS
// of no session.lastAccess update -- neither one has any way to know a human
// is watching a tab live over VNC, since watching never calls any of the
// REST endpoints that normally touch those fields. Left alone, a session an
// agent has stopped actively driving gets torn out from under a viewer
// mid-session purely because nobody happened to click anything. While a
// bridge is attached, touch the SAME activity fields the reaper reads --
// directly on the live `session`/`tabState` objects server.js already holds
// (this module receives that exact reference, not a copy) -- often enough
// to always beat the shortest configured inactivity window.
const KEEPALIVE_INTERVAL_MS = 30_000;

// There's no window manager on this Xvfb display, so every session's
// browser window opens "maximized" to the full screen regardless of how
// many sessions exist -- they all land on the exact same on-screen
// rectangle. x11vnc's -id mode has no COMPOSITE extension available on
// this Xvfb build to fall back on for capturing occluded/off-screen window
// content, so it just reads whatever's on top of that shared rectangle:
// only the most-recently-created window was ever visible, every other
// session's feed showed a black screen.
//
// Fix: give each concurrently-attached session its own non-overlapping
// slot in a grid on a much larger virtual screen (camofox.config.json's
// vnc.resolution must be >= GRID_COLS*CELL_WIDTH x GRID_ROWS*CELL_HEIGHT),
// and reposition (never resize) that session's window into its slot before
// spawning x11vnc. Repositioning only -- not resizing -- matters because
// server.js's contextOptions use `viewport: null`, so the OS window's size
// *is* the page's viewport; shrinking it to tile more sessions would change
// what an agent's automation actually sees mid-session. The grid is
// intentionally bounded rather than growing per session (unlike the port
// ranges above) so memory stays predictable regardless of MAX_SESSIONS.
const GRID_COLS = Number(process.env.VNC_GRID_COLS || 4);
const GRID_ROWS = Number(process.env.VNC_GRID_ROWS || 4);
const CELL_WIDTH = Number(process.env.VNC_GRID_CELL_WIDTH || 1920);
const CELL_HEIGHT = Number(process.env.VNC_GRID_CELL_HEIGHT || 1080);

function execFileP(execFileImpl, cmd, args, env) {
  return new Promise((resolve, reject) => {
    execFileImpl(cmd, args, { timeout: 3000, env }, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout);
    });
  });
}

async function findFreePort(startFrom, taken) {
  for (let p = startFrom; p < startFrom + PORT_RANGE_SIZE; p++) {
    if (taken.has(p)) continue;
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error(`no free port available starting from ${startFrom}`);
}

/**
 * Marks a session (and every one of its currently-open tabs) as recently
 * used, matching exactly what server.js's own request handlers already do
 * (`session.lastAccess = Date.now()`) and what its per-tab reaper reads
 * (`tabState._lastReaperCheck`) -- so a session/tab being watched live
 * over VNC reads as active to both of server.js's own inactivity checks,
 * without needing server.js to know anything about VNC at all.
 */
function touchSessionActivity(session) {
  session.lastAccess = Date.now();
  if (!session.tabGroups) return;
  const now = Date.now();
  for (const group of session.tabGroups.values()) {
    for (const tabState of group.values()) {
      tabState._lastReaperCheck = now;
    }
  }
}

async function waitForPortOpen(port, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * Pick a real, currently-open tab's Page for this session.
 *
 * session.context.pages() is NOT reliable for this: Playwright/Camoufox
 * contexts commonly carry an extra untracked page (e.g. an initial
 * about:blank opened before the first navigation) that isn't one of the
 * server's own tabs, so pages()[0] can resolve to the wrong X11 window
 * entirely. server.js's own bookkeeping in session.tabGroups (a
 * Map<listItemId, Map<tabId, tabState>>, tabState.page) is the source of
 * truth for "which pages are actually this session's tabs" -- use that
 * first, and only fall back to context.pages() if it's empty.
 */
function pickActivePage(session) {
  if (session.tabGroups) {
    for (const group of session.tabGroups.values()) {
      for (const tabState of group.values()) {
        if (tabState?.page && !tabState.page.isClosed()) return tabState.page;
      }
    }
  }
  const pages = session.context.pages().filter((p) => !p.isClosed());
  return pages[0] ?? null;
}

/**
 * Resolve the X11 window id backing a session's browser context by matching
 * its active page's REAL title (Playwright's page.title(), i.e. document's
 * actual current title) against each visible window's WM_NAME.
 *
 * This does NOT use the obvious alternative -- momentarily overwriting
 * document.title with a unique marker via page.evaluate() -- because
 * Camoufox does not propagate a script-driven document.title assignment to
 * the OS window title at all (confirmed empirically: xdotool never sees the
 * marker, even though manually retitling the same window via
 * `xdotool set_window --name` and searching for it works instantly). Firefox
 * *does* sync the window title from the real page title on navigation
 * (observed as "<page title> — Camoufox"), so matching against that,
 * read-only, is the reliable signal instead.
 *
 * Title matching alone is NOT sufficient, for two reasons seen in practice:
 *
 *   1. page.title() comes back empty for plenty of real pages (and Camoufox
 *      returns '' more often than Firefox does), while the OS window is named
 *      perfectly well. The old code skipped matching entirely when the title
 *      was empty, so attach() could never resolve a window and failed with a
 *      503 "could not locate a browser window" -- for a session that was
 *      running fine.
 *   2. Two sessions can legitimately sit on the same page at the same moment
 *      (two agents on the same login screen, say), giving their windows
 *      identical names. Picking one arbitrarily risks showing operator A a
 *      live view of operator B's browser, which breaks the isolation this
 *      whole per-session bridge exists to provide.
 *
 * So `claimedByOthers` -- the windows other live sessions are already bound
 * to -- is always excluded first, and an unambiguous single remaining
 * candidate is accepted even with no title to match on. Anything still
 * genuinely ambiguous returns null rather than guessing wrong.
 */
async function resolveSessionWindowId(session, display, execFileImpl, claimedByOthers = new Set()) {
  const page = pickActivePage(session);
  if (!page) return null;

  const env = { ...process.env, DISPLAY: display };
  const deadline = Date.now() + WINDOW_LOOKUP_TIMEOUT_MS;

  for (;;) {
    const title = await page.title().catch(() => '');
    try {
      const idsOut = await execFileP(execFileImpl, 'xdotool', ['search', '--onlyvisible', ''], env);
      const ids = idsOut.trim().split('\n').filter(Boolean);

      // Only ever consider windows no other session has claimed, and skip
      // unnamed ones (Xvfb has a handful of nameless utility/root windows).
      const candidates = [];
      for (const id of ids) {
        if (claimedByOthers.has(id)) continue;
        try {
          const name = (await execFileP(execFileImpl, 'xdotool', ['getwindowname', id], env)).trim();
          if (name) candidates.push({ id, name });
        } catch {
          // window closed between search and getwindowname -- skip it
        }
      }

      if (title) {
        const titled = candidates.filter((c) => c.name === title || c.name.startsWith(`${title} — `));
        if (titled.length === 1) return titled[0].id;
        // Several unclaimed windows share this title. They can only belong to
        // this session (everyone else's are excluded above), so either is a
        // correct answer -- take the first rather than stalling.
        if (titled.length > 1) return titled[0].id;
      } else if (candidates.length === 1) {
        // No title to match on, but exactly one window is unspoken for, so it
        // is unambiguously this session's.
        return candidates[0].id;
      }
    } catch {
      // xdotool search itself failed -- keep polling
    }
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, WINDOW_LOOKUP_POLL_MS));
  }
}

/**
 * @param {object} opts
 * @param {(msg: string, meta?: object) => void} opts.log - matches server.js's `log(level, msg, meta)`
 * @param {import('node:events').EventEmitter} opts.events - the shared pluginEvents bus
 * @param {() => string | null} opts.getDisplay - returns the shared Xvfb display (e.g. ":99"), or null if not ready
 * @param {boolean} [opts.viewOnly]
 * @param {string | null} [opts.passFile] - x11vnc rfbauth password file, or null for -nopw
 * @param {typeof spawn} [opts.spawnImpl] - injectable for tests; defaults to the real child_process.spawn
 * @param {typeof execFile} [opts.execFileImpl] - injectable for tests; defaults to the real child_process.execFile
 */
export function createSessionVncBridge({
  log,
  events,
  getDisplay,
  viewOnly = false,
  passFile = null,
  spawnImpl = spawn,
  execFileImpl = execFile,
}) {
  /** @type {Map<string, { windowId: string, vncProc: import('node:child_process').ChildProcess, wsProc: import('node:child_process').ChildProcess, vncPort: number, wsPort: number, createdAt: number }>} */
  const bridges = new Map();
  const takenPorts = new Set();
  /** In-flight attach() calls, coalesced so concurrent attach requests for the same session don't race-spawn duplicate processes. */
  const pending = new Map();

  const GRID_SLOTS = GRID_COLS * GRID_ROWS;
  /** userId -> slot index, and the reverse set of slots currently in use. */
  const slotByUserId = new Map();
  const usedSlots = new Set();

  function allocateSlot(userId) {
    const existing = slotByUserId.get(userId);
    if (existing !== undefined) return existing;
    for (let i = 0; i < GRID_SLOTS; i++) {
      if (!usedSlots.has(i)) {
        usedSlots.add(i);
        slotByUserId.set(userId, i);
        return i;
      }
    }
    throw Object.assign(
      new Error(`no free VNC display slot (${GRID_SLOTS} in use) -- detach another session's live view first`),
      { statusCode: 503 }
    );
  }

  function releaseSlot(userId) {
    const slot = slotByUserId.get(userId);
    if (slot === undefined) return;
    slotByUserId.delete(userId);
    usedSlots.delete(slot);
  }

  /** Moves windowId to its assigned grid cell so it no longer overlaps any other attached session's window. Never resizes it. */
  async function moveWindowToSlot(windowId, slot, display) {
    const col = slot % GRID_COLS;
    const row = Math.floor(slot / GRID_COLS);
    const x = col * CELL_WIDTH;
    const y = row * CELL_HEIGHT;
    const env = { ...process.env, DISPLAY: display };
    await execFileP(execFileImpl, 'xdotool', ['windowmove', windowId, String(x), String(y)], env);
  }

  function releasePorts(vncPort, wsPort) {
    takenPorts.delete(vncPort);
    takenPorts.delete(wsPort);
  }

  /**
   * Stop a bridge child process for good.
   *
   * x11vnc is started with -forever, and in that mode it does NOT exit on
   * SIGTERM -- verified against real leaked processes, which sat there through
   * repeated SIGTERMs and only died on SIGKILL. Sending only SIGTERM (what
   * this code used to do on every detach) is why orphaned x11vnc processes
   * accumulated, each holding an rfbport until the container was restarted.
   * So: ask nicely, then insist.
   */
  function killProc(proc) {
    if (!proc || proc.exitCode !== null) return;
    try { proc.kill('SIGTERM'); } catch { return; }
    setTimeout(() => {
      if (proc.exitCode === null) {
        try { proc.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, PROC_KILL_GRACE_MS).unref?.();
  }

  /**
   * Kill any x11vnc still bound to `windowId` that this bridge no longer
   * tracks. x11vnc is started with -forever, so it survives its client
   * disconnecting; if the process that owned it went away without a clean
   * detach (server restart, killed websockify partner, crash), it lingers
   * forever holding an rfbport and a slot's worth of memory. Scoped to the
   * one window we are about to attach to, so it can never disturb another
   * session's live bridge.
   */
  async function reapOrphanedVncForWindow(windowId, userId) {
    const live = new Set();
    for (const [otherUserId, entry] of bridges) {
      if (otherUserId !== userId && entry.vncProc && entry.vncProc.pid) live.add(entry.vncProc.pid);
    }
    try {
      const out = await execFileP(execFileImpl, 'pgrep', ['-fa', `x11vnc .*-id ${windowId} `], {});
      for (const line of out.trim().split('\n').filter(Boolean)) {
        const pid = Number(line.split(/\s+/)[0]);
        if (!pid || live.has(pid)) continue;
        try {
          // SIGKILL, not SIGTERM: x11vnc running with -forever does not exit
          // on SIGTERM (verified against the leaked processes this reaper
          // exists to clean up -- they survived repeated SIGTERMs and only
          // went away on SIGKILL). Nothing here needs a graceful shutdown;
          // the process is already orphaned by definition.
          process.kill(pid, 'SIGKILL');
          log('info', 'reaped orphaned x11vnc', { userId, windowId, pid });
        } catch {
          // already gone, or not ours to kill
        }
      }
    } catch {
      // pgrep exits non-zero when nothing matches -- that's the common case
    }
  }

  function isAlive(entry) {
    return !!entry && entry.vncProc.exitCode === null && entry.wsProc.exitCode === null;
  }

  async function doAttach(userId, session) {
    const existing = bridges.get(userId);
    if (isAlive(existing)) return { wsPort: existing.wsPort };
    if (existing) await doDetach(userId);

    const display = getDisplay();
    if (!display) {
      throw Object.assign(new Error('VNC display is not ready yet'), { statusCode: 503 });
    }

    // Windows other live bridges are bound to are off-limits -- never resolve
    // one session's view onto another session's window.
    const claimedByOthers = new Set();
    for (const [otherUserId, entry] of bridges) {
      if (otherUserId !== userId && entry.windowId) claimedByOthers.add(entry.windowId);
    }

    const windowId = await resolveSessionWindowId(session, display, execFileImpl, claimedByOthers);
    if (!windowId) {
      throw Object.assign(
        new Error('Could not locate a browser window for this session'),
        { statusCode: 503 },
      );
    }

    // Any x11vnc left over from an earlier bridge for this same window would
    // keep holding its rfbport (x11vnc runs with -forever, so it outlives the
    // client that was watching it). Clear those out before spawning a new one
    // -- otherwise repeated attach/detach cycles pile up orphaned processes.
    await reapOrphanedVncForWindow(windowId, userId);

    // Claim (or reuse) this session's grid slot and move its window there --
    // every attach(), not just the first, so a stale position from a prior
    // attach/detach cycle can never linger. See the GRID_COLS comment above.
    const slot = allocateSlot(userId);
    try {
      await moveWindowToSlot(windowId, slot, display);
    } catch (err) {
      releaseSlot(userId);
      throw Object.assign(new Error(`could not position this session's window: ${err.message}`), { statusCode: 503 });
    }

    const vncPort = await findFreePort(VNC_PORT_RANGE_START, takenPorts);
    takenPorts.add(vncPort);
    const wsPort = await findFreePort(WS_PORT_RANGE_START, takenPorts);
    takenPorts.add(wsPort);

    const logPath = path.join(os.tmpdir(), `camofox-x11vnc-${userId}.log`);
    const logFd = fs.openSync(logPath, 'a');

    const vncArgs = [
      '-display', display,
      '-id', windowId,
      '-forever', '-shared', '-localhost',
      '-rfbport', String(vncPort),
      '-noxdamage', '-quiet',
    ];
    if (viewOnly) vncArgs.push('-viewonly');
    if (passFile) vncArgs.push('-rfbauth', passFile);
    else vncArgs.push('-nopw');

    const vncProc = spawnImpl('x11vnc', vncArgs, { stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);

    const vncReady = await waitForPortOpen(vncPort, VNC_READY_TIMEOUT_MS, VNC_READY_POLL_MS);
    if (!vncReady) {
      killProc(vncProc);
      releaseSlot(userId);
      releasePorts(vncPort, wsPort);
      throw Object.assign(new Error('x11vnc did not become ready in time'), { statusCode: 503 });
    }

    const wsProc = spawnImpl('websockify', [`127.0.0.1:${wsPort}`, `127.0.0.1:${vncPort}`], { stdio: 'ignore' });

    touchSessionActivity(session); // don't wait a full KEEPALIVE_INTERVAL_MS for the first tick
    const keepAliveTimer = setInterval(() => touchSessionActivity(session), KEEPALIVE_INTERVAL_MS);

    const entry = { windowId, vncProc, wsProc, vncPort, wsPort, keepAliveTimer, createdAt: Date.now() };
    bridges.set(userId, entry);

    const onExit = (who) => () => {
      const current = bridges.get(userId);
      if (current !== entry) return; // superseded by a newer attach()
      bridges.delete(userId);
      releasePorts(vncPort, wsPort);
      releaseSlot(userId);
      clearInterval(keepAliveTimer);
      log('warn', 'session vnc bridge process exited', { userId, who });
      killProc(entry.vncProc);
      killProc(entry.wsProc);
      events.emit('vnc:session:detached', { userId, reason: `${who}_exited` });
    };
    vncProc.on('exit', onExit('x11vnc'));
    wsProc.on('exit', onExit('websockify'));
    vncProc.on('error', (err) => log('error', 'x11vnc failed to start', { userId, error: err.message }));
    wsProc.on('error', (err) => log('error', 'websockify failed to start', { userId, error: err.message }));

    log('info', 'session vnc attached', { userId, windowId, vncPort, wsPort });
    events.emit('vnc:session:attached', { userId, windowId });
    return { wsPort };
  }

  async function attach(userId, session) {
    const inFlight = pending.get(userId);
    if (inFlight) return inFlight;
    const p = doAttach(userId, session).finally(() => pending.delete(userId));
    pending.set(userId, p);
    return p;
  }

  async function doDetach(userId) {
    const entry = bridges.get(userId);
    if (!entry) return false;
    bridges.delete(userId);
    releasePorts(entry.vncPort, entry.wsPort);
    releaseSlot(userId);
    clearInterval(entry.keepAliveTimer);
    killProc(entry.vncProc);
    killProc(entry.wsProc);
    log('info', 'session vnc detached', { userId });
    events.emit('vnc:session:detached', { userId, reason: 'explicit' });
    return true;
  }

  async function detach(userId) {
    // If an attach() for this session is still in flight, wait for it to
    // settle first -- otherwise it could finish *after* this detach and
    // leave a live bridge nobody asked for anymore.
    const inFlight = pending.get(userId);
    if (inFlight) {
      try { await inFlight; } catch { /* attach failed on its own -- nothing to detach */ }
    }
    pending.delete(userId);
    return doDetach(userId);
  }

  function status(userId) {
    const entry = bridges.get(userId);
    return { attached: isAlive(entry), windowId: entry?.windowId ?? null };
  }

  function detachAll() {
    return Promise.all(Array.from(bridges.keys()).map((userId) => detach(userId)));
  }

  /** Express `server.on('upgrade', ...)` handler for `/vnc-ws/:userId` -- proxies the raw WS to that session's dedicated websockify instance. Never touches any other session's bridge. */
  function handleUpgrade(req, socket, head) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://internal').pathname;
    } catch {
      socket.destroy();
      return;
    }
    const match = pathname.match(/^\/vnc-ws\/([^/]+)\/?$/);
    if (!match) {
      socket.destroy();
      return;
    }
    const userId = decodeURIComponent(match[1]);
    const entry = bridges.get(userId);
    if (!isAlive(entry)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const upstream = net.connect(entry.wsPort, '127.0.0.1', () => {
      let headerBlock = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        headerBlock += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      headerBlock += '\r\n';
      upstream.write(headerBlock);
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const cleanup = () => { try { upstream.destroy(); } catch {} try { socket.destroy(); } catch {} };
    upstream.on('error', cleanup);
    socket.on('error', cleanup);
  }

  // Never leak a bridge past the session it belongs to.
  events.on('session:destroyed', ({ userId }) => { detach(userId).catch(() => {}); });
  events.on('server:shutdown', () => { detachAll().catch(() => {}); });

  return { attach, detach, status, handleUpgrade, detachAll };
}
