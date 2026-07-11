import type { ReactNode } from 'react';
import type { NodeProfile } from '../types';
import { formatDate, formatUptime, shortPeerId } from '../format';

function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function ProfileCard({ profile }: { profile: NodeProfile }) {
  const title = profile.displayName || shortPeerId(profile.peerId);

  return (
    <div className="card">
      <div className="card-header">
        <h2>{title}</h2>
        <div className="badges">
          <Badge kind={profile.online ? 'ok' : 'off'}>{profile.online ? 'online' : 'offline'}</Badge>
          <Badge kind="role">{profile.role}</Badge>
          <Badge kind="net">{profile.network}</Badge>
          {profile.nfdVerified && profile.nfd ? <Badge kind="nfd">✓ {profile.nfd}</Badge> : null}
        </div>
      </div>

      <dl className="fields">
        <dt>Peer ID</dt>
        <dd className="mono">{profile.peerId}</dd>
        {profile.walletAddr ? (
          <>
            <dt>Wallet</dt>
            <dd className="mono">{profile.walletAddr}</dd>
          </>
        ) : null}
        {profile.version ? (
          <>
            <dt>Version</dt>
            <dd>diiisco-node v{profile.version}</dd>
          </>
        ) : null}
        <dt>{profile.online ? 'Observed' : 'Last seen'}</dt>
        <dd>{formatDate(profile.observedAt)}</dd>
      </dl>

      {profile.stats ? (
        <div className="stats">
          <h3>Stats</h3>
          <div className="stat-grid">
            <div className="stat">
              <span className="stat-value">{profile.stats.connectedPeers}</span>
              <span className="stat-label">connected peers</span>
            </div>
            <div className="stat">
              <span className="stat-value">{profile.stats.meshReady ? 'yes' : 'no'}</span>
              <span className="stat-label">mesh ready</span>
            </div>
            <div className="stat">
              <span className="stat-value">{formatUptime(profile.stats.uptimeSeconds)}</span>
              <span className="stat-label">uptime</span>
            </div>
            <div className="stat">
              <span className="stat-value">{profile.stats.inferencesServed}</span>
              <span className="stat-label">inferences served</span>
            </div>
            <div className="stat">
              <span className="stat-value">{profile.stats.inferencesRequested}</span>
              <span className="stat-label">inferences requested</span>
            </div>
          </div>

          <h3>Models</h3>
          {profile.stats.models.length === 0 ? (
            <p className="muted">No models offered.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Price / 1M tokens</th>
                </tr>
              </thead>
              <tbody>
                {profile.stats.models.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.id}</td>
                    <td>{m.pricePer1MTokens != null ? `$${m.pricePer1MTokens}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <p className="muted">This node doesn't publish stats.</p>
      )}
    </div>
  );
}
