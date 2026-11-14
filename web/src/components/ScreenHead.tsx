import type { JSX, ReactNode } from 'react';

interface ScreenHeadProps {
  /** Screen name, small, sentence case. */
  kicker: string;
  /** One-line result computed from the loaded data. */
  result: ReactNode;
  /** Optional chips after the kicker (e.g. sample-data marker). */
  chips?: ReactNode;
  /** Optional controls on the right (e.g. region picker). */
  aside?: ReactNode;
  /** Methodology, collapsed by default. */
  method?: ReactNode;
  methodLabel?: string;
}

/** Every screen opens the same way: what you're looking at, the result, and the method on demand. */
export function ScreenHead({ kicker, result, chips, aside, method, methodLabel = 'How this is measured' }: ScreenHeadProps): JSX.Element {
  return (
    <header className="screen-head">
      <div className="screen-head-main">
        <div className="screen-kicker">
          <span>{kicker}</span>
          {chips}
        </div>
        <h1 className="screen-result">{result}</h1>
        {method && (
          <details className="method">
            <summary>{methodLabel}</summary>
            <div className="method-body">{method}</div>
          </details>
        )}
      </div>
      {aside && <div className="screen-head-aside">{aside}</div>}
    </header>
  );
}

/** Neutral marker for content that comes from the synthetic sample set rather than the pipeline. */
export function SampleChip({ what }: { what: string }): JSX.Element {
  return (
    <span className="chip chip-sample" title={`${what} come from the synthetic sample set; the pipeline output is not available yet.`}>
      Sample data
    </span>
  );
}
