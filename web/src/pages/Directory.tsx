import { useEffect, useState } from 'react';
import { getDirectory } from '../api';
import type { DirectoryEntry } from '../types';
import { formatLastSeen, shortPeerId } from '../format';
import { Link } from '../router';

export function Directory() {
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getDirectory()
        .then((d) => !cancelled && (setEntries(d), setError(null)))
        .catch((e) => !cancelled && setError(e.message));
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <h2>Known nodes</h2>
      {error ? <p className="error">Could not load the directory: {error}</p> : null}
      {entries === null && !error ? <p className="muted">Loading…</p> : null}
      {entries !== null && entries.length === 0 ? (
        <p className="muted">This node hasn't seen any other nodes yet.</p>
      ) : null}
      {entries !== null && entries.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Node</th>
              <th>Peer ID</th>
              <th>Status</th>
              <th>Role</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.peerId}>
                <td>
                  <Link to={`/nodes/${encodeURIComponent(e.peerId)}`}>
                    {e.displayName || shortPeerId(e.peerId)}
                  </Link>
                  {e.host ? <span className="badge badge-host">Host</span> : null}
                  {e.nfd ? <span className="muted"> {e.nfd}</span> : null}
                </td>
                <td className="mono">{shortPeerId(e.peerId)}</td>
                <td>
                  <span className={`dot ${e.connected ? 'dot-ok' : 'dot-off'}`} />
                  {e.connected ? 'connected' : 'seen'}
                </td>
                <td>{e.role ?? '—'}</td>
                <td>{formatLastSeen(e.lastSeen)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </>
  );
}
