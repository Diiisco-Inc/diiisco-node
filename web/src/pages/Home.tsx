import { useEffect, useState } from 'react';
import { getOwnProfile } from '../api';
import type { NodeProfile } from '../types';
import { ProfileCard } from '../components/ProfileCard';
import { Link } from '../router';

export function Home() {
  const [profile, setProfile] = useState<NodeProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      getOwnProfile()
        .then((p) => !cancelled && (setProfile(p), setError(null)))
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
      <section className="intro">
        <p>
          Welcome to <strong>DIIISCO</strong>, a community-powered platform where independent nodes collaborate to bring AI inference to everyone. We believe in decentralized intelligence connecting peers across the world to democratize access to powerful language models, fairly compensating contributors, and building the future of AI together.
        </p>
        <p>
          <Link to="/nodes">Browse known nodes →</Link>
        </p>
      </section>

      {error ? <p className="error">Could not load this node's profile: {error}</p> : null}
      {profile ? <ProfileCard profile={profile} /> : !error ? <p className="muted">Loading…</p> : null}
    </>
  );
}
