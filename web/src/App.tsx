import { RouterProvider, usePath, Link } from './router';
import { Home } from './pages/Home';
import { Directory } from './pages/Directory';
import { Profile } from './pages/Profile';
import { NavChip } from './components/NavChip';
// Bundled (a ~5 KB, 3x-for-34px render) rather than loaded from the asset
// host, so the header still renders on a node with no internet access.
import wordmark from './assets/diiisco-wordmark.png';

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
        <Link to="https://diiisco.com" className="brand">
          <img src={wordmark} alt="DIIISCO" className="brand-logo" />
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
