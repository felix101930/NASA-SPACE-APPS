// "How this works": short, with units; each choice's justification lives in the ⓘ boxes next to the result.
import type { JSX } from 'react';
import { WhyBody } from '../../components/Term';
import type { Findback } from './findback';

function pct(v: number | null): string | null {
  return v === null ? null : `${Math.round(v * 100)}%`;
}

export function HowItWorks({ findback, nPaths }: { findback: Findback | null; nPaths: string }): JSX.Element {
  const top5 = pct(findback?.top5 ?? null);
  const n = findback?.nRoutes ?? null;
  return (
    <>
      <p>
        <strong>Compare.</strong> 100 points along your Moon route give a height profile (m) and a slope profile (°). The same is done for{' '}
        {nPaths} straight Earth paths of 1, 2 and 5 km, each walked both ways. The smallest combined height and slope gap wins.
      </p>
      <WhyBody id="walkMatcher" />
      {n && (
        <p>
          Test: {n} hidden, altered copies{findback?.noiseM ? ` (${findback.noiseM} m height noise` : ''}
          {findback?.stretch ? `, ${Math.round(findback.stretch * 100)}% stretch, half reversed)` : findback?.noiseM ? ')' : ''}
          {top5 ? `; the copy was in the top five ${top5} of the time` : ''}.
        </p>
      )}
      <p>
        <strong>Limits.</strong> Earth paths are straight lines, not trails. Both elevation models have 30 m pixels, so features under about 60 m
        are invisible. Only the slope profile is matched, not rocks, dust, light or gravity.
      </p>
    </>
  );
}
