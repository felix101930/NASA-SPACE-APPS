import type { JSX } from 'react';

export function Loading({ label }: { label: string }): JSX.Element {
  return (
    <div className="loading" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
