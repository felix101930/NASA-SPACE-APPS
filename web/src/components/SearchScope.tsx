import { useEffect, useState, type JSX } from 'react';
import { loadOptionalJson } from '../data/loader';
import type { CoreData } from '../store';
import type { MethodStratum } from '../types/contract';
import { isAlbertaFile } from '../types/alberta';

/* Two small tables for the Summary page: how much of Earth the screen covered (method.json, alberta.json) and
   which sites got the full 30 m analysis (earth_sites.json, grouped by selected_by). */

const nf = new Intl.NumberFormat('en-US');

interface AlbertaScope {
  squares: number;
  km2: number;
}

interface Group {
  key: string;
  label: string;
  why: string;
}

const GROUPS: readonly Group[] = [
  { key: 'global_screen', label: 'Best candidates from the search', why: 'To find new stand-ins' },
  {
    key: 'documented',
    label: 'Known analogs used by NASA, ESA and other agencies (from the literature)',
    why: 'To compare our picks with real training sites',
  },
  {
    key: 'validation',
    label: 'Validation sites: known analogs held back for testing, plus decoys such as cities and farmland',
    why: 'To check the method tells Moon-like ground from ordinary ground',
  },
];

function millions(km2: number): string {
  return km2 >= 1e6 ? `${(km2 / 1e6).toFixed(1)} million km²` : `${nf.format(Math.round(km2))} km²`;
}

function roundTo(n: number, step: number): string {
  return nf.format(Math.round(n / step) * step);
}

/** "60°S to 83°N" from strata bands like "-60..-35" and "70..83". */
function latRange(strata: MethodStratum[]): string | null {
  const ends = strata.flatMap((s: MethodStratum): number[] => s.lat_band.split('..').map(Number)).filter(Number.isFinite);
  if (ends.length === 0) return null;
  const fmt = (v: number): string => `${Math.abs(v)}°${v < 0 ? 'S' : v > 0 ? 'N' : ''}`;
  return `${fmt(Math.min(...ends))} to ${fmt(Math.max(...ends))}`;
}

export function SearchScope({ core }: { core: CoreData }): JSX.Element | null {
  const [alberta, setAlberta] = useState<AlbertaScope | null>(null);
  useEffect((): void => {
    loadOptionalJson('alberta/alberta.json', isAlbertaFile)
      .then((r): void => setAlberta(r ? { squares: r.value.coverage.n_windows, km2: r.value.coverage.province_km2 } : null))
      .catch((): void => undefined);
  }, []);

  const screen = core.method?.file.screen ?? null;
  const counts = new Map<string, number>();
  for (const s of core.sites) {
    if (s.selected_by) counts.set(s.selected_by, (counts.get(s.selected_by) ?? 0) + 1);
  }
  const groups = GROUPS.filter((g: Group): boolean => (counts.get(g.key) ?? 0) > 0);
  const total = groups.reduce((a: number, g: Group): number => a + (counts.get(g.key) ?? 0), 0);
  if (!screen && total === 0) return null;
  const lat = screen ? latRange(screen.strata) : null;

  return (
    <div className="an-scope">
      {screen && (
        <div className="an-scope-block">
          <h3>How much of Earth we searched</h3>
          <table className="an-kv">
            <tbody>
              <tr>
                <th scope="row">Area searched</th>
                <td>
                  <strong>{millions(screen.coverage_km2)}</strong> ({nf.format(screen.n_screened)} squares of 15 × 15 km)
                </td>
              </tr>
              {alberta && (
                <tr>
                  <th scope="row">Compared with Alberta</th>
                  <td>about {Math.round(screen.coverage_km2 / alberta.km2)}× its area</td>
                </tr>
              )}
              <tr>
                <th scope="row">Share of Earth’s bare land</th>
                <td>about {Math.round(screen.coverage_pct_bare)}%</td>
              </tr>
              {lat && (
                <tr>
                  <th scope="row">Latitudes</th>
                  <td>{lat}</td>
                </tr>
              )}
              {alberta && (
                <tr>
                  <th scope="row">Plus all of Alberta</th>
                  <td>
                    {nf.format(alberta.squares)} squares, about {roundTo(alberta.km2, 1000)} km²
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {total > 0 && (
        <div className="an-scope-block">
          <h3>Sites measured in detail (30 m)</h3>
          <table className="an-kv an-groups">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Sites</th>
                <th scope="col">Why</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: Group) => (
                <tr key={g.key}>
                  <th scope="row">{g.label}</th>
                  <td className="an-n">{nf.format(counts.get(g.key) ?? 0)}</td>
                  <td>{g.why}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                <td className="an-n">
                  <strong>{nf.format(total)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
