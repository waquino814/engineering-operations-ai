import type { ReactNode } from 'react';
import type { Origin } from './data/types.ts';
import type { OutcomeKey } from './model.ts';

/** Shared building blocks. Status is always text first; colour only reinforces it. */
const OUTCOME_ICON: Record<OutcomeKey, string> = {
  completed: '●',
  inconclusive: '◐',
  failed: '✕',
  budget_exceeded: '▲',
  not_admitted: '⊘',
};

export function StatusBadge({ outcome, label }: { outcome: OutcomeKey; label: string }) {
  return (
    <span className={`badge badge--${outcome}`}>
      <span aria-hidden="true">{OUTCOME_ICON[outcome]}</span> {label}
    </span>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div className="state" role="status" aria-live="polite" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">Something went wrong</p>
      <p className="state__detail">{message}</p>
      {onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {children}
    </div>
  );
}

const ORIGINS: Record<Origin, { label: string; title: string }> = {
  fixture: { label: 'Fixture', title: 'Generated fixture data, not a live investigation' },
};

/** Says where a record came from; fixture data is always marked as such. */
export function OriginTag({ origin }: { origin: Origin }) {
  return (
    <span className={`tag tag--${origin}`} title={ORIGINS[origin].title}>
      {ORIGINS[origin].label}
    </span>
  );
}

export function Panel({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const id = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section className={`panel ${className ?? ''}`} aria-labelledby={id}>
      <div className="panel__header">
        <h2 id={id} className="panel__title">
          {title}
        </h2>
        {actions}
      </div>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export function KeyValues({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v]) => (
        <div className="kv__row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
