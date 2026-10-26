import { useEffect, useState } from 'react';

/**
 * A small hash router (ADR 0011): four views need no routing library. Routes live in the URL's
 * hash, so the console works from any static host and links can be shared.
 */
export type Route =
  | { name: 'investigations' }
  | { name: 'investigation'; id: string }
  | { name: 'new' }
  | { name: 'settings' }
  | { name: 'not_found'; path: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/investigations';
  if (path === '/' || path === '/investigations') return { name: 'investigations' };
  if (path === '/new') return { name: 'new' };
  if (path === '/settings') return { name: 'settings' };
  const m = /^\/investigations\/([A-Za-z0-9_-]+)$/.exec(path);
  if (m?.[1]) return { name: 'investigation', id: m[1] };
  return { name: 'not_found', path };
}

export function href(route: Exclude<Route, { name: 'not_found' }>): string {
  switch (route.name) {
    case 'investigations':
      return '#/investigations';
    case 'investigation':
      return `#/investigations/${route.id}`;
    case 'new':
      return '#/new';
    case 'settings':
      return '#/settings';
  }
}

/** The current route, updated on every hash change. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const update = () => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', update);
    return () => {
      window.removeEventListener('hashchange', update);
    };
  }, []);
  return route;
}
