import { createContext, useContext, useEffect, useState, type ReactNode, type MouseEvent } from 'react';

// Tiny history-API router — the app has three routes, so a full router
// dependency isn't warranted.

const PathContext = createContext<string>('/');

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    window.addEventListener('app:navigate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('app:navigate', onPop);
    };
  }, []);

  return <PathContext.Provider value={path}>{children}</PathContext.Provider>;
}

export const usePath = () => useContext(PathContext);

export function navigate(to: string) {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new Event('app:navigate'));
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
