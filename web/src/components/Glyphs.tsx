import type { JSX } from 'react';
import type { HazardId, Light } from '../types/contract';

/** Hazard identity: hue says WHICH hazard; the glyph shape repeats it for colour-blind readers. */
export type HazardKey = HazardId | 'slope';

interface GlyphProps {
  size?: number;
  className?: string;
}

export function HazardGlyph({ hazard, size = 16, className }: GlyphProps & { hazard: HazardKey }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    className: `glyph glyph-hz ${className ?? ''}`,
    'data-hz': hazard,
  } as const;
  if (hazard === 'shadow') {
    // half-disc: the lit half outlined, the shadowed half filled
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 2a6 6 0 0 0 0 12z" fill="currentColor" />
      </svg>
    );
  }
  if (hazard === 'rim') {
    // a step: flat ground, then a sudden drop
    return (
      <svg {...common}>
        <path d="M1.5 4.5h6v7h7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    );
  }
  if (hazard === 'texture') {
    // dotted square: a camera frame with too little in it
    return (
      <svg {...common}>
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          rx="1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="1.6 2.2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  // slope: a ramp
  return (
    <svg {...common}>
      <path d="M2 13h12V4z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** Fit carries no hue: filled = close, half = partial, outline = far. Always shown with its word. */
export function FitGlyph({ fit, size = 14, className }: GlyphProps & { fit: Light }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 14 14',
    'aria-hidden': true,
    className: `glyph glyph-fit ${className ?? ''}`,
    'data-fit': fit,
  } as const;
  if (fit === 'green') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="5.5" fill="currentColor" />
      </svg>
    );
  }
  if (fit === 'amber') {
    return (
      <svg {...common}>
        <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M7 2a5 5 0 0 0 0 10z" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export const FIT_WORD: Record<Light, string> = { green: 'Close', amber: 'Partial', red: 'Far' };

export function Fit({ fit, lower = false }: { fit: Light; lower?: boolean }): JSX.Element {
  const word = FIT_WORD[fit] ?? fit;
  return (
    <span className="fit" data-fit={fit}>
      <FitGlyph fit={fit} />
      {lower ? word.toLowerCase() : word}
    </span>
  );
}

export type VerdictKind = 'match' | 'mismatch' | 'cannot' | 'pass' | 'fail';

/** 16 px neutral line glyphs that replace the old emoji. */
export function VerdictGlyph({ kind, size = 16, className }: GlyphProps & { kind: VerdictKind }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    className: `glyph glyph-verdict ${className ?? ''}`,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const;
  if (kind === 'match' || kind === 'pass') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M5.2 8.2l1.9 1.9 3.8-4" />
      </svg>
    );
  }
  if (kind === 'mismatch') {
    // not-equal sign in a circle
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M5 6.6h6M5 9.4h6M9.6 4.6l-3.2 6.8" />
      </svg>
    );
  }
  if (kind === 'fail') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6.25" />
        <path d="M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" />
      </svg>
    );
  }
  // cannot test: slashed circle
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M3.6 12.4l8.8-8.8" />
    </svg>
  );
}

/** Sun glyph. Gold is reserved for sunlight, so this is one of the few places it appears. */
export function SunGlyph({ size = 16, className }: GlyphProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={`glyph glyph-sun ${className ?? ''}`}>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path
        d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ChevronGlyph({ open, size = 16 }: GlyphProps & { open: boolean }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="glyph glyph-chevron" data-open={open}>
      <path d="M5.5 6.5L8 9l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
