/**
 * VNC plugin for camofox-browser.
 *
 * Exposes Camoufox's virtual display via noVNC so a human can interact with
 * the browser visually -- log into sites, solve CAPTCHAs, approve OAuth prompts.
 * After interactive login, export the storage state via the API endpoint this
 * plugin registers.
 *
 * Architecture:
 *   Plugin replaces the default 1x1 Xvfb with a 1920x1080 display (via
 *   ctx.createVirtualDisplay factory override). vnc-watcher.sh detects the
 *   Xvfb process, attaches x11vnc, and noVNC (websockify) proxies it to a
 *   web UI on port 6080.
 *
 * Configuration (camofox.config.json):
 *   {
 *     "plugins": {
 *       "vnc": {
 *         "enabled": true,
 *         "resolution": "1920x1080",
 *         "password": "",
 *         "viewOnly": false,
 *         "vncPort": 5900,
 *         "novncPort": 6080
 *       }
 *     }
 *   }
 *
 * Or via environment variables (override config):
 *   ENABLE_VNC=1           Enable the plugin
 *   VNC_RESOLUTION=1920x1080
 *   VNC_PASSWORD=secret    Optional password for x11vnc
 *   VIEW_ONLY=1            View-only mode (no mouse/keyboard input)
 *   VNC_PORT=5900          x11vnc listen port
 *   NOVNC_PORT=6080        noVNC web UI port
 *
 * Registers:
 *   GET /vnc/status -- report watcher state and configured ports
 *   GET /sessions/:userId/storage_state -- export Playwright storageState as JSON
 *   POST /sessions/:userId/vnc/attach -- start this session's own independent VNC bridge
 *   POST /sessions/:userId/vnc/detach -- tear it down (the browser/session itself keeps running)
 *   GET /sessions/:userId/vnc/status  -- whether this session's bridge is currently live
 *   Upgrades ws://…/vnc-ws/:userId    -- proxies straight through to that session's bridge
 *
 * Every session gets its OWN x11vnc + websockify pair, clipped to that
 * session's specific browser window (see session-vnc-bridge.js) -- there is
 * no shared/global "current" VNC connection. Attaching, detaching, or
 * closing one session's view never affects another session's view.
 *
 * Events emitted:
 *   vnc:watcher:started      { pid }
 *   vnc:watcher:stopped      { code, signal }
 *   vnc:storage:exported     { userId, cookies, origins }
 *   vnc:session:attached     { userId, windowId }
 *   vnc:session:detached     { userId, reason }
 */

import { resolveVncConfig, startWatcher } from './vnc-launcher.js';
import { createSessionVncBridge } from './session-vnc-bridge.js';
import { requireAuth, timingSafeCompare } from '../../lib/auth.js';
import { removeXvfbDisplayFiles } from '../../lib/tmp-cleanup.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

const WS_TICKET_TTL_MS = 30_000;

/**
 * Short-lived WebSocket tickets for /vnc-ws/:userId.
 *
 * A native browser WebSocket can't send an Authorization header, so the
 * upgrade handshake can't reuse requireAuth() directly. Rather than accept
 * the long-lived master apiKey/accessKey as a URL query param (it would sit
 * in server access logs, browser history, and Referer headers for as long
 * as that key is valid), POST /sessions/:userId/vnc/attach -- itself gated
 * by the normal Authorization-header auth -- mints a ticket bound to that
 * one userId, good for WS_TICKET_TTL_MS. The secret lives only in this
 * process's memory: a restart invalidates every outstanding ticket, which
 * is fine given how short their TTL is.
 *
 * Deliberately NOT single-use: the noVNC client in /api/vnc/[id]'s page
 * reconnects with the SAME ticket (up to twice, within ~2-4s of the first
 * attempt -- see connectVNC()'s retry logic) if the RFB handshake drops
 * before fully connecting. Consuming the ticket on first use would turn
 * every one of those into a hard 403 instead of a transparent retry. The
 * TTL alone still bounds exposure to WS_TICKET_TTL_MS, which is the
 * property that actually matters here.
 */
