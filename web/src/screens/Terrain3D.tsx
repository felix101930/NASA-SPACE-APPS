import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { HazardGlyph, SunGlyph } from '../components/Glyphs';
import { SampleChip } from '../components/ScreenHead';
import { TERRAIN_KM } from '../components/terrainGeometry';
import { mapToPixel } from '../lib/terrain';
import { matchesFor, useApp, useRegion, type CoreData } from '../store';
import { HAZARD_IDS, type EarthSite, type HazardId, type LightRow, type Match, type Region, type RehearsalWindow, type ShadowMask } from '../types/contract';
import { HAZARDS } from '../content';
import { dirWord } from '../lib/shadow';
import { fmtLatLon, placeName, type PlaceName } from '../lib/placeName';
import { InfoTip } from '../components/InfoTip';
import { Select } from '../components/Select';
import { regionOptions } from '../lib/regionOptions';
import { Term, Why } from '../components/Term';
import {
  bestDateIndex,
  buildVerdict,
  CLOSE_GAP_PTS,
  compass,
  dateFit,
  fitText,
  fmtMinutes,
  HAZARD_TAB,
  lowSunWindow,
  pct0,
  windowDate,
  windowMinutes,
  windowStart,
  type DateFit,
  type Verdict,
  verdictLight,
} from './terrain3d/copy';
import {
  moonRimSegs,
  useAnnotations,
  useCellTexture,
  useDateShares,
  useEarthRimSegs,
  useMaskTexture,
  useShadowShare,
  useSiteStillListed,
  useTile,
  type DatePair,
  type RimSeg,
  type ShadowShare,
  type SunDir,
} from './terrain3d/data';
import { EvidenceTable, nasademAgreement, NotesBoxes, WindowsList } from './terrain3d/Evidence';
import { Pane } from './terrain3d/Scene';
import { DropZoneLegend, type DropZoneStats } from './terrain3d/DropZoneLayer';
import type { PatchLayerData } from './terrain3d/PatchLayer';
import { headlineLight } from '../components/PatchFor';
import { PatchLegend } from '../components/PatchGrid';
import { patchPair, type PatchPair } from '../lib/patchScale';
import { useSunSweep, type SunSweep, type SweepMode } from '../lib/useSunSweep';
import './terrain3d/terrain3d.css';

const SUN_PRESETS: readonly number[] = [1.5, 3, 5];
const RIM_COUNT = 3;
const TEXTURE_TINT = '#D98CC4';
const NO_MASKS: ShadowMask[] = [];

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

function sitePlace(site: EarthSite, match: Match | null): PlaceName {
  const name = match && 'site_name' in match && typeof match.site_name === 'string' ? match.site_name : site.name;
  const regionLabel = 'region_label' in site && typeof site.region_label === 'string' ? site.region_label : null;
  return placeName({ name, country: site.country, lat: site.lat, lon: site.lon, region_label: regionLabel });
}

const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function shortDate(w: RehearsalWindow): string {
  const d = new Date(w.start_utc);
  return Number.isNaN(d.getTime()) ? w.start_utc.slice(0, 10) : SHORT_DATE.format(d);
}

function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a: number, b: number): number => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** "On Earth this low sun lasts about 3 minutes; at the Moon's pole it lasts for days." */
function lowSunInsight(windows: RehearsalWindow[], site: EarthSite): string | null {
  const mins = windows.map(windowMinutes).filter((m: number | null): m is number => m !== null && Number.isFinite(m));
  const m = median(mins);
  if (m === null) return null;
  if (m >= 60) {
    return `At ${Math.abs(site.lat).toFixed(0)}° ${site.lat >= 0 ? 'N' : 'S'} the sun skims the horizon, so this low sun lasts about ${fmtMinutes(m)} here, far longer than at most Earth sites; at the Moon’s pole it lasts for days.`;
  }
  return `On Earth this low sun lasts about ${fmtMinutes(m)}; at the Moon’s pole it lasts for days.`;
}

/** Grid azimuth of true north on a UTM Earth tile (pipeline extra; 0 when absent). */
function trueNorthGridAz(site: EarthSite): number {
  const t = site.tile;
  return 'true_north_grid_az_deg' in t && typeof t.true_north_grid_az_deg === 'number' ? t.true_north_grid_az_deg : 0;
}

/** A geographic sun azimuth at the Earth site, as an azimuth from the tile's top (grid +y). */
function gridAzFor(site: EarthSite, geoAz: number): number {
  return (((geoAz + trueNorthGridAz(site)) % 360) + 360) % 360;
}

/** The panes' sun for a rehearsal date: its height (kept within the slider) and its bearing as a tile azimuth. */
function windowSun(site: EarthSite, w: RehearsalWindow): SunDir {
  return {
    el: Math.round(Math.min(30, Math.max(0.5, w.sun_el)) * 10) / 10,
    az: Math.round(gridAzFor(site, w.sun_az) * 10) / 10,
  };
}

const NO_WINDOWS: RehearsalWindow[] = [];
const CHIP_COUNT = 3;

