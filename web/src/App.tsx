import { RouterProvider, usePath, Link } from './router';
import { Home } from './pages/Home';
import { Directory } from './pages/Directory';
import { Profile } from './pages/Profile';
import { NavChip } from './components/NavChip';

// Served from the DIIISCO asset host (allowed in the node's CSP) so branding
// is controlled centrally rather than shipped with every node build.
const LOGO_URL = 'https://asset.diiisco.com/diiisco-logo.png';

function Routes() {
  const path = usePath();

  if (path === '/' || path === '') return <Home />;
  if (path === '/nodes' || path === '/nodes/') return <Directory />;

  const profileMatch = path.match(/^\/nodes\/([^/]+)$/);
  if (profileMatch) return <Profile peerId={decodeURIComponent(profileMatch[1])} />;

  return <p className="error">Page not found.</p>;
}

export function App() {
  return (
    <RouterProvider>
      <header className="site-header">
        <Link to="/" className="brand">
          <img src={LOGO_URL} alt="DIIISCO" className="brand-logo" />
        </Link>
        <NavChip />
      </header>
      <main>
        <Routes />
      </main>
      <footer className="site-footer">
        <span className="muted">
          Powered by <a href="https://diiisco.com">DIIISCO</a>. Peer-to-peer LLM Inference made easy.
        </span>
      </footer>
    </RouterProvider>
  );
}
