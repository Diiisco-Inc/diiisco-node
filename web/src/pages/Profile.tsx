import { useEffect, useState } from 'react';
import { getNodeProfile, NotFoundError } from '../api';
import type { NodeProfile } from '../types';
import { ProfileCard } from '../components/ProfileCard';
import { Link } from '../router';

export function Profile({ peerId }: { peerId: string }) {
  const [profile, setProfile] = useState<NodeProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setError(null);
    setNotFound(false);

    const load = () =>
      getNodeProfile(peerId)
        .then((p) => !cancelled && (setProfile(p), setError(null)))
        .catch((e) => {
          if (cancelled) return;
          if (e instanceof NotFoundError) setNotFound(true);
          else setError(e.message);
        });
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [peerId]);

  return (
    <>
      <p>
        <Link to="/nodes">← All nodes</Link>
      </p>
      {notFound ? <p className="error">This node isn't known to this host.</p> : null}
      {error ? <p className="error">Could not load the profile: {error}</p> : null}
      {profile === null && !error && !notFound ? <p className="muted">Looking up node…</p> : null}
      {profile ? (
        <>
          {!profile.online ? (
            <p className="notice">This node is currently unreachable — showing the last known identity.</p>
          ) : null}
          <ProfileCard profile={profile} />
        </>
      ) : null}
    </>
  );
}
