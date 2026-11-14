// Sun sweep for the 3D views.
//
// Default ("marks"): the sun steps once round the reference directions (e.g. the 8 compass marks), gliding briefly to
// each and holding there long enough to read the shadow figure, then stops. "smooth" turns it continuously once.
// With prefers-reduced-motion the sun jumps between marks (no glide), and smooth falls back to marks.
//
// The driver is a time-based timeline in refs: React state changes only when the current mark or phase changes,
// so holds cost nothing and the screen is not re-rendered by the loop itself. The caller's setter runs per frame
// only while gliding (≤ glideMs per mark) or in smooth mode.
import { useCallback, useEffect, useRef, useState } from 'react';

export type SweepMode = 'marks' | 'smooth';
export type SweepPhase = 'idle' | 'running' | 'paused';

export interface SweepState {
  phase: SweepPhase;
  /** Index into the visit order (0-based) of the mark being shown, or null in smooth mode / when idle. */
  step: number | null;
  /** Azimuth of the current mark (degrees), or null. */
  markAz: number | null;
  /** True once the sun has arrived at the current mark (the hold has started). */
  arrived: boolean;
  /** Number of marks visited in one sweep. */
  total: number;
}

export interface SweepOptions {
  /** Reference azimuths in degrees, in clockwise order. */
  marks: readonly number[];
  mode: SweepMode;
  /** Reads the current azimuth when the sweep starts. */
  getAz: () => number;
  /** Applies an azimuth (degrees, 0–360). */
  setAz: (az: number) => void;
  /** Hold at each mark (ms). */
  holdMs?: number;
  /** Glide between marks (ms); 0 = jump. Forced to 0 with reduced motion. */
  glideMs?: number;
  /** One smooth turn (ms). */
  smoothMs?: number;
}

export interface SunSweep {
  state: SweepState;
  start: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

const IDLE: SweepState = { phase: 'idle', step: null, markAz: null, arrived: false, total: 0 };
const norm = (a: number): number => ((a % 360) + 360) % 360;

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

interface Plan {
  mode: SweepMode;
  from: number;
  order: number[];
  hold: number;
  glide: number;
  smooth: number;
  total: number;
}

interface Frame {
  az: number;
  step: number | null;
  arrived: boolean;
  done: boolean;
}

/** Where the sun is `t` ms into the sweep. */
function frameAt(p: Plan, t: number): Frame {
  if (p.mode === 'smooth') {
    if (t >= p.smooth) return { az: norm(p.from + 360), step: null, arrived: false, done: true };
    const x = t / p.smooth;
    const eased = 0.5 - 0.5 * Math.cos(Math.PI * x);
    return { az: Math.round(norm(p.from + 360 * eased) * 10) / 10, step: null, arrived: false, done: false };
  }
  const seg = p.glide + p.hold;
  const n = p.order.length;
  if (t >= seg * n) return { az: p.order[n - 1], step: n - 1, arrived: true, done: true };
  const k = Math.floor(t / seg);
  const within = t - k * seg;
  const to = p.order[k];
  if (within >= p.glide) return { az: to, step: k, arrived: true, done: false };
  const prev = k === 0 ? p.from : p.order[k - 1];
  // Shortest way round (the first glide may go either way; later ones always go clockwise by one mark).
  let d = norm(to - prev);
  if (d > 180) d -= 360;
  const x = within / p.glide;
  const eased = 1 - Math.pow(1 - x, 3);
  return { az: Math.round(norm(prev + d * eased) * 10) / 10, step: k, arrived: false, done: false };
}

export function useSunSweep(opts: SweepOptions): SunSweep {
  const [state, setState] = useState<SweepState>(IDLE);
  const optsRef = useRef<SweepOptions>(opts);
  optsRef.current = opts;
  const plan = useRef<Plan | null>(null);
  const raf = useRef<number>(0);
  const t0 = useRef<number>(0);
  const elapsed = useRef<number>(0);
  const lastAz = useRef<number | null>(null);
  const lastKey = useRef<string>('');

  const cancel = (): void => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  };

  const publish = useCallback((p: Plan, f: Frame, phase: SweepPhase): void => {
    const key = `${phase}:${f.step}:${f.arrived}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setState({
      phase,
      step: f.step,
      markAz: f.step !== null ? p.order[f.step] : null,
      arrived: f.arrived,
      total: p.mode === 'marks' ? p.order.length : 0,
    });
  }, []);

  const tick = useCallback(
    (now: number): void => {
      const p = plan.current;
      if (!p) return;
      const t = now - t0.current;
      const f = frameAt(p, t);
      if (f.az !== lastAz.current) {
        lastAz.current = f.az;
        optsRef.current.setAz(f.az);
      }
      if (f.done) {
        plan.current = null;
        raf.current = 0;
        lastKey.current = '';
        setState(IDLE);
        return;
      }
      publish(p, f, 'running');
      raf.current = requestAnimationFrame(tick);
    },
    [publish],
  );

  const start = useCallback((): void => {
    cancel();
    const o = optsRef.current;
    const reduce = reducedMotion();
    const mode: SweepMode = o.mode === 'smooth' && !reduce ? 'smooth' : 'marks';
    const from = norm(o.getAz());
    const marks = [...o.marks].map(norm);
    if (mode === 'marks' && marks.length === 0) return;
    // Visit order: the nearest mark first, then clockwise once round.
    let near = 0;
    marks.forEach((m: number, i: number): void => {
      const d = Math.min(norm(m - from), norm(from - m));
      const dn = Math.min(norm(marks[near] - from), norm(from - marks[near]));
      if (d < dn) near = i;
    });
    const order = marks.map((_m: number, i: number): number => marks[(near + i) % marks.length]);
    plan.current = {
      mode,
      from,
      order,
      hold: o.holdMs ?? 1200,
      glide: reduce ? 0 : (o.glideMs ?? 450),
      smooth: o.smoothMs ?? 12000,
      total: order.length,
    };
    lastAz.current = null;
    lastKey.current = '';
    elapsed.current = 0;
    t0.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  const pause = useCallback((): void => {
    const p = plan.current;
    if (!p || !raf.current) return;
    cancel();
    elapsed.current = performance.now() - t0.current;
    const f = frameAt(p, elapsed.current);
    lastKey.current = '';
    publish(p, f, 'paused');
  }, [publish]);

  const resume = useCallback((): void => {
    const p = plan.current;
    if (!p || raf.current) return;
    t0.current = performance.now() - elapsed.current;
    lastKey.current = '';
    raf.current = requestAnimationFrame(tick);
  }, [tick]);

  const stop = useCallback((): void => {
    cancel();
    plan.current = null;
    lastKey.current = '';
    setState((s: SweepState): SweepState => (s.phase === 'idle' ? s : IDLE));
  }, []);

  useEffect((): (() => void) => (): void => cancel(), []);

  return { state, start, pause, resume, stop };
}
