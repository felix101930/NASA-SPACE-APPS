import type { JSX } from 'react';
import { APOLLO_HEADING, APOLLO_QUOTES, FAILURES, FAILURES_HEADING, FOURTH_MEASURE, HAZARDS, HERO, type ApolloQuote, type FailureStory } from '../content';
import { useApp } from '../store';
import type { HazardId } from '../types/contract';
import { HazardGlyph } from '../components/Glyphs';
import { Explainer } from '../components/explainer/Explainer';
import { LanderTally } from '../components/LanderTally';

/** Schematic drawings, explicitly not to scale. */
function Diagram({ hazard }: { hazard: HazardId }): JSX.Element {
  if (hazard === 'rim') {
    return (
      <svg
        viewBox="0 0 400 170"
        role="img"
        aria-label="Schematic: a descent path passes over a cliff, so the ground suddenly drops away beneath the lander"
      >
        <path d="M0 70 L150 70 L170 66 L178 150 L400 150 L400 170 L0 170Z" fill="#23272e" />
        <path d="M0 70 L150 70 L170 66 L178 150 L400 150" fill="none" stroke="#6f6b64" strokeWidth="1.5" />
        <path d="M30 22 C120 26 220 34 330 56" fill="none" stroke="var(--hz-rim)" strokeWidth="2" strokeDasharray="5 5" />
        <circle cx="168" cy="31" r="5" fill="var(--hz-rim)" />
        <line x1="120" y1="27" x2="120" y2="70" stroke="#8e8a83" strokeDasharray="2 3" />
        <line x1="215" y1="35" x2="215" y2="150" stroke="#8e8a83" strokeDasharray="2 3" />
        <text x="126" y="56" fill="#b9b5ae" fontSize="13" fontFamily="IBM Plex Sans">
          short
        </text>
        <text x="221" y="110" fill="#edeae4" fontSize="13" fontFamily="IBM Plex Sans">
          sudden jump
        </text>
        <text x="8" y="164" fill="#8e8a83" fontSize="12">
          schematic, not to scale
        </text>
      </svg>
    );
  }
  if (hazard === 'shadow') {
    return (
      <svg viewBox="0 0 400 170" role="img" aria-label="Schematic: sun just above the horizon throws long black shadows across craters">
        <defs>
          <linearGradient id="sunglow" x1="0" x2="1">
            <stop offset="0" stopColor="#f3b54a" stopOpacity="0.5" />
            <stop offset="1" stopColor="#f3b54a" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="400" height="170" fill="url(#sunglow)" opacity="0.35" />
        <circle cx="14" cy="96" r="10" fill="#f3b54a" />
        <path
          d="M0 110 L60 110 Q80 96 96 110 L130 110 Q150 140 172 110 L230 110 Q250 98 262 110 L300 110 Q318 134 338 110 L400 110 L400 170 L0 170Z"
          fill="#3d424c"
        />
        <path d="M96 110 L172 110 L150 128Z" fill="#0a0b0e" />
        <path d="M262 110 L338 110 L320 126Z" fill="#0a0b0e" />
        <path d="M96 106 L230 112 L96 112Z" fill="#0a0b0e" opacity="0.9" />
        <path d="M262 106 L400 113 L262 113Z" fill="#0a0b0e" opacity="0.9" />
        <line x1="24" y1="96" x2="400" y2="113" stroke="#f3b54a" strokeOpacity="0.55" strokeDasharray="3 4" />
        <text x="250" y="150" fill="#edeae4" fontSize="13" fontFamily="IBM Plex Sans">
          long shadows
        </text>
        <text x="8" y="164" fill="#8e8a83" fontSize="12">
          schematic, not to scale
        </text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 400 170" role="img" aria-label="Schematic: smooth, repeating sand ripples offer a camera almost no distinct features">
      <path d="M0 100 Q25 82 50 100 T100 100 T150 100 T200 100 T250 100 T300 100 T350 100 T400 100 L400 170 L0 170Z" fill="#3d424c" />
      <path d="M0 100 Q25 82 50 100 T100 100 T150 100 T200 100 T250 100 T300 100 T350 100 T400 100" fill="none" stroke="#6f6b64" />
      <rect x="150" y="18" width="100" height="60" fill="none" stroke="var(--hz-texture)" strokeWidth="1.5" strokeDasharray="4 4" />
      <text x="158" y="54" fill="var(--hz-texture)" fontSize="13" fontFamily="IBM Plex Sans">
        no features?
      </text>
      <text x="8" y="164" fill="#8e8a83" fontSize="12">
        schematic, not to scale
      </text>
    </svg>
  );
}

function FailureCard({ f }: { f: FailureStory }): JSX.Element {
  const hz = HAZARDS[f.hazard];
  return (
    <article className="failure">
      <Diagram hazard={f.hazard} />
      <div className="failure-body">
        <div className="failure-title">
          <h2>{f.mission}</h2>
          <span className="faint">{f.year}</span>
        </div>
        <p className="failure-summary">{f.summary}</p>
        <details className="method failure-more">
          <summary>Read more</summary>
          <blockquote>{f.body}</blockquote>
        </details>
        <div className="failure-foot">
          <span className="hz-tag">
            <HazardGlyph hazard={f.hazard} />
            <span>
              We measure: <strong>{hz.name}</strong>
            </span>
          </span>
          <span className="muted">
            Source:{' '}
            {f.sourceUrl ? (
              <a href={f.sourceUrl} target="_blank" rel="noreferrer">
                {f.sourceLabel}
              </a>
            ) : (
              f.sourceLabel
            )}
          </span>
        </div>
      </div>
    </article>
  );
}

function scrollToExplainer(): void {
  document.getElementById('how-we-find-analogs')?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  });
}

