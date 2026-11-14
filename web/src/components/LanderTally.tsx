// The 12 robotic Moon landing attempts since 2019, one lander glyph each, in date order.
// Outcome is carried by the glyph's shape (standing, on its side, broken) plus a word, never by hue.
import type { JSX } from 'react';
import {
  LANDING_ATTEMPTS,
  LANDING_COUNT_RULE,
  LANDING_HEIGHT_LABEL,
  LANDING_OUTCOME_LABEL,
  APOLLO_QUOTES,
  type LandingAttempt,
  type LandingOutcome,
} from '../content';

function LanderShape(): JSX.Element {
  return (
    <>
      <path d="M13 14h14l2 12H11z" className="lg-body" />
      <path d="M18 26h4l1.5 4h-7z" className="lg-body" />
      <path d="M20 14V9M20 9l3-2" className="lg-line" />
      <path d="M12 26 6 38M28 26l6 12M3.5 38h5M31.5 38h5" className="lg-line" />
    </>
  );
}

export function LanderGlyph({ outcome, size = 40 }: { outcome: LandingOutcome; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size * 1.1} viewBox="0 0 40 44" aria-hidden="true" className={`lander-glyph lg-${outcome}`}>
      <line x1="0" x2="40" y1="40" y2="40" className="lg-ground" />
      {outcome === 'upright' && (
        <g transform="translate(0 1.5)">
          <LanderShape />
        </g>
      )}
      {outcome === 'not_upright' && (
        // the same lander lying on its side: body on the ground, one leg sticking up
        <g transform="translate(3 0)">
          <path d="M8 38V24l12-2v18z" className="lg-body" />
          <path d="M20 38v-4l4-1.5v7z" className="lg-body" />
          <path d="M8 31H3M3 31l-2-3" className="lg-line" />
          <path d="M20 23l12-6M32 19.5v-5M20 39h13" className="lg-line" />
        </g>
      )}
      {outcome === 'crashed' && (
        <>
          <path d="M5 40q15 5 30 0" className="lg-line" />
          <rect x="12" y="29" width="9" height="6" transform="rotate(24 16.5 32)" className="lg-body" />
          <path d="M24 37l7-7M29 39h4" className="lg-line" />
          <rect x="7" y="35" width="3" height="3" transform="rotate(-18 8.5 36.5)" className="lg-body" />
          <circle cx="26" cy="27" r="1.2" className="lg-dot" />
        </>
      )}
    </svg>
  );
}

const nf = new Intl.NumberFormat('en-US');

function count(o: LandingOutcome): number {
  return LANDING_ATTEMPTS.filter((a: LandingAttempt): boolean => a.outcome === o).length;
}

export function LanderTally(): JSX.Element {
  const years = LANDING_ATTEMPTS.map((a: LandingAttempt): string => a.date.slice(0, 4));
  const outcomes: LandingOutcome[] = ['upright', 'crashed', 'not_upright'];
  return (
    <figure className="tally" aria-labelledby="tally-cap">
      <figcaption id="tally-cap" className="sr-only">
        Robotic Moon landing attempts since 2019, in date order: {count('upright')} upright, {count('crashed')} crashed,{' '}
        {count('not_upright')} landed but not upright.
      </figcaption>
      <ol className="tally-row">
        {LANDING_ATTEMPTS.map((a: LandingAttempt, i: number) => {
          const label = `${a.mission}, ${years[i]}: ${a.detail}${a.heightProblem ? `. ${LANDING_HEIGHT_LABEL}` : ''}`;
          const edge = i < 2 ? ' tally-tip-start' : i > LANDING_ATTEMPTS.length - 3 ? ' tally-tip-end' : '';
          return (
            <li key={a.mission} className="tally-item">
              <span className="tally-hit" tabIndex={0} role="img" aria-label={label}>
                <LanderGlyph outcome={a.outcome} size={48} />
                <span className={`tally-mark${a.heightProblem ? ' on' : ''}`} aria-hidden="true" />
                <span className={`tally-tip${edge}`} aria-hidden="true">
                  <strong>{a.mission}</strong>
                  <span>
                    {years[i]} · {a.detail}
                  </span>
                  {a.heightProblem && <span className="faint">{LANDING_HEIGHT_LABEL}</span>}
                </span>
              </span>
              <span className="tally-year" aria-hidden="true">
                {i === 0 || years[i] !== years[i - 1] ? years[i] : ''}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="tally-legend" aria-hidden="true">
        {outcomes.map((o: LandingOutcome) => (
          <span key={o} className="tally-key">
            <LanderGlyph outcome={o} size={20} />
            <strong>{nf.format(count(o))}</strong> {LANDING_OUTCOME_LABEL[o].toLowerCase()}
          </span>
        ))}
        <span className="tally-key">
          <span className="tally-mark on" />
          {LANDING_HEIGHT_LABEL.toLowerCase()}
        </span>
      </div>
      <details className="method tally-sources">
        <summary>Sources</summary>
        <div className="method-body">
          <p>{LANDING_COUNT_RULE}</p>
          <ul className="tally-src-list">
            {LANDING_ATTEMPTS.map((a: LandingAttempt) => (
              <li key={a.mission}>
                {a.mission} ({a.date.slice(0, 4)}):{' '}
                <a href={a.sourceUrl} target="_blank" rel="noreferrer">
                  {a.sourceLabel}
                </a>
              </li>
            ))}
            <li>
              Apollo quotes:{' '}
              <a href={APOLLO_QUOTES[0].sourceUrl} target="_blank" rel="noreferrer">
                {APOLLO_QUOTES[0].sourceLabel}
              </a>
            </li>
          </ul>
        </div>
      </details>
    </figure>
  );
}
