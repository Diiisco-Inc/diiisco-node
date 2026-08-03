/**
 * The daemon control channel — how `diiisco stop` asks a running node to shut
 * down *gracefully*, on every platform.
 *
 * ## Why this exists
 *
 * `stop` used to be a bare `process.kill(pid, 'SIGTERM')`. On POSIX that runs
 * `Application.shutdown()`; on **Windows there is no SIGTERM** — libuv turns
 * `process.kill` into `TerminateProcess`, so the daemon dies where it stands.
 * libp2p connections are never closed, GossipSub topics are never
 * unsubscribed, the API server is never drained, and an x402 settlement that
 * is mid-flight is simply interrupted. So the daemon has to be *asked* to stop,
 * not signalled.
 *
 * ## Why a dedicated loopback socket rather than an API endpoint
 *
 * The obvious alternative — `POST /internal/shutdown` on the existing Express
 * server — was rejected:
 *
 *  - That server binds `0.0.0.0` (see `src/api/server.ts`), so the route would
 *    be reachable from every interface and its loopback-only property would
 *    depend on a middleware check being correct forever. This server binds
 *    `127.0.0.1`, so "not remotely reachable" is enforced by the kernel, not by
 *    our code.
 *  - The API's bearer key is shared with agent tools (`diiisco launch` hands it
 *    to Claude Code and friends). A kill switch must not be behind a credential
 *    users paste into other programs.
 *  - It works when `api.enabled` is false, and when the HTTP server is wedged
 *    serving a long inference request.
 *
 * ## Security properties
 *
 *  - Bound to `127.0.0.1` on an OS-assigned ephemeral port. Non-loopback peers
 *    cannot connect at all; the handler re-checks `remoteAddress` anyway.
 *  - Authenticated by a 32-byte random token generated fresh at daemon start,
 *    compared with `timingSafeEqual`, recorded only in `daemon.json` (mode
 *    `0600`) and never logged, printed or passed through argv.
 *  - Exactly one instruction (`shutdown`). There is no other capability, and no
 *    way to read anything back.
 *  - Sockets are capped (1 KiB request, 5 s idle) so an unauthenticated local
 *    process cannot hold resources open.
 */
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Longest request we will read before hanging up. A shutdown line is ~90 bytes. */
const MAX_REQUEST_BYTES = 1024;

/** Idle timeout on a control connection. */
const SOCKET_TIMEOUT_MS = 5_000;

/** Addresses that count as loopback for a server bound to 127.0.0.1. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface ControlServer {
  /** The ephemeral port the daemon is listening on. */
  port: number;
  /** The token a client must present. */
  token: string;
  /** Stop accepting control connections. */
  close(): void;
}

export function generateControlToken(): string {
  return randomBytes(32).toString('hex');
}

function tokensMatch(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch; the token length is fixed and
  // public, so comparing it first leaks nothing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isLoopback(socket: Socket): boolean {
  const address = socket.remoteAddress;
  return typeof address === 'string' && LOOPBACK.has(address);
}

/**
 * Listen for shutdown instructions on loopback.
 *
 * `onShutdown` is invoked *after* the acknowledgement has been flushed, so the
 * client learns the instruction was accepted even if the process exits
 * promptly afterwards.
 */
export function startControlServer(options: {
  token: string;
  onShutdown: (reason: string) => void;
}): Promise<ControlServer> {
  const { token, onShutdown } = options;

  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
      if (!isLoopback(socket)) {
        socket.destroy();
        return;
      }

      socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
      socket.on('error', () => socket.destroy());

      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > MAX_REQUEST_BYTES) {
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;

        const line = buffer.slice(0, newline);
        buffer = '';

        let request: any;
        try {
          request = JSON.parse(line);
        } catch {
          socket.end(`${JSON.stringify({ ok: false, error: 'malformed request' })}\n`);
          return;
        }

        if (!tokensMatch(request?.token, token)) {
          // Deliberately vague: an unauthenticated caller learns nothing about
          // whether the token was wrong, missing or the wrong shape.
          socket.end(`${JSON.stringify({ ok: false, error: 'unauthorised' })}\n`);
          return;
        }

        if (request?.action !== 'shutdown') {
          socket.end(`${JSON.stringify({ ok: false, error: 'unknown action' })}\n`);
          return;
        }

        socket.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`, () => {
          onShutdown('a shutdown request on the control channel');
        });
      });
    });

    server.on('error', reject);

    // 127.0.0.1 explicitly: an ephemeral port on the wildcard address would be
    // a remote kill switch waiting for a token leak.
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => {
      const address = server.address();
      if (typeof address !== 'object' || address === null) {
        server.close();
        reject(new Error('the control channel did not receive a port from the operating system'));
        return;
      }
      // Never hold the process open on its own account: the node's own servers
      // and timers decide the lifetime.
      server.unref();
      resolve({
        port: address.port,
        token,
        close: () => {
          try {
            server.close();
          } catch {
            // Already closed.
          }
        },
      });
    });
  });
}

export interface ShutdownRequestResult {
  ok: boolean;
  /** Present when the instruction was not accepted; safe to show the user. */
  error: string | null;
}

/**
 * Ask the daemon at `127.0.0.1:port` to shut down. Never throws — the caller
 * escalates to a signal when this does not succeed.
 */
export function requestShutdown(port: number, token: string, timeoutMs = 5_000): Promise<ShutdownRequestResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ShutdownRequestResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const socket = createConnection({ port, host: '127.0.0.1' });
    const timer = setTimeout(() => finish({ ok: false, error: `the control channel did not answer within ${timeoutMs}ms` }), timeoutMs);

    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ action: 'shutdown', token })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        finish({ ok: response?.ok === true, error: response?.ok === true ? null : String(response?.error ?? 'the node refused the shutdown request') });
      } catch {
        finish({ ok: false, error: 'the node sent an unreadable response on the control channel' });
      }
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      const reason = err?.code === 'ECONNREFUSED'
        ? 'nothing is listening on the recorded control port'
        : String(err?.message ?? err);
      finish({ ok: false, error: reason });
    });
    socket.on('close', () => finish({ ok: false, error: 'the control channel closed without answering' }));
  });
}
