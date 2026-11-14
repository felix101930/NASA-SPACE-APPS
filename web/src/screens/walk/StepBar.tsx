// The three steps of the walk screen, always visible: what you picked, and what happens next.
import type { JSX } from 'react';
import type { Region } from '../../types/contract';

export type StepState = 'done' | 'current' | 'todo';

interface StepInfo {
  state: StepState;
  value: string;
}

interface StepBarProps {
  regions: Region[];
  regionId: string;
  onRegion: (id: string) => void;
  step2: StepInfo;
  step3: StepInfo;
}

function Marker({ n, state }: { n: number; state: StepState }): JSX.Element {
  return (
    <span className="wk-step-n" data-state={state} aria-hidden="true">
      {state === 'done' ? (
        <svg width="14" height="14" viewBox="0 0 14 14">
          <path d="M3 7.5l2.6 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        n
      )}
    </span>
  );
}

export function StepBar({ regions, regionId, onRegion, step2, step3 }: StepBarProps): JSX.Element {
  const stateWord = (s: StepState): string => (s === 'done' ? 'done' : s === 'current' ? 'current step' : 'not started');
  return (
    <ol className="wk-steps" aria-label="Steps">
      <li className="wk-step" data-state="done">
        <Marker n={1} state="done" />
        <div className="wk-step-body">
          <label className="wk-step-label" htmlFor="wk-region">
            Moon region
          </label>
          <select id="wk-region" className="select wk-step-select" value={regionId} onChange={(e): void => onRegion(e.target.value)}>
            {regions.map((r: Region) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </div>
      </li>
      <li className="wk-step" data-state={step2.state} aria-current={step2.state === 'current' ? 'step' : undefined}>
        <Marker n={2} state={step2.state} />
        <div className="wk-step-body">
          <span className="wk-step-label">
            Route {step2.state !== 'done' && <span className="sr-only">({stateWord(step2.state)})</span>}
          </span>
          <span className="wk-step-value">{step2.value}</span>
        </div>
      </li>
      <li className="wk-step" data-state={step3.state} aria-current={step3.state === 'current' ? 'step' : undefined}>
        <Marker n={3} state={step3.state} />
        <div className="wk-step-body">
          <span className="wk-step-label">
            Earth twin {step3.state !== 'done' && <span className="sr-only">({stateWord(step3.state)})</span>}
          </span>
          <span className="wk-step-value" aria-live="polite">
            {step3.value}
          </span>
        </div>
      </li>
    </ol>
  );
}
