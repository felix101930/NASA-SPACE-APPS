import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { HazardGlyph, SunGlyph } from '../components/Glyphs';
import { SampleChip } from '../components/ScreenHead';
import { TERRAIN_KM } from '../components/terrainGeometry';
import { mapToPixel } from '../lib/terrain';
import { matchesFor, useApp, useRegion, type CoreData } from '../store';
import { HAZARD_IDS, type EarthSite, type HazardId, type LightRow, type Match, type Region, type RehearsalWindow, type ShadowMask } from '../types/contract';
import { buildVerdict, compass, HAZARD_TAB, pct0, type Verdict } from './terrain3d/copy';
import {
  moonRimSegs,
  useAnnotations,
  useCellTexture,
  useEarthRimSegs,
  useMaskTexture,
  useShadowShare,
  useTile,
  type RimSeg,
  type ShadowShare,
} from './terrain3d/data';
import { EvidenceTable, NotesBoxes, WindowsList } from './terrain3d/Evidence';
import { placeName, type PlaceName } from './terrain3d/places';
import { Pane } from './terrain3d/Scene';
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
  return placeName(name, site.country, site.lat, site.lon);
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

function siteMetric(site: EarthSite, key: string): number | null {
  const v = site.metrics[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function nScreened(core: CoreData): number | null {
  const n = core.method?.file.screen.n_screened;
  return typeof n === 'number' && n > 0 ? n : null;
}

function useSunSweep(): { sweeping: boolean; start: () => void; stop: () => void } {
  const [sweeping, setSweeping] = useState<boolean>(false);
  useEffect((): (() => void) | void => {
    if (!sweeping) return;
    const startAz = useApp.getState().sunAz;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      // No continuous motion: step the sun round in 30° jumps instead.
      let k = 0;
      const id = window.setInterval((): void => {
        k += 1;
        const s2 = useApp.getState();
        s2.setSun(s2.sunEl, (startAz + k * 30) % 360);
        if (k >= 12) setSweeping(false);
      }, 700);
      return (): void => window.clearInterval(id);
    }
    const DUR = 10000;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number): void => {
      const p = Math.min(1, (now - t0) / DUR);
      const eased = 0.5 - 0.5 * Math.cos(Math.PI * p);
      const s2 = useApp.getState();
      s2.setSun(s2.sunEl, Math.round(((startAz + 360 * eased) % 360) * 10) / 10);
      if (p < 1) raf = requestAnimationFrame(tick);
      else setSweeping(false);
    };
    raf = requestAnimationFrame(tick);
    return (): void => cancelAnimationFrame(raf);
  }, [sweeping]);
  return { sweeping, start: (): void => setSweeping(true), stop: (): void => setSweeping(false) };
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
        <label className="t3-pick">
          <span className="t3-pick-label">Moon region</span>
          <select className="select" value={region.id} onChange={(e): void => setRegion(e.target.value)}>
            {core.regions.map((r: Region) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
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
                <span className="t3-hz-mission">{HAZARD_TAB[h].mission}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="t3-pick t3-pick-earth">
        <span className="t3-pick-label" id="t3-earth-label">
          Earth stand-ins for this danger
          <span className="t3-pick-hint">{n ? ` · best 3 of ${n.toLocaleString('en-US')} squares screened` : ' · best 3'}</span>
        </span>
        <div className="t3-chips" role="group" aria-labelledby="t3-earth-label">
          {choices.length === 0 && <p className="t3-note-empty">No Earth matches for this region and danger in matches.json.</p>}
          {choices.map((c: SiteChoice) => (
            <button
              key={c.site.id}
              type="button"
              className="t3-chip"
              aria-pressed={c.site.id === selectedId}
              title={c.place.title}
              onClick={(): void => setSite(c.site.id)}
            >
              <span className="t3-chip-rank">#{c.match?.rank ?? '–'}</span>
              <span className="t3-chip-text">
                <span className="t3-chip-name">{c.place.label}</span>
                <span className="t3-chip-sub">{c.place.sub ?? 'remote site · hover for exact spot'}</span>
              </span>
            </button>
          ))}
          {extra && (
            <button type="button" className="t3-chip t3-chip-extra" aria-pressed title={extra.place.title}>
              <span className="t3-chip-rank">Walk</span>
              <span className="t3-chip-text">
                <span className="t3-chip-name">{extra.place.label}</span>
                <span className="t3-chip-sub">from your drawn walk, not a top-3 pick</span>
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
  const mode = useApp((s) => s.shadowMode);
  const setMode = useApp((s) => s.setShadowMode);
  const walk = useApp((s) => s.walk);
  const sweep = useSunSweep();
  const [lift, setLift] = useState<boolean>(false);
  const [activeWindow, setActiveWindow] = useState<{ key: string; el: number; az: number } | null>(null);

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

  const inChoices = choices.find((c: SiteChoice): boolean => c.site.id === siteId) ?? null;
  const walkSite = !inChoices && siteId ? (core.siteById.get(siteId) ?? null) : null;
  const extra: SiteChoice | null = walkSite ? { site: walkSite, match: null, place: sitePlace(walkSite, null) } : null;
  const current: SiteChoice | null = inChoices ?? extra ?? choices[0] ?? null;
  const site = current?.site ?? null;
  const match = current?.match ?? null;

  const moon = useTile(region?.tile ?? null, core.regionsOrigin);
  const earth = useTile(site?.tile ?? null, core.sitesOrigin);
  const ann = useAnnotations(region, core.regionsOrigin);
  const moonShare = useShadowShare(moon.tile, el, az);
  const earthShare = useShadowShare(earth.tile, el, az);
  const moonMask = useMaskTexture(moon.tile, mode, el, az, region?.shadow_masks ?? NO_MASKS, core.regionsOrigin);
  const earthMask = useMaskTexture(earth.tile, mode, el, az, NO_MASKS, core.sitesOrigin);
  const moonRim = useMemo((): RimSeg[] | null => (hazard === 'rim' ? moonRimSegs(ann, RIM_COUNT) : null), [hazard, ann]);
  const earthRim = useEarthRimSegs(earth.tile, hazard === 'rim', RIM_COUNT);
  const tileSize = region?.tile.size ?? 500;
  const cellPx = ann?.texture ? ann.texture.cell_m / (ann.tile.res_m || 30) : 1000 / 30;
  const moonCells = useCellTexture(hazard === 'texture', ann?.texture?.texture_empty_cells ?? null, tileSize, cellPx, TEXTURE_TINT);
  const earthCells = useCellTexture(hazard === 'texture', null, site?.tile.size ?? 500, 1000 / (site?.tile.res_m ?? 30), TEXTURE_TINT);

  const moonPath = useMemo((): [number, number][] | null => {
    if (!walk || !region || walk.regionId !== region.id) return null;
    const ref = region.tile;
    return walk.route.map(([x, y]: [number, number]): [number, number] => mapToPixel(x, y, ref.origin_x, ref.origin_y, ref.res_m));
  }, [walk, region]);
  const earthPath = useMemo((): [number, number][] | null => {
    const it = walk?.bestItem;
    if (!it || !site || it.site_id !== site.id) return null;
    const ref = site.tile;
    return [mapToPixel(it.x0, it.y0, ref.origin_x, ref.origin_y, ref.res_m), mapToPixel(it.x1, it.y1, ref.origin_x, ref.origin_y, ref.res_m)];
  }, [walk, site]);

  if (!region || !site || !current) {
    return (
      <div className="t3">
        <p className="t3-note-empty">No Moon region or Earth site is available in the loaded data.</p>
      </div>
    );
  }

  const place = current.place;
  const verdict: Verdict | null = match ? buildVerdict(match, place.label, region.name, nScreened(core)) : null;
  const realtime = mode === 'realtime';
  const extentOf = (size: number, res: number): number => {
    const v = size * res * TERRAIN_KM;
    return Number.isFinite(v) && v > 0 ? v : 15;
  };

  // Windows: geographic azimuth at the Earth site -> azimuth from the top of the (north-up) Earth tile.
  const windows: RehearsalWindow[] = match?.windows ?? [];
  const winKey = (i: number): string => `${site.id}:${match?.hazard ?? ''}:${i}`;
  const activeIdx =
    activeWindow && Math.abs(activeWindow.el - el) < 0.01 && Math.abs(activeWindow.az - az) < 0.01
      ? windows.findIndex((_w: RehearsalWindow, i: number): boolean => winKey(i) === activeWindow.key)
      : -1;
  const pickWindow = (i: number): void => {
    const w = windows[i];
    if (!w) return;
    sweep.stop();
    const gAz = Math.round(gridAzFor(site, w.sun_az) * 10) / 10;
    const gEl = Math.round(Math.min(30, Math.max(0.5, w.sun_el)) * 10) / 10;
    setSun(gEl, gAz);
    setActiveWindow({ key: winKey(i), el: gEl, az: gAz });
  };
  const activeW = activeIdx >= 0 ? windows[activeIdx] : null;

  // Per-hazard readouts and captions.
  const elTxt = `${el.toFixed(el % 1 ? 1 : 0)}°`;
  const sunFrom = `from the ${compass(az)} of the tile`;
  let moonReadout: ReactNode;
  let earthReadout: ReactNode;
  let earthNote: ReactNode = null;
  let caption: ReactNode;
  if (hazard === 'rim') {
    const mTop = moonRim?.[0];
    const eTop = earthRim?.[0];
    moonReadout = <Readout big={mTop ? `${Math.round(mTop.absDh)} m` : ann ? '–' : '…'} small="biggest height change over 1 km" />;
    earthReadout = <Readout big={eTop ? `${Math.round(eTop.absDh)} m` : '…'} small="biggest height change over 1 km" />;
    caption = (
      <>
        <strong>Orange lines:</strong> the three biggest height changes over 1 km on each tile, found with the same scan (every point, 16
        directions, picks at least 1.5 km apart). The dot marks the high end. A drop like this is what Hakuto-R’s software rejected as sensor
        error.
      </>
    );
  } else if (hazard === 'texture') {
    const mEmpty = ann?.texture?.empty_frac ?? region.hazards.texture.metrics.empty_cell_frac_el3;
    const lightE = match?.lights.find((l: LightRow): boolean => l.metric === 'empty_cell_frac_el3');
    const eEmpty = lightE ? lightE.earth : siteMetric(site, 'empty_cell_frac_el3');
    moonReadout = <Readout big={typeof mEmpty === 'number' ? pct0(mEmpty) : '–'} small="of 1 km squares featureless at a 3° sun" />;
    earthReadout = <Readout big={eEmpty !== null ? pct0(eEmpty) : '–'} small="of 1 km squares featureless at a 3° sun" />;
    earthNote = <>Pipeline figure. Which Earth squares are empty isn’t mapped yet, so only the 1 km grid is drawn here.</>;
    caption = (
      <>
        <strong>Pink squares on the Moon:</strong> 1 km squares where a camera finds no landmark at a 3° sun from at least half of 8 sun
        directions; stronger pink means empty from more of them. Too little surface texture is what left Ingenuity’s navigation with too little to work with.
      </>
    );
  } else {
    moonReadout = <Readout big={shareBig(moonShare)} small={`at a ${elTxt} sun`} />;
    earthReadout = <Readout big={shareBig(earthShare)} small={`at the same ${elTxt} sun`} />;
    caption = (
      <>
        <strong>
          {moonShare ? `${pct0(moonShare.frac)} of ${region.name} is dark at a ${elTxt} sun` : `Measuring the shadow at a ${elTxt} sun…`}
        </strong>
        {moonShare ? ' — long low-sun shadows like these are a danger IM-2 faced. ' : ' '}
        {earthShare ? `Under the same sun, ${pct0(earthShare.frac)} of ${place.label} is dark.` : ''}
      </>
    );
  }
  const darkNote =
    hazard === 'shadow'
      ? null
      : moonShare
        ? `Black ground is real shadow: at this ${elTxt} sun ${pct0(moonShare.frac)} of ${region.name} gets no direct light.`
        : null;

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
          <h1>
            {verdict.lead}: <span className="t3-verdict-stat">{verdict.stat}</span>
            {verdict.rank && <span className="t3-verdict-rank"> — {verdict.rank}</span>}
          </h1>
        ) : (
          <h1>
            {place.label} came from your drawn walk. It isn’t one of the top-3 Earth picks for {region.name}, so there is no match to explain;
            the 3D views still compare the terrain.
          </h1>
        )}
      </div>

      <div className="t3-sunbar">
        <div className="t3-sunbar-main">
          <span className="t3-pick-label" id="t3-sun-label">
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
          <button type="button" className="btn btn-primary t3-sweep" aria-pressed={sweep.sweeping} onClick={sweep.sweeping ? sweep.stop : sweep.start}>
            <SunGlyph />
            {sweep.sweeping ? 'Stop the sweep' : 'Sweep the sun'}
          </button>
          <span className="t3-sun-now">
            Sun {elTxt} high, {sunFrom}
          </span>
        </div>
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
          </div>
        </details>
      </div>

      <div className="t3-twin">
        <Pane
          id="moon"
          world="Moon"
          name={region.name}
          sub="NASA LOLA heights · 15 × 15 km"
          upNote="up = map grid, not north"
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
          rim={moonRim}
          path={moonPath}
          readout={moonReadout}
          note={!realtime && moonMask.note ? `Shadows: ${moonMask.note}` : null}
        />
        <Pane
          id="earth"
          world="Earth"
          name={place.label}
          nameTitle={place.title}
          sub={`${place.sub ? `${place.sub} · ` : ''}30 m heights · 15 × 15 km`}
          upNote="up = north"
          tile={earth.tile}
          error={earth.error}
          extentKm={extentOf(site.tile.size, site.tile.res_m)}
          exag={exag}
          el={el}
          az={az}
          realtime={realtime}
          lift={lift}
          shadeMap={earthMask.texture}
          cellMap={earthCells}
          rim={hazard === 'rim' ? earthRim : null}
          path={earthPath}
          readout={earthReadout}
          note={earthNote ?? (!realtime && earthMask.note ? `Shadows: ${earthMask.note}` : null)}
        />
      </div>

      <div className="t3-caption">
        <p>
          {caption}
          {darkNote ? <span className="t3-caption-dark"> {darkNote}</span> : null}
        </p>
        <label className="check t3-lift">
          <input type="checkbox" checked={lift} onChange={(e): void => setLift(e.target.checked)} />
          Show terrain in shadow
        </label>
      </div>
      {activeW && (
        <p className="t3-window-note">
          <SunGlyph size={14} /> Lit with the sun of {activeW.start_utc.slice(0, 10)}: {activeW.sun_el.toFixed(1)}° high, from the{' '}
          {compass(activeW.sun_az)} ({Math.round(activeW.sun_az)}° from north) — the sun direction as seen at the Earth site. The Moon view
          uses the same direction measured from the top of its tile.
        </p>
      )}
      <p className="t3-fine">
        Same scale on both: 15 × 15 km, 30 m grid, the same vertical exaggeration and one sun. Drag either view; the other follows. The dark
        percentages are worked out in your browser from true heights (90 m steps). Heights are drawn exaggerated, so the 3D sun is raised by
        the same factor: shadows cover the same ground they would on the real terrain.
        {walk && walk.regionId === region.id ? ' The white line is your drawn walk.' : ''}
      </p>

      {match && (
        <>
          <EvidenceTable match={match} regionName={region.name} placeLabel={place.label} />
          <NotesBoxes match={match} />
          <WindowsList windows={windows.slice(0, 6)} placeLabel={place.label} activeIndex={activeIdx >= 0 ? activeIdx : null} onPick={pickWindow} />
        </>
      )}
    </div>
  );
}
