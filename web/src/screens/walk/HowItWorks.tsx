// "How this works": the method in plain words first, the technical names second, and the honest limits.
import type { JSX } from 'react';
import type { Findback } from './findback';

function pct(v: number | null): string | null {
  return v === null ? null : `${Math.round(v * 100)}%`;
}

export function HowItWorks({ findback, nPaths }: { findback: Findback | null; nPaths: string }): JSX.Element {
  const top1 = pct(findback?.top1 ?? null);
  const top5 = pct(findback?.top5 ?? null);
  const dtw = pct(findback?.dtwTop1 ?? null);
  const n = findback?.nRoutes ?? null;
  return (
    <>
      <p>
        <strong>What we compare.</strong> We read the Moon elevation model at 100 evenly spaced points along your route and turn it into two
        profiles: height above the start, and slope underfoot. We do the same for {nPaths} straight Earth paths (1, 2 and 5 km long, called
        transects) cut from the screened 15 km Earth squares, and compare each one walked both ways.
      </p>
      <p>
        <strong>How we score.</strong> For every path we measure the typical gap between the two height profiles and between the two slope
        profiles (root-mean-square), with each scaled by how much it varies across all Earth paths so neither dominates (standardisation). The
        smallest combined gap wins. “Heights within 4 m” means the two walks are typically 4 m apart in height along the way.
      </p>
      {top1 && (
        <p>
          <strong>Does it find the right path?</strong> We hid {n ?? 'several hundred'} lightly altered copies of Moon routes among the Earth paths
          {findback?.noiseM ? ` (${findback.noiseM} m of height noise` : ''}
          {findback?.stretch ? `, ${Math.round(findback.stretch * 100)}% stretch, half walked backwards)` : findback?.noiseM ? ')' : ''} and asked
          the search to find them. It put the hidden copy first {top1} of the time{top5 ? ` and in the top five ${top5}` : ''}.
        </p>
      )}
      <p>
        <strong>Stretched routes.</strong> The option under “More options” uses dynamic time warping (DTW) on slope, limited to a Sakoe–Chiba
        band of 10% of the walk, so a hill may sit a little earlier or later. It is slower and{dtw ? ` found the hidden copy first only ${dtw} of the time` : ' less accurate on ordinary routes'}, so it is off by default.
      </p>
      <p>
        <strong>How close is close?</strong> “Close”, “partial” and “loose” compare your best match with the best matches we found for the test
        routes above.
      </p>
      <p>
        <strong>Limits.</strong> Earth paths are straight lines inside screened squares, not trails. Both elevation models have about 30 m pixels,
        so boulders and small craters are invisible. We match the slope profile only: not the surface, rocks, dust, lighting or gravity.
      </p>
    </>
  );
}
