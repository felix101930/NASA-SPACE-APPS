// Small helpers that put explanations behind an ⓘ instead of on the page.
//   <Term id="rimDrop" />            -> "Rim drop ⓘ"  (glossary: one plain sentence)
//   <Term id="rimDrop">rim jump</Term> -> custom visible label, same box
//   <Why id="rimP95" />              -> ⓘ only      (method note: why this choice + how accurate)
// Both render InfoTip (a <div>), so never place them inside a <p>; use a <div>/<span> row instead.
import type { JSX, ReactNode } from 'react';
import { InfoTip } from './InfoTip';
import { GLOSSARY, type GlossaryId } from '../glossary';
import { METHOD_NOTES, type MethodNoteId } from '../lib/methodNotes';
import '../styles/clarity.css';

export function TermBody({ id }: { id: GlossaryId }): JSX.Element {
  return <p>{GLOSSARY[id].plain}</p>;
}

export function Term({ id, children, align }: { id: GlossaryId; children?: ReactNode; align?: 'start' | 'end' }): JSX.Element {
  const g = GLOSSARY[id];
  return (
    <span className="term">
      {children ?? g.term}
      <InfoTip label={`What is ${g.term.toLowerCase()}?`} title={g.term} align={align}>
        <TermBody id={id} />
      </InfoTip>
    </span>
  );
}

export function WhyBody({ id }: { id: MethodNoteId }): JSX.Element {
  const n = METHOD_NOTES[id];
  return (
    <>
      <p>
        <strong>Why:</strong> {n.why}
      </p>
      <p>
        <strong>How accurate:</strong> {n.accuracy}
      </p>
    </>
  );
}

export function Why({ id, align }: { id: MethodNoteId; align?: 'start' | 'end' }): JSX.Element {
  const n = METHOD_NOTES[id];
  return (
    <InfoTip label={n.q} title={n.q} align={align}>
      <WhyBody id={id} />
    </InfoTip>
  );
}
