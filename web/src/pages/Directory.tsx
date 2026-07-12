import { useEffect, useState } from 'react';
import { getDirectory, getModelStats } from '../api';
import type { DirectoryEntry, ModelStats } from '../types';
import { formatLastSeen, shortPeerId } from '../format';
import { Link } from '../router';

const formatPrice = (price: number | null) =>
  price == null ? '—' : `$${Number(price.toFixed(6))}`;

export function Directory() {
  const [entries, setEntries] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelStats[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getDirectory()
        .then((d) => !cancelled && (setEntries(d), setError(null)))
        .catch((e) => !cancelled && setError(e.message));
      getModelStats()
        .then((m) => !cancelled && (setModels(m), setModelsError(null)))
        .catch((e) => !cancelled && setModelsError(e.message));
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <>
      <h2>Known Nodes</h2>
      {error ? <p className="error">Could not load the directory: {error}</p> : null}
      {entries === null && !error ? <p className="muted">Loading…</p> : null}
      {entries !== null && entries.length === 0 ? (
        <p className="muted">This node hasn't seen any other nodes yet.</p>
      ) : null}
      {entries !== null && entries.length > 0 ? (
        <div className="table-wrap">
          <table className="node-table">
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
                  <td data-label="Node">
                    <span>
                      <Link to={`/nodes/${encodeURIComponent(e.peerId)}`}>
                        {e.displayName || shortPeerId(e.peerId)}
                      </Link>
                      {e.host ? <span className="badge badge-host">Host</span> : null}
                      {e.nfd ? <span className="muted"> {e.nfd}</span> : null}
                    </span>
                  </td>
                  <td data-label="Peer ID" className="mono">{shortPeerId(e.peerId)}</td>
                  <td data-label="Status">
                    <span>
                      <span className={`dot ${e.connected ? 'dot-ok' : 'dot-off'}`} />
                      {e.connected ? 'connected' : 'seen'}
                    </span>
                  </td>
                  <td data-label="Role">{e.role ?? '—'}</td>
                  <td data-label="Last seen">{formatLastSeen(e.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2>Models</h2>
      {modelsError ? <p className="error">Could not load model stats: {modelsError}</p> : null}
      {models === null && !modelsError ? <p className="muted">Loading…</p> : null}
      {models !== null && models.length === 0 ? (
        <p className="muted">No connected node is publishing model stats.</p>
      ) : null}
      {models !== null && models.length > 0 ? (
        <div className="table-wrap">
          <table className="node-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Nodes</th>
                <th>Min price / 1M</th>
                <th>Mean price / 1M</th>
                <th>Max price / 1M</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td data-label="Model" className="mono">{m.model}</td>
                  <td data-label="Nodes">{m.nodes}</td>
                  <td data-label="Min price / 1M">{formatPrice(m.minPrice)}</td>
                  <td data-label="Mean price / 1M">{formatPrice(m.meanPrice)}</td>
                  <td data-label="Max price / 1M">{formatPrice(m.maxPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
