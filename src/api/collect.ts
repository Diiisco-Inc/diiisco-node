/**
 * Broadcast a request and gather what comes back for a window — the one shape
 * `/network`, `/v1/models` and the profile lookup all share.
 *
 * Every exit path (the window ends, enough replies arrived, the request could
 * not be sent, the HTTP client went away) runs the same cleanup, so a listener
 * or timer never outlives the request that made it, and it removes only the
 * listener it added.
 */

export interface CollectOptions<T> {
  /**
   * Start listening. Call `push` for each reply; return a function that stops
   * listening (and releases anything opened here). It may be called more than once.
   */
  subscribe: (push: (item: T) => void) => () => void;
  /** Put the request on the wire. A rejection aborts the collection and is rethrown. */
  send: () => Promise<void>;
  /** How long to gather replies, counted from when `send` resolves. */
  windowMs: number;
  /** Stop early, with whatever has arrived, once this many replies are in. */
  until?: number;
  /** Replies collected elsewhere (e.g. a `ModelListCollector`); read at the end instead of what was pushed. */
  read?: () => T[];
  /** Aborted when the caller no longer wants the result (the HTTP client closed). */
  signal?: AbortSignal;
}

export interface Collected<T> {
  items: T[];
  /** True if the caller aborted; there is nobody to answer. */
  aborted: boolean;
}

export function collect<T>(options: CollectOptions<T>): Promise<Collected<T>> {
  const { subscribe, send, windowMs, until, read, signal } = options;

  return new Promise<Collected<T>>((resolve, reject) => {
    const pushed: T[] = [];
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};

    const finish = (aborted: boolean, error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let items: T[] = pushed;
      try {
        if (!error && !aborted && read) items = read();
      } finally {
        unsubscribe();
      }
      if (error) reject(error);
      else resolve({ items, aborted });
    };

    const onAbort = () => finish(true);
    if (signal?.aborted) return resolve({ items: [], aborted: true });
    signal?.addEventListener('abort', onAbort, { once: true });

    const push = (item: T) => {
      if (done) return;
      pushed.push(item);
      if (until !== undefined && pushed.length >= until) finish(false);
    };

    unsubscribe = subscribe(push);

    send().then(() => {
      if (done) return;
      timer = setTimeout(() => finish(false), windowMs);
    }, (err) => finish(false, err));
  });
}

type Listenable = { on: (event: string, listener: () => void) => unknown };

/**
 * An AbortSignal that fires when the HTTP client goes away before the response
 * is sent. Node reports that as `res` 'close', but Bun does not (it only emits
 * `req` 'aborted' and the socket's 'close'), and the shipped binary runs on
 * Bun, so all three are watched. Nothing here keeps the connection's socket
 * holding a listener once the response is over.
 */
export function abortOnClose(
  req: Listenable & { socket?: Listenable & { off?: (event: string, listener: () => void) => unknown } },
  res: Listenable & { once?: (event: string, listener: () => void) => unknown },
): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const socket = req.socket;

  req.on('aborted', abort);
  res.on('close', abort);
  socket?.on('close', abort);
  const release = () => socket?.off?.('close', abort);
  res.on('close', release);
  res.on('finish', release);
  return controller.signal;
}
