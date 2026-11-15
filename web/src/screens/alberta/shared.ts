// Small helpers shared by the Alberta and Calgary maps.
import type { NeedCategory } from '../../types/alberta';

/** Equity Index need ramp (keep in sync with --need-1..5 in styles.css). Higher = greater need for access to amenities. */
export const NEED_COLOUR: Record<NeedCategory, string> = {
  Lowest: '#1d2b2c',
  Low: '#21403f',
  Moderate: '#2a5c56',
  High: '#357f73',
  Highest: '#45a593',
};

/** Filter chip order: greatest need first. */
export const NEED_FILTER_ORDER: NeedCategory[] = ['Highest', 'High', 'Moderate', 'Low', 'Lowest'];

export type NeedFilter = NeedCategory | 'All';

/** Plain words for an Equity Index Accessibility & Amenities category (higher category = amenities harder to reach). */
const ACCESS_WORDS: Record<NeedCategory, string> = {
  Highest: 'Amenities hardest to reach',
  High: 'Amenities hard to reach',
  Moderate: 'Amenities middling to reach',
  Low: 'Amenities easier to reach',
  Lowest: 'Amenities easiest to reach',
};

export function isNeedCategory(v: string | null | undefined): v is NeedCategory {
  return v === 'Highest' || v === 'High' || v === 'Moderate' || v === 'Low' || v === 'Lowest';
}

export function accessPhrase(category: string | null | undefined): string {
  return isNeedCategory(category) ? ACCESS_WORDS[category] : 'Not scored by the Equity Index';
}

/** The two groups where amenities are hardest to reach (top two of the City's five). */
export const HARDEST: ReadonlySet<string> = new Set(['Highest', 'High']);

export function needPhrase(category: string | null | undefined): string {
  return accessPhrase(category);
}

export function pinElement(label: string, title: string, active: boolean, dashed = false): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = dashed ? 'pin pin-dashed' : 'pin';
  el.textContent = label;
  el.title = title;
  el.setAttribute('aria-label', title);
  if (active) el.setAttribute('aria-current', 'true');
  return el;
}