function createWsTicketIssuer() {
  const secret = crypto.randomBytes(32);

  function sign(payloadB64) {
    return crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  }

  function mint(userId) {
    const payload = { userId, exp: Date.now() + WS_TICKET_TTL_MS };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${payloadB64}.${sign(payloadB64)}`;
  }

  /** Verifies the ticket is well-formed, unexpired, and bound to `userId`. */
  function verify(ticket, userId) {
    if (!ticket || typeof ticket !== 'string') return false;
    const dot = ticket.lastIndexOf('.');
    if (dot < 0) return false;
    const payloadB64 = ticket.slice(0, dot);
    const sig = ticket.slice(dot + 1);
    if (!timingSafeCompare(sig, sign(payloadB64))) return false;

    let payload;
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      return false;
    }
    if (payload.userId !== userId) return false;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return false;

    return true;
  }

  return { mint, verify };
}

export async function register(app, ctx, pluginConfig = {}) {
  const { events, config, log, sessions, VirtualDisplay, safeError } = ctx;

  // Resolve all config (env vars + pluginConfig) via the launcher module
  const vncConfig = resolveVncConfig(pluginConfig);

  if (!vncConfig.enabled) {
    log('info', 'vnc plugin: disabled (set ENABLE_VNC=1 or plugins.vnc.enabled=true)');
    return;
  }

  // --- Override Xvfb resolution ---
  const { resolution } = vncConfig;

  class VncVirtualDisplay extends VirtualDisplay {
    get xvfb_args() {
      const args = super.xvfb_args;
      const idx = args.indexOf('0');
      if (idx > 0 && args[idx - 1] === '-screen') {
        const patched = [...args];
        patched[idx + 1] = resolution;
        return patched;
      }
      return args;
    }

    kill() {
      const proc = this.proc;
      if (!proc || this.xvfbDisplayFilesCleanupRegistered) return super.kill();

      this.xvfbDisplayFilesCleanupRegistered = true;
      const cleanup = () => removeXvfbDisplayFiles(this.display);
      if (proc.exitCode === null) proc.once('exit', cleanup);
      else cleanup();
      return super.kill();
    }
  }

  ctx.createVirtualDisplay = () => new VncVirtualDisplay();
  log('info', 'vnc plugin: overriding Xvfb resolution', { resolution });

  // --- VNC watcher process ---
  log('info', 'vnc plugin enabled', {
    resolution,
    novncPort: vncConfig.novncPort,
    vncPort: vncConfig.vncPort,
    viewOnly: vncConfig.viewOnly,
    passwordProtected: !!vncConfig.vncPassword,
  });

  const watcher = startWatcher({
    resolution: vncConfig.resolution,
    vncPassword: vncConfig.vncPassword,
    viewOnly: vncConfig.viewOnly,
    vncPort: vncConfig.vncPort,
    novncPort: vncConfig.novncPort,
    log,
    events,
  });

  // Clean up watcher on server shutdown
  events.on('server:shutdown', () => {
    if (watcher.exitCode === null) {
      log('info', 'killing vnc watcher on shutdown');
      watcher.kill('SIGTERM');
    }
  });

  // --- Per-session VNC bridges ---
  // Share one password across the global watcher and every per-session
  // bridge, matching the vnc-watcher.sh convention (/tmp/.vnc/passwd), so
  // ops only ever configures one VNC_PASSWORD.
  let sessionPassFile = null;
  if (vncConfig.vncPassword) {
    try {
      fs.mkdirSync('/tmp/.vnc', { recursive: true });
      const { spawnSync } = await import('node:child_process');
      const result = spawnSync('x11vnc', ['-storepasswd', vncConfig.vncPassword, '/tmp/.vnc/passwd'], { stdio: 'ignore' });
      if (result.error || result.status !== 0) {
        throw result.error || new Error(`x11vnc -storepasswd exited with status ${result.status}`);
      }
      sessionPassFile = '/tmp/.vnc/passwd';
    } catch (err) {
      log('warn', 'could not prepare shared x11vnc password file; per-session bridges will run unauthenticated at the RFB layer', { error: err.message });
    }
  }

  const sessionVnc = createSessionVncBridge({
    log,
    events,
    getDisplay: () => watcher.getVncStatus().display ?? null,
    viewOnly: vncConfig.viewOnly,
    passFile: sessionPassFile,
  });

  const wsTickets = createWsTicketIssuer();

  // Splice into the raw HTTP server as soon as it exists (plugins register
  // before app.listen() runs, so `server` is handed over via this event --
  // see server.js's 'server:started' emit).
  events.on('server:started', ({ server }) => {
    if (!server) return;
    server.on('upgrade', (req, socket, head) => {
      if (!req.url || !req.url.startsWith('/vnc-ws/')) return;

      let userId = null;
      let ticket = null;
      try {
        const url = new URL(req.url, 'http://internal');
        const match = url.pathname.match(/^\/vnc-ws\/([^/]+)\/?$/);
        userId = match ? decodeURIComponent(match[1]) : null;
        ticket = url.searchParams.get('ticket');
      } catch {
        // malformed URL -- fall through to the reject below
      }

      // Browsers can't set custom headers on a native WebSocket handshake, so
      // this leg is authenticated with a short-lived ticket bound to this
      // exact userId -- minted only by the Authorization-header-gated POST
      // /sessions/:userId/vnc/attach -- rather than the long-lived master
      // apiKey/accessKey (which would otherwise sit in this URL's query
      // string, and therefore in access logs and browser history, for as
      // long as that key stays valid).
      if (!userId || !wsTickets.verify(ticket, userId)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      sessionVnc.handleUpgrade(req, socket, head);
    });
    log('info', 'vnc plugin: per-session VNC upgrade proxy attached at /vnc-ws/:userId');
  });

  const sessionVncAuth = requireAuth(config);

  // --- HTTP endpoint: POST /sessions/:userId/vnc/attach ---
  app.post('/sessions/:userId/vnc/attach', sessionVncAuth, async (req, res) => {
    const userId = String(req.params.userId);
    const session = sessions.get(userId);
    if (!session) return res.status(404).json({ error: `No active session for userId="${userId}"` });
    try {
      await sessionVnc.attach(userId, session);
      res.json({ ok: true, attached: true, wsTicket: wsTickets.mint(userId) });
    } catch (err) {
      log('warn', 'session vnc attach failed', { reqId: req.reqId, userId, error: err.message });
      res.status(err.statusCode || 500).json({ ok: false, attached: false, error: safeError(err) });
    }
  });

  // --- HTTP endpoint: POST /sessions/:userId/vnc/detach ---
  app.post('/sessions/:userId/vnc/detach', sessionVncAuth, async (req, res) => {
    const userId = String(req.params.userId);
    await sessionVnc.detach(userId);
    res.json({ ok: true, attached: false });
  });

  // --- HTTP endpoint: GET /sessions/:userId/vnc/status ---
  app.get('/sessions/:userId/vnc/status', sessionVncAuth, (req, res) => {
    res.json(sessionVnc.status(String(req.params.userId)));
  });

  // --- HTTP endpoint: GET /vnc/status ---
  app.get('/vnc/status', (_req, res) => {
    const watcherRunning = watcher.exitCode === null && !watcher.killed;
    const vncStatus = watcher.getVncStatus();
    res.json({
      enabled: true,
      running: watcherRunning && vncStatus.running,
      watcherRunning,
      ...(vncStatus.display ? { display: vncStatus.display } : {}),
      vncPort: Number(vncConfig.vncPort),
      novncPort: Number(vncConfig.novncPort),
      path: '/vnc.html',
    });
  });

  // --- HTTP endpoint: GET /sessions/:userId/storage_state ---
  const authMiddleware = requireAuth(config);

  app.get('/sessions/:userId/storage_state', authMiddleware, async (req, res) => {
    try {
      const userId = req.params.userId;
      const session = sessions.get(String(userId));
      if (!session) {
        return res.status(404).json({ error: `No active session for userId="${userId}"` });
      }

      const state = await session.context.storageState(ctx.persistenceStorageStateOptions);

      log('info', 'storage_state exported', {
        reqId: req.reqId,
        userId: String(userId),
        cookies: state.cookies?.length || 0,
        origins: state.origins?.length || 0,
      });

      events.emit('vnc:storage:exported', {
        userId: String(userId),
        cookies: state.cookies?.length || 0,
        origins: state.origins?.length || 0,
      });

      await events.emitAsync('session:storage:export', {
        userId: String(userId),
        storageState: state,
      });

      res.json(state);
    } catch (err) {
      log('error', 'storage_state export failed', { reqId: req.reqId, error: err.message });
      res.status(500).json({ error: safeError(err) });
    }
  });

  log('info', 'vnc plugin: registered VNC endpoints');
}
