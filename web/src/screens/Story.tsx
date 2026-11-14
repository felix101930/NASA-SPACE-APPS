import type { JSX } from 'react';
import { FAILURES, HAZARDS, type FailureStory } from '../content';
import { useApp } from '../store';
import type { HazardId } from '../types/contract';

const HZ_COLOR: Record<HazardId, string> = {
  shadow: 'var(--hz-shadow)',
  rim: 'var(--hz-rim)',
  texture: 'var(--hz-texture)',
};

/** Schematic drawings, explicitly not to scale. */
function Diagram({ hazard }: { hazard: HazardId }): JSX.Element {
  if (hazard === 'rim') {
    return (
      <svg viewBox="0 0 400 170" role="img" aria-label="Schematic: a descent path passes over a cliff, so the ground suddenly drops away beneath the lander">
        <path d="M0 70 L150 70 L170 66 L178 150 L400 150 L400 170 L0 170Z" fill="#2a2d35" />
        <path d="M0 70 L150 70 L170 66 L178 150 L400 150" fill="none" stroke="#6d717b" strokeWidth="1.5" />
        <path d="M30 22 C120 26 220 34 330 56" fill="none" stroke="var(--hz-rim)" strokeWidth="2" strokeDasharray="5 5" />
        <circle cx="168" cy="31" r="5" fill="var(--hz-rim)" />
        <line x1="120" y1="27" x2="120" y2="70" stroke="#b4afa6" strokeDasharray="2 3" />
        <line x1="215" y1="35" x2="215" y2="150" stroke="#b4afa6" strokeDasharray="2 3" />
        <text x="126" y="56" fill="#b4afa6" fontSize="11" fontFamily="IBM Plex Mono">short</text>
        <text x="221" y="110" fill="#ece7de" fontSize="11" fontFamily="IBM Plex Mono">sudden jump</text>
        <text x="8" y="164" fill="#8f8b84" fontSize="10">schematic, not to scale</text>
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
        <path d="M0 110 L60 110 Q80 96 96 110 L130 110 Q150 140 172 110 L230 110 Q250 98 262 110 L300 110 Q318 134 338 110 L400 110 L400 170 L0 170Z" fill="#3a3c43" />
        <path d="M96 110 L172 110 L150 128Z" fill="#05060a" />
        <path d="M262 110 L338 110 L320 126Z" fill="#05060a" />
        <path d="M96 106 L230 112 L96 112Z" fill="#05060a" opacity="0.9" />
        <path d="M262 106 L400 113 L262 113Z" fill="#05060a" opacity="0.9" />
        <line x1="24" y1="96" x2="400" y2="113" stroke="#f3b54a" strokeOpacity="0.55" strokeDasharray="3 4" />
        <text x="250" y="150" fill="#ece7de" fontSize="11" fontFamily="IBM Plex Mono">long shadows</text>
        <text x="8" y="164" fill="#8f8b84" fontSize="10">schematic, not to scale</text>
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 400 170" role="img" aria-label="Schematic: smooth, repeating sand ripples offer a camera almost no distinct features">
      <path
        d="M0 100 Q25 82 50 100 T100 100 T150 100 T200 100 T250 100 T300 100 T350 100 T400 100 L400 170 L0 170Z"
        fill="#3a3a3a"
      />
      <path
        d="M0 100 Q25 82 50 100 T100 100 T150 100 T200 100 T250 100 T300 100 T350 100 T400 100"
        fill="none"
        stroke="#6d717b"
      />
      <rect x="150" y="18" width="100" height="60" fill="none" stroke="var(--hz-texture)" strokeWidth="1.5" strokeDasharray="4 4" />
      <text x="158" y="54" fill="var(--hz-texture)" fontSize="11" fontFamily="IBM Plex Mono">no features?</text>
      <text x="8" y="164" fill="#8f8b84" fontSize="10">schematic, not to scale</text>
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
          <span className="num faint">{f.year}</span>
        </div>
        <blockquote>{f.body}</blockquote>
        <div className="failure-foot">
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
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="hz-dot" style={{ background: HZ_COLOR[f.hazard] }} aria-hidden="true" />
            <span>
              We measure: <strong>{hz.name}</strong>
            </span>
          </span>
        </div>
      </div>
    </article>
  );
}

export function Story(): JSX.Element {
  const setScreen = useApp((s) => s.setScreen);
  return (
    <div>
      <section className="story-hero">
        <h1>
          Three landings. Three ways the ground <em>fooled the machine.</em>
        </h1>
        <p>
          Each failure below came from terrain and light, not from a broken engine. We turn each one into a measurable
          hazard, profile NASA’s nine candidate regions near the lunar south pole, and find places on Earth where a crew
          and a lander can meet the same hazard first.
        </p>
      </section>

      <section className="failures" aria-label="Three landing failures">
        {FAILURES.map((f) => (
          <FailureCard key={f.mission} f={f} />
        ))}
      </section>

      <section className="question">
        <div>
          <h2>Where on Earth can we rehearse these before Artemis IV?</h2>
          <p>
            NASA’s current plan (October 2026) names Artemis IV, targeted for 2028, as the first crewed landing near the
            lunar south pole. Every rehearsal we can run on Earth before then is cheaper than learning on the Moon.
          </p>
        </div>
        <button className="btn btn-primary" onClick={(): void => setScreen('moon')}>
          Profile the nine regions →
        </button>
      </section>

      <section className="how" aria-label="How it works">
        <div>
          <h3>1 · Danger profile</h3>
          <p>Shadow, rim jumps, camera texture and slope for each region, from the 20 m LOLA elevation model.</p>
        </div>
        <div>
          <h3>2 · Earth matches</h3>
          <p>27 searches (9 regions × 3 hazards) over Earth sites, top 3 each, with dates when the sun matches.</p>
        </div>
        <div>
          <h3>3 · Compare and walk</h3>
          <p>Same light, same scale, side by side in 3D. Draw a moonwalk and find the Earth path that feels the same.</p>
        </div>
        <div>
          <h3>4 · Honest limits</h3>
          <p>No “% Moon-like” score. Every match lists what it cannot test, and the validation shows where we fail.</p>
        </div>
      </section>
    </div>
  );
}
