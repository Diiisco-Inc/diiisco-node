import { RouterProvider, usePath, Link } from './router';
import { Home } from './pages/Home';
import { Directory } from './pages/Directory';
import { Profile } from './pages/Profile';

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
          DIIISCO
        </Link>
        <nav>
          <Link to="/nodes">Nodes</Link>
        </nav>
      </header>
      <main>
        <Routes />
      </main>
      <footer className="site-footer">
        <span className="muted">
          Powered by <a href="https://diiisco.com">DIIISCO</a> — peer-to-peer LLM inference
        </span>
      </footer>
    </RouterProvider>
  );
}
