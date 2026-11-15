import { useEffect, useState, type JSX } from 'react';
import { HAZARDS } from '../content';
import { HazardGlyph } from './Glyphs';
import { InfoTip } from './InfoTip';
import { loadOptionalJson } from '../data/loader';
import { matchesFor, useApp, type CoreData } from '../store';
import { HAZARD_IDS, isMeta, isObj, type EarthSite, type HazardId, type Meta } from '../types/contract';
import { placeName } from '../lib/placeName';
import '../styles/analogs.css';

/* ---------------------------------------------------------------- analog_tags.json (pipeline/match/analog_tags.py) */

type NoveltyGroup = 'established' | 'near_known' | 'studied_region' | 'new';
const NOVELTY_GROUPS: readonly NoveltyGroup[] = ['established', 'near_known', 'studied_region', 'new'];

interface ProtectedArea {
  name: string | null;
  designation: string | null;
  iucn: string | null;
  covers_centre: boolean;
}

interface SiteTags {
  protected: { centre_inside: boolean; square_overlaps: boolean; areas: ProtectedArea[] };
  novelty: NoveltyGroup | null;
}

interface AnalogTagsFile {
  meta: Meta;
  n_sites: number;
  novelty: { counts: Record<NoveltyGroup, number>; total: number; per_site_available: boolean; checked: string };
  sites: Record<string, SiteTags>;
}

const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const isNovelty = (v: unknown): v is NoveltyGroup => typeof v === 'string' && (NOVELTY_GROUPS as readonly string[]).includes(v);

function isArea(v: unknown): v is ProtectedArea {
  return isObj(v) && isStrOrNull(v.name) && isStrOrNull(v.designation) && isStrOrNull(v.iucn) && typeof v.covers_centre === 'boolean';
}

function isSiteTags(v: unknown): v is SiteTags {
  if (!isObj(v) || !isObj(v.protected) || !(v.novelty === null || isNovelty(v.novelty))) return false;
  const p = v.protected;
  return typeof p.centre_inside === 'boolean' && typeof p.square_overlaps === 'boolean' && Array.isArray(p.areas) && p.areas.every(isArea);
}

function isAnalogTagsFile(v: unknown): v is AnalogTagsFile {
  if (!isObj(v) || !isMeta(v.meta) || typeof v.n_sites !== 'number' || !isObj(v.novelty) || !isObj(v.sites)) return false;
  const n = v.novelty;
  const counts = n.counts;
  return (
    isObj(counts) &&
    NOVELTY_GROUPS.every((g: NoveltyGroup): boolean => typeof counts[g] === 'number') &&
    typeof n.total === 'number' &&
    typeof n.per_site_available === 'boolean' &&
    typeof n.checked === 'string' &&
    Object.values(v.sites).every(isSiteTags)
  );
}

/* ---------------------------------------------------------------- list rows */

const NOVELTY_TAG: Record<NoveltyGroup, string> = {
  new: 'New',
  established: 'Known analog',
  near_known: 'Near a known analog',
  studied_region: 'Studied region',
};

interface Use {
  regionId: string;
  regionName: string;
  hazard: HazardId;
  rank: number;
}

interface Row {
  site: EarthSite;
  uses: Use[];
  tags: SiteTags | null;
}

const IUCN_ORDER = ['Ia', 'Ib', 'II', 'III', 'IV', 'V', 'VI'];

/** The area to name on the tag: one that covers the centre, then the strictest IUCN category. */
function mainArea(areas: ProtectedArea[]): ProtectedArea | null {
  const rank = (a: ProtectedArea): number => {
    const i = a.iucn ? IUCN_ORDER.indexOf(a.iucn) : -1;
    return (a.covers_centre ? 0 : 100) + (i >= 0 ? i : 50);
  };
  return [...areas].sort((a: ProtectedArea, b: ProtectedArea): number => rank(a) - rank(b))[0] ?? null;
}

function areaText(a: ProtectedArea): string {
  const iucn = a.iucn && IUCN_ORDER.includes(a.iucn) ? ` (IUCN ${a.iucn})` : '';
  return `${a.name ?? 'Unnamed'}${a.designation ? `, ${a.designation}` : ''}${iucn}`;
}

function buildRows(core: CoreData, tags: AnalogTagsFile | null): Row[] {
  const bySite = new Map<string, Use[]>();
  for (const r of core.regions) {
    for (const h of HAZARD_IDS) {
      for (const m of matchesFor(core, r.id, h)) {
        const list = bySite.get(m.site_id) ?? [];
        list.push({ regionId: r.id, regionName: r.name, hazard: h, rank: m.rank });
        bySite.set(m.site_id, list);
      }
    }
  }
  const rows: Row[] = [];
  for (const [id, uses] of bySite) {
    const site = core.siteById.get(id);
    if (!site) continue;
    uses.sort((a: Use, b: Use): number => a.rank - b.rank || a.regionName.localeCompare(b.regionName));
    rows.push({ site, uses, tags: tags?.sites[id] ?? null });
  }
  // most useful first: best rank, then how many region x danger slots the site fills
  return rows.sort(
    (a: Row, b: Row): number =>
      a.uses[0].rank - b.uses[0].rank || b.uses.length - a.uses.length || a.site.country.localeCompare(b.site.country),
  );
}