export function Story(): JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  return (
    <div>
      <section className="story-hero" aria-labelledby="story-h">
        <div className="story-hero-grid">
          <div className="story-hero-text">
            <h1 id="story-h">{HERO.headline}</h1>
            <p>{HERO.body}</p>
            <p className="story-problem">
              <strong>{HERO.problem.slice(0, HERO.problem.indexOf(':') + 1)}</strong>
              {HERO.problem.slice(HERO.problem.indexOf(':') + 1)}
            </p>
            <p className="story-kicker">{HERO.kicker}</p>
            <div className="story-cta">
              <button type="button" className="btn btn-primary btn-lg" onClick={(): void => setScreen('moon')}>
                See the Moon danger profiles →
              </button>
              <button type="button" className="link-btn" onClick={scrollToExplainer}>
                How we find Earth analogs ↓
              </button>
            </div>
          </div>
          <LanderTally />
        </div>
        <aside className="apollo" aria-label={APOLLO_HEADING}>
          <h2 className="apollo-h">{APOLLO_HEADING}</h2>
          <ul className="apollo-list">
            {APOLLO_QUOTES.map((q: ApolloQuote) => (
              <li key={q.mission}>
                <span className="apollo-mission">{q.mission}</span>
                <span>
                  {q.setup} “{q.quote}.”
                </span>
              </li>
            ))}
          </ul>
        </aside>
      </section>

      <h2 className="section-title">{FAILURES_HEADING}</h2>
      <section className="failures" aria-label={FAILURES_HEADING}>
        {FAILURES.map((f) => (
          <FailureCard key={f.mission} f={f} />
        ))}
      </section>
      <p className="failures-fourth">
        <HazardGlyph hazard="slope" />
        {FOURTH_MEASURE}
      </p>

      <Explainer />

      <section className="question">
        <div>
          <h2>Where on Earth can we rehearse these before Artemis IV?</h2>
          <p>
            NASA’s current plan (October 2026) names Artemis IV, targeted for 2028, as the first crewed landing near the lunar south pole.
            Every rehearsal we can run on Earth before then is cheaper than learning on the Moon.
          </p>
        </div>
        <button type="button" className="btn btn-lg" onClick={(): void => setScreen('moon')}>
          Profile the nine regions →
        </button>
      </section>
    </div>
  );
}
