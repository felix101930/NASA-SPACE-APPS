// Moon-region choices for the custom Select, with a one-line hint from the Summary ranking when it is loaded.
import type { SelectOption } from '../components/Select';
import type { RankingRow } from '../types/contract';

interface RegionLike {
  id: string;
  name: string;
}

/** "Easiest of 9 to rehearse on Earth" / "#4 of 9 to rehearse on Earth" / "Hardest of 9 …"; none without a ranking. */
export function regionOptions(regions: readonly RegionLike[], ranking: readonly RankingRow[] | null | undefined): SelectOption<string>[] {
  const rows = ranking ?? [];
  const n = rows.length;
  const rankOf = new Map<string, number>(rows.map((r: RankingRow): [string, number] => [r.region_id, r.rank]));
  return regions.map((r: RegionLike): SelectOption<string> => {
    const k = rankOf.get(r.id);
    const hint =
      k === undefined || n < 2
        ? undefined
        : k === 1
          ? `Easiest of ${n} to rehearse on Earth`
          : k === n
            ? `Hardest of ${n} to rehearse on Earth`
            : `#${k} of ${n} to rehearse on Earth`;
    return { value: r.id, label: r.name, hint };
  });
}
