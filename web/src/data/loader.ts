// Loads pipeline outputs from `data/`, falling back to `mock/` per file when the real one is missing
// or invalid. Vite's dev server answers unknown paths with index.html (HTTP 200), so every response
// is validated (content-type, JSON guard, exact byte length) rather than trusting the status code.

export type Origin = 'data' | 'mock';

export interface Loaded<T> {
  value: T;
  origin: Origin;
}

const BASE: string = import.meta.env.BASE_URL;

type MockListener = (path: string) => void;
const listeners = new Set<MockListener>();
const mockPaths = new Set<string>();

export function onMockUsed(fn: MockListener): () => void {
  listeners.add(fn);
  mockPaths.forEach((p: string): void => fn(p));
  return (): void => {
    listeners.delete(fn);
  };
}

function noteMock(path: string): void {
  if (mockPaths.has(path)) return;
  mockPaths.add(path);
  listeners.forEach((fn: MockListener): void => fn(path));
}

export function assetUrl(path: string, origin: Origin): string {
  return `${BASE}${origin}/${path}`;
}

function orderFor(prefer: Origin): Origin[] {
  return prefer === 'data' ? ['data', 'mock'] : ['mock', 'data'];
}

async function fetchOk(url: string): Promise<Response | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('text/html')) return null;
    return res;
  } catch {
    return null;
  }
}

export class DataError extends Error {}

export async function loadJson<T>(path: string, guard: (v: unknown) => v is T, prefer: Origin = 'data'): Promise<Loaded<T>> {
  const problems: string[] = [];
  for (const origin of orderFor(prefer)) {
    const res = await fetchOk(assetUrl(path, origin));
    if (!res) {
      problems.push(`${origin}/${path}: not found`);
      continue;
    }
    try {
      const json: unknown = await res.json();
      if (guard(json)) {
        if (origin === 'mock') noteMock(path);
        return { value: json, origin };
      }
      problems.push(`${origin}/${path}: does not match docs/data-contract.md`);
      console.warn(`[data] ${origin}/${path} failed the contract check; trying fallback.`);
    } catch {
      problems.push(`${origin}/${path}: invalid JSON`);
    }
  }
  throw new DataError(problems.join('; '));
}

/** Loads a JSON file from exactly one origin (no fallback). Null when missing or off-contract. */
export async function loadJsonFrom<T>(path: string, guard: (v: unknown) => v is T, origin: Origin): Promise<Loaded<T> | null> {
  const res = await fetchOk(assetUrl(path, origin));
  if (!res) return null;
  try {
    const json: unknown = await res.json();
    if (!guard(json)) {
      console.info(`[data] ${origin}/${path} does not match the data contract; ignoring it.`);
      return null;
    }
    if (origin === 'mock') noteMock(path);
    return { value: json, origin };
  } catch {
    return null;
  }
}

export async function loadOptionalJson<T>(path: string, guard: (v: unknown) => v is T): Promise<Loaded<T> | null> {
  try {
    return await loadJson(path, guard);
  } catch {
    return null;
  }
}

/**
 * Raw bytes of a binary from exactly one origin, or null when it is missing, an HTML fallback page (Vite answers
 * unknown paths with index.html) or not exactly `byteLength` long (null = any length).
 */
export async function loadBytesFrom(path: string, byteLength: number | null, origin: Origin): Promise<ArrayBuffer | null> {
  const res = await fetchOk(assetUrl(path, origin));
  if (!res) return null;
  try {
    const buf = await res.arrayBuffer();
    return byteLength === null || buf.byteLength === byteLength ? buf : null;
  } catch {
    return null;
  }
}

/** Loads a raw little-endian Float32 binary of an exact element count. */
export async function loadFloat32(path: string, count: number, prefer: Origin = 'data'): Promise<Loaded<Float32Array>> {
  for (const origin of orderFor(prefer)) {
    const res = await fetchOk(assetUrl(path, origin));
    if (!res) continue;
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== count * 4) {
      console.warn(`[data] ${origin}/${path}: expected ${count * 4} bytes, got ${buf.byteLength}; trying fallback.`);
      continue;
    }
    // Contract says little-endian; every browser platform we target is little-endian too.
    if (origin === 'mock') noteMock(path);
    return { value: new Float32Array(buf), origin };
  }
  throw new DataError(`${path}: missing or wrong size in data/ and mock/`);
}

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImageUrl(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve: (v: HTMLImageElement) => void, reject: (e: Error) => void): void => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = (): void => resolve(img);
    img.onerror = (): void => reject(new Error(`image failed: ${url}`));
    img.src = url;
  });
}

/** Loads a PNG from data/ (or the preferred origin), falling back to the other origin. Cached. */
export function loadImage(path: string, prefer: Origin = 'data'): Promise<HTMLImageElement> {
  const key = `${prefer}:${path}`;
  const hit = imageCache.get(key);
  if (hit) return hit;
  const [first, second] = orderFor(prefer);
  const p = loadImageUrl(assetUrl(path, first)).catch((): Promise<HTMLImageElement> =>
    loadImageUrl(assetUrl(path, second)).then((img: HTMLImageElement): HTMLImageElement => {
      if (second === 'mock') noteMock(path);
      return img;
    }),
  );
  imageCache.set(key, p);
  p.catch((): void => {
    imageCache.delete(key);
  });
  return p;
}