/* ---------------------------------------------------------------- component */

/** `onMeta` hands the file's sources to the page credits. */
export function AnalogList({ core, onMeta }: { core: CoreData; onMeta?: (m: Meta) => void }): JSX.Element | null {
  const setRegion = useApp((s) => s.setRegion);
  const setHazard = useApp((s) => s.setHazard);
  const setSite = useApp((s) => s.setSite);
  const setScreen = useApp((s) => s.setScreen);
  const [tags, setTags] = useState<AnalogTagsFile | null>(null);
  useEffect((): void => {
    loadOptionalJson('analog_tags.json', isAnalogTagsFile)
      .then((r): void => {
        setTags(r?.value ?? null);
        if (r && onMeta) onMeta(r.value.meta);
      })
      .catch((): void => undefined);
  }, [onMeta]);

  const rows = buildRows(core, tags);
  if (rows.length === 0) return null;
  const open = (u: Use, siteId: string): void => {
    setRegion(u.regionId);
    setHazard(u.hazard);
    setSite(siteId);
    setScreen('region');
  };
  const nInside = rows.filter((r: Row): boolean => r.tags?.protected.centre_inside === true).length;
  const nv = tags?.novelty;

  return (
    <section className="sum-section" aria-labelledby="analogs-h">
      <h2 id="analogs-h">Earth analogs we found</h2>
      {nv && (
        <div className="an-lead">
          <span>
            <strong>
              {nv.counts.new} of {nv.total}
            </strong>{' '}
            sites are new: no prior analog study found in the catalogues and literature we checked.
          </span>
          <InfoTip label="How we checked" title="New analogs">
            <p>
              Checked against {nv.checked}. Of {nv.total} sites: {nv.counts.established} are already established analogs,{' '}
              {nv.counts.near_known} lie 50 to 100 km from one, {nv.counts.studied_region} sit inside a region already studied as an analog, and{' '}
              {nv.counts.new} have no prior analog study we could find.
            </p>
          </InfoTip>
        </div>
      )}
      {tags && (
        <p className="caption an-sub">
          {nInside} of {rows.length} sit inside a protected area, so a rehearsal there may need a permit.
        </p>
      )}
      <div className="an-scroll">
        <table className="an-table">
          <thead>
            <tr>
              <th scope="col">Earth site</th>
              <th scope="col">Stands in for</th>
              <th scope="col">Tags</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: Row) => {
              const p = placeName(r.site);
              const area = r.tags ? mainArea(r.tags.protected.areas) : null;
              const all = r.tags ? r.tags.protected.areas.map(areaText).join('\n') : '';
              return (
                <tr key={r.site.id}>
                  <th scope="row" title={p.title}>
                    <span className="an-name">{r.site.name}</span>
                    <span className="caption">{r.site.country}</span>
                  </th>
                  <td>
                    <div className="an-uses">
                      {r.uses.map((u: Use) => (
                        <button
                          key={`${u.regionId}-${u.hazard}`}
                          type="button"
                          className="chip chip-button an-use"
                          title={`#${u.rank} for ${HAZARDS[u.hazard].name} at ${u.regionName}. Open the match.`}
                          onClick={(): void => open(u, r.site.id)}
                        >
                          <HazardGlyph hazard={u.hazard} size={14} />
                          {u.regionName}
                          {u.rank > 1 && <span className="an-rank">#{u.rank}</span>}
                        </button>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="an-tags">
                      {r.tags?.novelty && (
                        <span className="chip an-tag" data-kind={r.tags.novelty === 'new' ? 'new' : 'known'}>
                          {NOVELTY_TAG[r.tags.novelty]}
                        </span>
                      )}
                      {r.tags?.protected.centre_inside && area && (
                        <span className="chip an-tag" data-kind="protected" title={all}>
                          Protected area
                        </span>
                      )}
                      {r.tags && !r.tags.protected.centre_inside && r.tags.protected.square_overlaps && area && (
                        <span className="chip chip-dashed an-tag" title={all}>
                          Borders protected area
                        </span>
                      )}
                      {area && <span className="caption an-area">{area.name}</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="caption an-sub">
        Protected areas: UNEP-WCMC and IUCN, Protected Planet (WDPCA, November 2026). Hover a tag for every area that overlaps the 15 km site.
      </p>
    </section>
  );
}
