import type { ReactNode } from 'react';
import type { ModelPerformance, NodeProfile, PerformanceFigure } from '../types';
import { formatDateTime, formatFigure, formatUptime, shortPeerId } from '../format';

function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

const KIND_CHIPS = {
  decision: { label: 'Decision', title: 'Decision model: answers typed questions through /v1/systemone rather than chatting.' },
  embedding: { label: 'Embedding', title: 'Embedding model: turns text into vectors; it cannot chat.' },
} as const;

/** Marks a model that is not a chat model. Chat models, the default, get no chip. */
function KindChip({ kind }: { kind?: string }) {
  if (kind !== 'decision' && kind !== 'embedding') return null;
  const { label, title } = KIND_CHIPS[kind];
  return (
    <span className={`badge badge-kind badge-kind-${kind}`} title={title}>
      {label}
    </span>
  );
}

/** One figure with its sample count on hover; "—" when the node has not measured it. */
function Figure({ figure, unit, note }: { figure?: PerformanceFigure; unit: 'ms' | 'tok/s'; note?: string }) {
  if (!figure) return <span className="muted">—</span>;
  const title = `Median of ${figure.samples} sample${figure.samples === 1 ? '' : 's'}${note ? ` (${note})` : ''}. Reported by the node itself.`;
  return <span title={title}>{formatFigure(figure.value, unit)}</span>;
}

const coldNote = (p?: ModelPerformance) =>
  p?.coldStart === 'forced' ? 'the node unloaded the model to time this' : p?.coldStart === 'observed' ? 'seen on a real request' : undefined;

export function ProfileCard({ profile }: { profile: NodeProfile }) {
  const title = profile.displayName || shortPeerId(profile.peerId);
  // A local network has no cost, so there is no price to show.
  const showPrices = profile.network !== 'local';
  // Only shown once some model has figures, so a node without them (or an older one) looks as it did.
  const showPerformance = (profile.stats?.models ?? []).some((m) => m.performance);

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

      {profile.tags && profile.tags.length > 0 ? (
        <div className="tags" aria-label="Tags">
          {profile.tags.map((tag) => (
            <span key={tag} className="badge badge-tag" title="Set by the node's operator">{tag}</span>
          ))}
        </div>
      ) : null}

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
        <dd>{formatDateTime(profile.observedAt)}</dd>
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
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    {showPrices ? <th>Price / 1M tokens</th> : null}
                    {showPerformance ? (
                      <>
                        <th title="Time to first token with the model already loaded">First token</th>
                        <th title="Time to first token when the model had to be loaded first">Cold start</th>
                        <th title="Output tokens per second">Speed</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {profile.stats.models.map((m) => (
                    <tr key={m.id}>
                      <td className="mono">
                        {m.id}
                        <KindChip kind={m.kind} />
                      </td>
                      {showPrices ? <td>{m.pricePer1MTokens != null ? `$${m.pricePer1MTokens}` : '—'}</td> : null}
                      {showPerformance ? (
                        <>
                          <td><Figure figure={m.performance?.ttftHotMs} unit="ms" /></td>
                          <td><Figure figure={m.performance?.ttftColdMs} unit="ms" note={coldNote(m.performance)} /></td>
                          <td><Figure figure={m.performance?.tokensPerSecond} unit="tok/s" /></td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">This node doesn't publish stats.</p>
      )}
    </div>
  );
}
