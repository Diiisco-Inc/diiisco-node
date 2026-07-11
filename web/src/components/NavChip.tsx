import { Link, usePath } from '../router';

/**
 * Top-right navigation chip, mirroring the diiisco.com SocialLinksChip
 * (sans totem icons). The first segment toggles between the host's home page
 * and the nodes directory; the rest link out to the main site.
 */
export function NavChip() {
  const onHost = usePath() === '/' || usePath() === '';

  return (
    <div className="chip">
      <Link to={onHost ? '/nodes' : '/'} className="chip-item">
        {onHost ? 'Nodes' : 'Host'}
      </Link>
      <div className="chip-divider" />
      <a href="https://diiisco.com/docs/welcome" target="_blank" rel="noopener noreferrer" className="chip-item">
        Docs
      </a>
      <div className="chip-divider" />
      <a
        href="https://app.tinyman.org/analytics/assets/detail/3303055052"
        target="_blank"
        rel="noopener noreferrer"
        className="chip-item"
      >
        Get DSCO
      </a>
    </div>
  );
}
