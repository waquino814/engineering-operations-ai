import type { InvestigationDataSource } from './data/types.ts';
import { href, useRoute, type Route } from './router.ts';
import { InvestigationDetail } from './views/InvestigationDetail.tsx';
import { NewInvestigation } from './views/NewInvestigation.tsx';
import { EvaluationDetail } from './views/EvaluationDetail.tsx';
import { Evaluations } from './views/Evaluations.tsx';
import { Overview } from './views/Overview.tsx';
import { Settings } from './views/Settings.tsx';
import { EmptyState, OriginTag } from './components.tsx';

/** The console shell: left navigation, a compact top bar, and the current view. */
const NAV = [
  { label: 'Investigations', route: { name: 'investigations' }, icon: '≡' },
  { label: 'New Investigation', route: { name: 'new' }, icon: '+' },
  { label: 'Evaluations', route: { name: 'evaluations' }, icon: '✓' },
  { label: 'Settings', route: { name: 'settings' }, icon: '⚙' },
] as const;

const section = (route: Route) =>
  route.name === 'investigation'
    ? 'investigations'
    : route.name === 'evaluation'
      ? 'evaluations'
      : route.name;

export function App({ source }: { source: InvestigationDataSource }) {
  const route = useRoute();
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            ◆
          </span>
          <span className="brand__name">EngOps AI</span>
        </div>
        <nav aria-label="Main">
          <ul className="nav">
            {NAV.map((item) => (
              <li key={item.label}>
                <a
                  className="nav__link"
                  href={href(item.route)}
                  aria-current={section(route) === item.route.name ? 'page' : undefined}
                >
                  <span className="nav__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="topbar__title">Engineering Operations AI · Investigation console</span>
          <span className="topbar__meta">
            Data: <OriginTag origin={source.description.mode} />
          </span>
        </header>
        <main id="main" className="content" tabIndex={-1}>
          <View route={route} source={source} />
        </main>
      </div>
    </div>
  );
}

function View({ route, source }: { route: Route; source: InvestigationDataSource }) {
  switch (route.name) {
    case 'investigations':
      return <Overview source={source} />;
    case 'investigation':
      return <InvestigationDetail source={source} id={route.id} />;
    case 'new':
      return <NewInvestigation source={source} />;
    case 'evaluations':
      return <Evaluations source={source} />;
    case 'evaluation':
      return <EvaluationDetail source={source} id={route.id} />;
    case 'settings':
      return <Settings source={source} />;
    case 'not_found':
      return (
        <div className="page">
          <EmptyState title="Page not found">
            <p>
              Nothing lives at <span className="mono">{route.path}</span>.
            </p>
            <a className="button" href={href({ name: 'investigations' })}>
              Go to investigations
            </a>
          </EmptyState>
        </div>
      );
  }
}