/** The dates on the chips: the 3 closest fits once known (else the first 3), in date order. */
function chipIndices(fits: (DateFit | null)[], ready: boolean): number[] {
  const all = fits.map((_f: DateFit | null, i: number): number => i);
  if (!ready) return all.slice(0, CHIP_COUNT);
  const gapOf = (i: number): number => {
    const f = fits[i];
    return f ? Math.abs(f.earth - f.moon) : Infinity;
  };
  return [...all]
    .sort((a: number, b: number): number => gapOf(a) - gapOf(b) || a - b)
    .slice(0, CHIP_COUNT)
    .sort((a: number, b: number): number => a - b);
}

function siteMetric(site: EarthSite, key: string): number | null {
  const v = site.metrics[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nScreened(core: CoreData): number | null {
  const n = core.method?.file.screen.n_screened;
  return typeof n === 'number' && n > 0 ? n : null;
}

/** The sweep's reference directions: the 8 compass marks, every 45° from the tile's top. */
const SWEEP_MARKS: readonly number[] = [0, 45, 90, 135, 180, 225, 270, 315];

function readSunAz(): number {
  return useApp.getState().sunAz;
}

function applySunAz(az: number): void {
  const s = useApp.getState();
  s.setSun(s.sunEl, az);
}

/** "64% dark" when the readout is for this sun, else an ellipsis (a fresh figure is on its way, ≤ 4 a second). */
function shareFor(s: ShadowShare | null, el: number, az: number | null): string {
  // az null = smooth turn: show the latest figure (it trails the sun by at most a quarter second).
  return s && Math.abs(s.el - el) < 0.01 && (az === null || Math.abs(s.az - az) < 0.6) ? `${pct0(s.frac)} dark` : '…';
}

function SweepNow({
  sweep,
  el,
  az,
  moon,
  earth,
}: {
  sweep: SunSweep;
  el: number;
  az: number;
  moon: ShadowShare | null;
  earth: ShadowShare | null;
}): JSX.Element | null {
  const st = sweep.state;
  if (st.phase === 'idle') return null;
  const dirAz = st.markAz ?? az;
  const elTxt = `${el.toFixed(el % 1 ? 1 : 0)}°`;
  const settled = st.markAz === null || st.arrived;
  const figures = settled ? (
    <>
      Moon <strong>{shareFor(moon, el, st.markAz)}</strong> · Earth <strong>{shareFor(earth, el, st.markAz)}</strong>
    </>
  ) : (
    <span className="sweep-moving">moving…</span>
  );
  return (
    <div className="t3-sweep-now sweep-now" role="status">
      {st.total > 0 && (
        <span className="sweep-marks" aria-hidden="true">
          {Array.from({ length: st.total }, (_v: unknown, i: number) => (
            <span key={i} className="sweep-mark" data-state={st.step === null ? 'todo' : i < st.step ? 'done' : i === st.step ? 'now' : 'todo'} />
          ))}
        </span>
      )}
      <span className="sweep-text">
        Sun from the <strong>{dirWord(dirAz)}</strong> · {elTxt} · {figures}
        {st.step !== null && st.total > 0 && (
          <span className="sweep-count">
            {' '}
            ({st.step + 1} of {st.total})
          </span>
        )}
        {st.phase === 'paused' && <span className="sweep-count"> · paused</span>}
      </span>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Pickers
// ------------------------------------------------------------------------------------------------

interface SiteChoice {
  site: EarthSite;
  match: Match | null;
  place: PlaceName;
}

function Pickers({
  core,
  region,
  hazard,
  choices,
  extra,
  selectedId,
}: {
  core: CoreData;
  region: Region;
  hazard: HazardId;
  choices: SiteChoice[];
  extra: SiteChoice | null;
  selectedId: string | null;
}): JSX.Element {
  const setRegion = useApp((s) => s.setRegion);
  const setHazard = useApp((s) => s.setHazard);
  const setSite = useApp((s) => s.setSite);
  const n = nScreened(core);
  return (
    <div className="t3-pickers panel">
      <div className="t3-pick-row">
        <Select
          className="t3-pick"
          labelClassName="t3-pick-label"
          label="Moon region"
          value={region.id}
          options={regionOptions(core.regions, core.summary?.ranking)}
          onChange={setRegion}
        />
        <div className="t3-pick t3-pick-hazard">
          <span className="t3-pick-label" id="t3-hz-label">
            Danger
          </span>
          <div className="t3-hz-tabs" role="tablist" aria-labelledby="t3-hz-label">
            {HAZARD_IDS.map((h: HazardId) => (
              <button
                key={h}
                type="button"
                role="tab"
                className="t3-hz-tab"
                data-hz={h}
                aria-selected={h === hazard}
                onClick={(): void => {
                  if (h !== hazard) setHazard(h);
                }}
              >
                <HazardGlyph hazard={h} />
                <span>{HAZARD_TAB[h].name}</span>
                <span className="t3-hz-mission">{HAZARDS[h].mission}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="t3-pick t3-pick-earth">
        <span className="t3-pick-label" id="t3-earth-label">
          Earth stand-ins
          <span className="t3-pick-hint">{n ? ` · top 3 of ${n.toLocaleString('en-US')} squares` : ' · top 3'}</span>
        </span>
        <div className="t3-chips" role="group" aria-labelledby="t3-earth-label">
          {choices.length === 0 && <p className="t3-note-empty">No Earth matches for this region and danger in matches.json.</p>}
          {choices.map((c: SiteChoice) => (
            <button
              key={c.site.id}
              type="button"
              className="t3-chip"
              aria-pressed={c.site.id === selectedId}
              title={`${c.place.title} · ${c.place.region ?? fmtLatLon(c.site.lat, c.site.lon)}`}
              onClick={(): void => setSite(c.site.id)}
            >
              <span className="t3-chip-rank">#{c.match?.rank ?? '–'}</span>
              <span className="t3-chip-text">
                <span className="t3-chip-name">{c.place.label}</span>
              </span>
            </button>
          ))}
          {extra && (
            <button type="button" className="t3-chip t3-chip-extra" aria-pressed title={extra.place.title}>
              <span className="t3-chip-rank">Walk</span>
              <span className="t3-chip-text">
                <span className="t3-chip-name">{extra.place.label}</span>
                <span className="t3-chip-sub">from your walk</span>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------
// Screen
// ------------------------------------------------------------------------------------------------

function Readout({ big, small }: { big: ReactNode; small: ReactNode }): JSX.Element {
  return (
    <>
      <span className="t3-readout-big">{big}</span>
      <span className="t3-readout-small">{small}</span>
    </>
  );
}

function shareBig(s: ShadowShare | null): string {
  return s ? `${pct0(s.frac)} dark` : '…';
}

export default function Terrain3D(): JSX.Element {
  const core = useApp((s) => s.core) as CoreData;
  const region = useRegion();
  const hazard = useApp((s) => s.hazard);
  const siteId = useApp((s) => s.siteId);
  const exag = useApp((s) => s.exaggeration);
  const setExag = useApp((s) => s.setExaggeration);
  const el = useApp((s) => s.sunEl);
  const az = useApp((s) => s.sunAz);
  const setSun = useApp((s) => s.setSun);
  const setSite = useApp((s) => s.setSite);
  const mode = useApp((s) => s.shadowMode);
  const setMode = useApp((s) => s.setShadowMode);
  const walk = useApp((s) => s.walk);
  const [sweepMode, setSweepMode] = useState<SweepMode>('smooth');
  const sweep = useSunSweep({ marks: SWEEP_MARKS, mode: sweepMode, getAz: readSunAz, setAz: applySunAz, holdMs: 1200, glideMs: 450 });
  const sweeping = sweep.state.phase !== 'idle';
  const [lift, setLift] = useState<boolean>(false);
  const [showPatches, setShowPatches] = useState<boolean>(false);
  // "Show big-drop zones": on whenever the Rim jump tab is selected; one colour max (the larger P99) for both panes.
  const [showDrops, setShowDrops] = useState<boolean>(false);
  useEffect((): void => setShowDrops(hazard === 'rim'), [hazard]);
  const [dzStats, setDzStats] = useState<{ moon: DropZoneStats | null; earth: DropZoneStats | null }>({ moon: null, earth: null });
  const onMoonDz = useCallback((st: DropZoneStats): void => setDzStats((o) => ({ ...o, moon: st })), []);
  const onEarthDz = useCallback((st: DropZoneStats): void => setDzStats((o) => ({ ...o, earth: st })), []);
  const dzScaleMax = Math.max(dzStats.moon?.fieldP99 ?? 0, dzStats.earth?.fieldP99 ?? 0);
  const [activeWindow, setActiveWindow] = useState<{ key: string; el: number; az: number } | null>(null);
  const [datesOpen, setDatesOpen] = useState<boolean>(false);
  const [autoKey, setAutoKey] = useState<string | null>(null);

  // A stale selection (e.g. a site from an older pipeline run kept in memory) falls back to this region × danger's
  // #1 match, so the 3D view never asks for a tile that no longer exists.
  useEffect((): void => {
    if (!region || !siteId || core.siteById.has(siteId)) return;
    const top = matchesFor(core, region.id, hazard).find((m: Match): boolean => core.siteById.has(m.site_id));
    setSite(top?.site_id ?? null);
  }, [core, region, hazard, siteId, setSite]);

  // Deep links (Earth matches, Walk) set a site; if it is a pick for another danger in this region, follow it.
  useEffect((): void => {
    if (!region || !siteId) return;
    if (matchesFor(core, region.id, hazard).some((m: Match): boolean => m.site_id === siteId)) return;
    const other = HAZARD_IDS.find((h: HazardId): boolean => matchesFor(core, region.id, h).some((m: Match): boolean => m.site_id === siteId));
    if (other) useApp.setState({ hazard: other });
  }, [core, region, hazard, siteId]);

  const choices = useMemo((): SiteChoice[] => {
    if (!region) return [];
    return matchesFor(core, region.id, hazard)
      .slice(0, 3)
      .flatMap((m: Match): SiteChoice[] => {
        const site = core.siteById.get(m.site_id);
        return site ? [{ site, match: m, place: sitePlace(site, m) }] : [];
      });
  }, [core, region, hazard]);

  const agreement = useMemo((): Record<string, number> => nasademAgreement(core.method?.file), [core]);
  const inChoices = choices.find((c: SiteChoice): boolean => c.site.id === siteId) ?? null;
  const walkSite = !inChoices && siteId ? (core.siteById.get(siteId) ?? null) : null;
  const extra: SiteChoice | null = walkSite ? { site: walkSite, match: null, place: sitePlace(walkSite, null) } : null;
  const current: SiteChoice | null = inChoices ?? extra ?? choices[0] ?? null;
  const site = current?.site ?? null;
  const match = current?.match ?? null;

  // "Show the 25 patches": the hazard's headline measure on one colour scale shared by both panes.
  const pair = useMemo((): PatchPair | null => (match ? patchPair(headlineLight(match)) : null), [match]);
  const moonPatches = useMemo(
    (): PatchLayerData | null =>
      showPatches && pair ? { values: pair.moon, unit: pair.unit, scaleMin: pair.scaleMin, scaleMax: pair.scaleMax, hazard } : null,
    [showPatches, pair, hazard],
  );
  const earthPatches = useMemo(
    (): PatchLayerData | null =>
      showPatches && pair ? { values: pair.earth, unit: pair.unit, scaleMin: pair.scaleMin, scaleMax: pair.scaleMax, hazard } : null,
    [showPatches, pair, hazard],
  );

  const moon = useTile(region?.tile ?? null, core.regionsOrigin);
  const earth = useTile(site?.tile ?? null, core.sitesOrigin);

  // Each rehearsal date's sun on both tiles: Earth at that date's sun, the Moon with the same height and direction
  // from its tile's top. The date whose figures are closest is the best date to rehearse.
  const windows: RehearsalWindow[] = match?.windows ?? NO_WINDOWS;
  const dirs = useMemo((): SunDir[] => (site ? windows.map((w: RehearsalWindow): SunDir => windowSun(site, w)) : []), [site, windows]);
  const earthTileHere = earth.tile && site && earth.tile.ref.path === site.tile.path ? earth.tile : null;
  const datePairs = useDateShares(moon.tile, earthTileHere, dirs);
  const fits = useMemo((): (DateFit | null)[] => datePairs.map((p: DatePair): DateFit | null => dateFit(p.moon, p.earth)), [datePairs]);
  const bestIdx = bestDateIndex(fits);
  const matchKey = site && match ? `${site.id}:${match.hazard}` : null;
  const stillListed = useSiteStillListed(site?.id ?? null, earth.error !== null, core.sitesOrigin);
  const ann = useAnnotations(region, core.regionsOrigin);
  const moonShare = useShadowShare(moon.tile, el, az);
  const earthShare = useShadowShare(earth.tile, el, az);
  const moonMask = useMaskTexture(moon.tile, mode, el, az, region?.shadow_masks ?? NO_MASKS, core.regionsOrigin);
  const earthMask = useMaskTexture(earth.tile, mode, el, az, NO_MASKS, core.sitesOrigin);
  const moonRim = useMemo((): RimSeg[] | null => (hazard === 'rim' ? moonRimSegs(ann, RIM_COUNT) : null), [hazard, ann]);
  const earthRim = useEarthRimSegs(earth.tile, hazard === 'rim', RIM_COUNT);
  // Annotation cells are in the Moon tile's pixel grid (Moon tiles are always full resolution).
  const tileSize = region?.tile.size ?? 500;
  const cellPx = ann?.texture ? ann.texture.cell_m / (ann.tile.res_m || region?.tile.res_m || 30) : 1000 / (region?.tile.res_m ?? 30);
  const moonCells = useCellTexture(hazard === 'texture', ann?.texture?.texture_empty_cells ?? null, tileSize, cellPx, TEXTURE_TINT);
  // Earth: the grid actually loaded (a deploy may serve the 60 m lite copy), not the site's JSON ref.
  const earthGridRef = earthTileHere?.ref ?? site?.tile ?? null;
  const earthCells = useCellTexture(
    hazard === 'texture',
    null,
    earthGridRef?.size ?? 500,
    1000 / (earthGridRef?.res_m ?? 30),
    TEXTURE_TINT,
  );

  const moonPath = useMemo((): [number, number][] | null => {
    if (!walk || !region || walk.regionId !== region.id) return null;
    const ref = region.tile;
    return walk.route.map(([x, y]: [number, number]): [number, number] => mapToPixel(x, y, ref.origin_x, ref.origin_y, ref.res_m));
  }, [walk, region]);
  const earthPath = useMemo((): [number, number][] | null => {
    const it = walk?.bestItem;
    if (!it || !site || it.site_id !== site.id || !earthTileHere) return null;
    // Pixel coords in the loaded grid (full 30 m or lite 60 m), which is what the mesh is built from.
    const ref = earthTileHere.ref;
    return [mapToPixel(it.x0, it.y0, ref.origin_x, ref.origin_y, ref.res_m), mapToPixel(it.x1, it.y1, ref.origin_x, ref.origin_y, ref.res_m)];
  }, [walk, site, earthTileHere]);

  // On load and whenever the match changes, light both panes with the best date (once; later picks are the user's).
  useEffect((): void => {
    if (!matchKey || bestIdx < 0 || autoKey === matchKey || sweeping) return;
    const d = dirs[bestIdx];
    if (!d) return;
    setSun(d.el, d.az);
    setActiveWindow({ key: `${matchKey}:${bestIdx}`, el: d.el, az: d.az });
    setAutoKey(matchKey);
  }, [matchKey, bestIdx, autoKey, sweeping, dirs, setSun]);

  if (!region || !site || !current) {
    return (
      <div className="t3">
        <p className="t3-note-empty">No Moon region or Earth site is available in the loaded data.</p>
      </div>
    );
  }

  const place = current.place;
  const verdictBase: Verdict | null = match ? buildVerdict(match, place.label, region.name, nScreened(core)) : null;
  const bestW = bestIdx >= 0 ? (windows[bestIdx] ?? null) : null;
  const bestFit = bestIdx >= 0 ? (fits[bestIdx] ?? null) : null;
  const ready = bestIdx >= 0;
  const closeDate = bestFit !== null && bestFit.gap <= CLOSE_GAP_PTS;
  // A shadow headline states the best date's figures, not the all-directions average the site was chosen on.
  const shadowHeadline = match ? /^shadow_frac_el\d+$/.test(verdictLight(match)?.metric ?? '') : false;
  const verdict: Verdict | null =
    verdictBase && shadowHeadline
      ? { ...verdictBase, stat: bestFit && bestW ? `${fitText(bestFit)} dark on ${shortDate(bestW)}` : '…' }
      : verdictBase;
  const realtime = mode === 'realtime';
  const extentOf = (size: number, res: number): number => {
    const v = size * res * TERRAIN_KM;
    return Number.isFinite(v) && v > 0 ? v : 15;
  };

  // Windows: geographic azimuth at the Earth site -> azimuth from the top of the (north-up) Earth tile.
  const winKey = (i: number): string => `${site.id}:${match?.hazard ?? ''}:${i}`;
  const activeIdx =
    activeWindow && Math.abs(activeWindow.el - el) < 0.01 && Math.abs(activeWindow.az - az) < 0.01
      ? windows.findIndex((_w: RehearsalWindow, i: number): boolean => winKey(i) === activeWindow.key)
      : -1;
  const pickWindow = (i: number): void => {
    const d = dirs[i];
    if (!d) return;
    sweep.stop();
    setSun(d.el, d.az);
    setActiveWindow({ key: winKey(i), el: d.el, az: d.az });
  };
  const activeW = activeIdx >= 0 ? windows[activeIdx] : null;
  const activeFit = activeIdx >= 0 ? (fits[activeIdx] ?? null) : null;

  // Per-hazard readouts. Live shadow shares are for the ONE sun shown (a date's sun, or a preset height).
  const elTxt = `${el.toFixed(el % 1 ? 1 : 0)}°`;
  let moonReadout: ReactNode;
  let earthReadout: ReactNode;
  let earthNote: ReactNode = null;
  let caption: ReactNode;
  if (hazard === 'rim') {
    const mTop = moonRim?.[0];
    const eTop = earthRim?.[0];
    moonReadout = (
      <Readout
        big={
          mTop ? (
            <>
              {Math.round(mTop.absDh)} m
            </>
          ) : ann ? (
            '–'
          ) : (
            '…'
          )
        }
        small="biggest 1 km height change"
      />
    );
    earthReadout = <Readout big={eTop ? `${Math.round(eTop.absDh)} m` : '…'} small="biggest 1 km height change" />;
    caption = (
      <>
        <span>
          <strong>Orange</strong> = 3 biggest 1 km height changes (dot = high end). Hakuto-R’s software rejected a drop like this as a
          sensor error.
        </span>
        <Term id="rimDrop" />
        <Why id="rimP95" />
      </>
    );
  } else if (hazard === 'texture') {
    const mEmpty = ann?.texture?.empty_frac ?? region.hazards.texture.metrics.empty_cell_frac_el3;
    const lightE = match?.lights.find((l: LightRow): boolean => l.metric === 'empty_cell_frac_el3');
    const eEmpty = lightE ? lightE.earth : siteMetric(site, 'empty_cell_frac_el3');
    moonReadout = <Readout big={typeof mEmpty === 'number' ? pct0(mEmpty) : '–'} small="of 1 km squares featureless (3° sun)" />;
    earthReadout = <Readout big={eEmpty !== null ? pct0(eEmpty) : '–'} small="of 1 km squares featureless (3° sun)" />;
    earthNote = <span title="Which Earth squares are empty isn’t mapped yet, so only the 1 km grid is drawn here.">Pipeline figure · grid only</span>;
    caption = (
      <>
        <span>
          <strong>Pink</strong> = squares with nothing for a camera to track (what tripped up Ingenuity). Darker = worse.
        </span>
        <Term id="cameraTexture" />
        <Why id="texture" />
      </>
    );
  } else {
    moonReadout = <Readout big={shareBig(moonShare)} small={activeW ? `${shortDate(activeW)} sun · ${elTxt}` : `at a ${elTxt} sun`} />;
    earthReadout = <Readout big={shareBig(earthShare)} small="same sun" />;
    caption = (
      <>
        <span>
          <strong>Black</strong> = real shadow, like the long low-sun shadows IM-2 faced.
        </span>
        <Term id="shadowShare" />
        <Why id="shadowFar" />
      </>
    );
  }

  // When to go: the best date, chips beside the sun presets, and the full list on demand.
  const insight = lowSunInsight(windows, site);
  const chips = chipIndices(fits, ready);
  const anyLow = chips.some((i: number): boolean => lowSunWindow(windows[i]));
  const openDates = (): void => {
    setDatesOpen(true);
    window.requestAnimationFrame((): void =>
      document.getElementById('t3-all-dates')?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      }),
    );
  };
  const earthError =
    earth.error && stillListed === false ? (
      <>
        This page’s data is older than the files on disk (this site was replaced by a newer run).{' '}
        <button type="button" className="link-btn" onClick={(): void => window.location.reload()}>
          Reload
        </button>
      </>
    ) : (
      earth.error
    );

  return (
    <div className="t3">
      <div className="t3-kicker">
        <span>3D side by side</span>
        {core.setOrigin === 'mock' && <SampleChip what="Earth sites" />}
      </div>

      <Pickers core={core} region={region} hazard={hazard} choices={choices} extra={extra} selectedId={site.id} />

      <div className="t3-verdict" data-hz={hazard}>
        <HazardGlyph hazard={hazard} size={24} />
        {verdict ? (
          <h1 title={verdict.rank ?? undefined}>
            {verdict.lead}: <span className="t3-verdict-stat">{verdict.stat}</span>
          </h1>
        ) : (
          <h1>{place.label} came from your drawn walk, not a top-3 pick; the views still compare the terrain.</h1>
        )}
      </div>

      {match && (
        <div className="t3-when">
          {windows.length === 0 ? (
            <p className="t3-when-line">No low-sun window here in the next year (e.g. polar night).</p>
          ) : (
            <div className="t3-when-line why-row" role="status">
              <SunGlyph size={14} />
              {!ready || !bestW || !bestFit ? (
                <span>
                  <strong>
                    <Term id="rehearsalWindow">Best date to see this on site:</Term>
                  </strong>{' '}
                  …
                </span>
              ) : closeDate ? (
                <span>
                  <strong>
                    <Term id="rehearsalWindow">Best date to see this on site:</Term>
                  </strong>{' '}
                  {shortDate(bestW)}, {windowStart(bestW)} · sun {bestW.sun_el.toFixed(1)}°
                  {windowMinutes(bestW) !== null ? ` · ~${fmtMinutes(windowMinutes(bestW) ?? 0)}` : ''}
                </span>
              ) : (
                <span>
                  No date reproduces the Moon’s shadow closely here — closest: {shortDate(bestW)} ({fitText(bestFit)})
                </span>
              )}
              {bestW && lowSunWindow(bestW) && (
                <span className="flag-note">
                  below 1° <Why id="refraction" />
                </span>
              )}
              <InfoTip label="Why this date?" title="One day, one sun direction">
                <p>
                  We chose this site on shadow averaged over all sun directions, because the Moon’s polar sun circles the horizon. A rehearsal
                  happens on one day, so we pick the date whose sun direction matches best.
                </p>
                {insight && <p>{insight}</p>}
              </InfoTip>
              {windows.length > 1 && (
                <button type="button" className="link-btn t3-when-more" aria-controls="t3-all-dates" onClick={openDates}>
                  +{windows.length - 1} {windows.length - 1 === 1 ? 'date' : 'dates'} ▾
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="t3-sunbar">
        <div className="t3-sunbar-main">
          <span className="t3-pick-label why-row" id="t3-sun-label">
            <SunGlyph /> Moon-like low sun
          </span>
          <div className="t3-sun-presets" role="group" aria-labelledby="t3-sun-label">
            {SUN_PRESETS.map((v: number) => (
              <button
                key={v}
                type="button"
                aria-pressed={Math.abs(el - v) < 0.01}
                onClick={(): void => {
                  setSun(v, az);
                }}
              >
                {v}°
              </button>
            ))}
          </div>
          {windows.length > 0 && (
            <div className="t3-sun-presets t3-sun-dates" role="group" aria-label="Light both views with the sun of a rehearsal date at the Earth site">
              <span className="t3-sun-dates-label">Dates:</span>
              {chips.map((i: number) => {
                const w = windows[i];
                const fit = fits[i] ?? null;
                return (
                  <button
                    key={`${w.start_utc}-${i}`}
                    type="button"
                    className="t3-date-chip"
                    aria-pressed={activeIdx === i}
                    data-low={lowSunWindow(w) || undefined}
                    data-best={i === bestIdx || undefined}
                    onClick={(): void => pickWindow(i)}
                  >
                    {shortDate(w)}
                    {i === bestIdx ? ' ★' : ''}
                    {lowSunWindow(w) ? ' *' : ''}
                    <span className="t3-date-tip">{fit ? `${fitText(fit)} dark` : '…'}</span>
                  </button>
                );
              })}
              {windows.length > chips.length && (
                <button type="button" onClick={openDates} aria-controls="t3-all-dates">
                  …
                </button>
              )}
            </div>
          )}
          {anyLow && (
            <span className="flag-note">
              * below 1° <Why id="refraction" />
            </span>
          )}
          <div className="t3-sweep-ctl" role="group" aria-label="Sun sweep">
            {!sweeping ? (
              <button
                type="button"
                className="btn btn-primary t3-sweep"
                onClick={sweep.start}
                title={sweepMode === 'marks' ? 'Steps the sun once round 8 compass directions, pausing at each' : 'Turns the sun once round'}
              >
                <SunGlyph />
                Sweep the sun
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="btn t3-sweep t3-sweep-pause"
                  onClick={sweep.state.phase === 'paused' ? sweep.resume : sweep.pause}
                >
                  <SunGlyph />
                  {sweep.state.phase === 'paused' ? 'Resume' : 'Pause'}
                </button>
                <button type="button" className="btn t3-sweep-stop" onClick={sweep.stop}>
                  Stop
                </button>
              </>
            )}
          </div>
          <InfoTip label="Where is the sun in the views?" title="The gold disc is the sun" align="end">
            <p>
              It sits on the true sun angle ({elTxt} now) above a horizon ring with ticks every 45°; the dashed line is the light’s path.
              Shadows fall away from it.
            </p>
            <p>
              Sun direction is relative to the tile’s top: the map grid on the Moon, north on Earth (now {Math.round(az) % 360}°, from the{' '}
              {compass(az)} of the tile).
            </p>
          </InfoTip>
        </div>
        <SweepNow sweep={sweep} el={el} az={az} moon={moonShare} earth={earthShare} />
        <details className="t3-more">
          <summary>More options</summary>
          <div className="t3-more-body">
            <div className="t3-ctl">
              <label htmlFor="t3-el" className="t3-ctl-label">
                <span>
                  <SunGlyph size={14} /> Sun height
                </span>
                <span className="t3-ctl-value">{el.toFixed(1)}°</span>
              </label>
              <input
                id="t3-el"
                className="range range-sun"
                type="range"
                min={0.5}
                max={30}
                step={0.5}
                value={el}
                onChange={(e): void => setSun(Number(e.target.value), az)}
              />
            </div>
            <div className="t3-ctl">
              <label htmlFor="t3-az" className="t3-ctl-label">
                <span>
                  <SunGlyph size={14} /> Sun direction (from tile top)
                </span>
                <span className="t3-ctl-value">{Math.round(az) % 360}°</span>
              </label>
              <input
                id="t3-az"
                className="range range-sun"
                type="range"
                min={0}
                max={359}
                step={1}
                value={Math.round(az) % 360}
                onChange={(e): void => {
                  sweep.stop();
                  setSun(el, Number(e.target.value));
                }}
              />
            </div>
            <div className="t3-ctl">
              <label htmlFor="t3-exag" className="t3-ctl-label">
                <span>Vertical exaggeration</span>
                <span className="t3-ctl-value">{exag.toFixed(1)}×</span>
              </label>
              <input
                id="t3-exag"
                className="range"
                type="range"
                min={1}
                max={6}
                step={0.5}
                value={exag}
                onChange={(e): void => setExag(Number(e.target.value))}
              />
            </div>
            <div className="t3-ctl">
              <span className="t3-ctl-label" id="t3-mode-label">
                Shadow drawing
              </span>
              <div className="seg" role="group" aria-labelledby="t3-mode-label">
                <button type="button" aria-pressed={realtime} onClick={(): void => setMode('realtime')}>
                  Live (graphics card)
                </button>
                <button type="button" aria-pressed={!realtime} onClick={(): void => setMode('precomputed')}>
                  Reference masks
                </button>
              </div>
            </div>
            <div className="t3-ctl">
              <span className="t3-ctl-label" id="t3-sweep-label">
                <span>
                  <SunGlyph size={14} /> Sweep style
                </span>
              </span>
              <div className="seg" role="group" aria-labelledby="t3-sweep-label">
                <button
                  type="button"
                  aria-pressed={sweepMode === 'smooth'}
                  title="One continuous turn; the dark figures refresh up to 4 times a second. With reduced motion this steps instead."
                  onClick={(): void => {
                    sweep.stop();
                    setSweepMode('smooth');
                  }}
                >
                  Smooth
                </button>
                <button
                  type="button"
                  aria-pressed={sweepMode === 'marks'}
                  title="Steps the sun once round 8 compass directions, pausing at each"
                  onClick={(): void => {
                    sweep.stop();
                    setSweepMode('marks');
                  }}
                >
                  Step through 8 directions
                </button>
              </div>
            </div>
          </div>
        </details>
      </div>

      <div className="t3-twin">
        <Pane
          id="moon"
          world="Moon"
          name={region.name}
          sub="NASA LOLA · 15 × 15 km"
          upNote="up = grid, not north"
          tile={moon.tile}
          error={moon.error}
          extentKm={extentOf(region.tile.size, region.tile.res_m)}
          exag={exag}
          el={el}
          az={az}
          realtime={realtime}
          lift={lift}
          shadeMap={moonMask.texture}
          cellMap={moonCells}
          rim={showDrops ? null : moonRim}
          path={moonPath}
          readout={moonReadout}
          note={!realtime && moonMask.note ? `Shadows: ${moonMask.note}` : null}
          patches={moonPatches}
          dropZones={{ visible: showDrops, scaleMax: dzScaleMax, onStats: onMoonDz }}
        />
        <Pane
          id="earth"
          world="Earth"
          name={place.label}
          nameTitle={place.title}
          sub={`${place.region ? `${place.region} · ` : ''}15 × 15 km`}
          upNote="up = north"
          tile={earth.tile}
          error={earthError}
          extentKm={extentOf(site.tile.size, site.tile.res_m)}
          exag={exag}
          el={el}
          az={az}
          realtime={realtime}
          lift={lift}
          shadeMap={earthMask.texture}
          cellMap={earthCells}
          rim={hazard === 'rim' && !showDrops ? earthRim : null}
          path={earthPath}
          readout={earthReadout}
          note={earthNote ?? (!realtime && earthMask.note ? `Shadows: ${earthMask.note}` : null)}
          patches={earthPatches}
          dropZones={{ visible: showDrops, scaleMax: dzScaleMax, onStats: onEarthDz }}
        />
      </div>

      <div className="t3-caption">
        <div className="t3-caption-lines">
          <div className="why-row t3-caption-row">{caption}</div>
          {walk && walk.regionId === region.id && <p className="t3-caption-dark">White line = your drawn walk.</p>}
          {showPatches && pair && (
            <div className="t3-patch-key">
              <span>
                <strong>25 patches of 3 km</strong> · {pair.label}, same scale on both:
              </span>
              <PatchLegend scaleMin={pair.scaleMin} scaleMax={pair.scaleMax} unit={pair.unit} hazard={hazard} />
            </div>
          )}
          {showDrops && dzScaleMax > 0 && <DropZoneLegend scaleMax={dzScaleMax} />}
        </div>
        <div className="t3-toggles">
          <label className="check t3-lift">
            <input type="checkbox" checked={showDrops} onChange={(e): void => setShowDrops(e.target.checked)} />
            Show big-drop zones
          </label>
          <label className="check t3-lift" title={pair ? undefined : 'No patch values for this site'}>
            <input type="checkbox" checked={showPatches && pair !== null} disabled={!pair} onChange={(e): void => setShowPatches(e.target.checked)} />
            Show the 25 patches
          </label>
          <label className="check t3-lift">
            <input type="checkbox" checked={lift} onChange={(e): void => setLift(e.target.checked)} />
            See into shadows
          </label>
        </div>
      </div>
      {activeW && (
        <div className="t3-window-note why-row">
          <SunGlyph size={14} />
          <span>
            Sun of {windowDate(activeW)} on site: {activeW.sun_el.toFixed(1)}°, from {Math.round(activeW.sun_az)}° (north = 0°). The Moon view
            uses the same angle from its tile’s top.
            {hazard !== 'shadow' && activeFit ? ` ${fitText(activeFit)} dark.` : ''}
          </span>
          {lowSunWindow(activeW) && (
            <span className="flag-note">
              below 1° <Why id="refraction" />
            </span>
          )}
        </div>
      )}
      <details className="t3-more t3-drawn">
        <summary>How this is drawn</summary>
        <div className="t3-drawn-body">
          <p>
            Same 15 km area, same scale, same sun. Drag one view and the other follows. Heights are exaggerated so the shape is easy to see,
            but the shadows still fall where they would on the real ground.
          </p>
          <p className="t3-fine">
            {earthTileHere?.lite
              ? `The Moon view uses a 30 m grid; this online copy draws the Earth view from a ${Math.round(earthTileHere.ref.res_m)} m copy of the 30 m data (the full tiles are too big to host). `
              : 'Both views use a 30 m grid. '}
            The dark percentages are worked out in your browser from true heights in 90 m steps, for the one sun
            direction shown. Pink squares are 1 km squares with no camera
            landmark at a 3° sun from at least half of 8 sun directions. Orange lines come from a scan of every point in 16 directions, with
            picks at least 1.5 km apart.
          </p>
          <p className="t3-fine">
            The sun: because heights are exaggerated ×{exag.toFixed(1)}, the light is raised to atan({exag.toFixed(1)} × tan(sun height)) so
            shadows keep their true lengths. The gold disc is drawn at the true sun height, on exactly the same direction as the light, so
            shadows always fall straight away from it. At 1× the two angles are the same.
          </p>
        </div>
      </details>

      {match && (
        <>
          <EvidenceTable match={match} region={region} placeLabel={place.label} agreement={agreement} />
          <NotesBoxes match={match} />
          <WindowsList
            windows={windows}
            placeLabel={place.label}
            activeIndex={activeIdx >= 0 ? activeIdx : null}
            fits={fits}
            bestIndex={bestIdx}
            onPick={pickWindow}
            open={datesOpen}
            onOpenChange={setDatesOpen}
          />
        </>
      )}
    </div>
  );
}
