// Moon hillshade with the current route. Click to add points; the next leg previews under the pointer.
import { useEffect, useRef, useState, type JSX, type MouseEvent, type PointerEvent } from 'react';
import { loadImage } from '../../data/loader';
import type { LoadedTile } from '../../data/tiles';
import { mapToPixel, pixelToMap } from '../../lib/terrain';
import { useApp } from '../../store';
import type { Region } from '../../types/contract';

type XY = [number, number];

interface MoonPadProps {
  region: Region;
  tile: LoadedTile;
  route: XY[];
  /** Whether clicks add points (draw mode) or start a new drawn route. */
  drawing: boolean;
  onAdd: (xy: XY) => void;
  /** Pointer position in map metres while drawing (null when it leaves), for the live preview. */
  onHover: (xy: XY | null) => void;
  hover: XY | null;
}

const N = 720;

export function MoonPad({ region, tile, route, drawing, onAdd, onHover, hover }: MoonPadProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const origin = useApp((s) => s.core?.regionsOrigin ?? 'data');

  useEffect((): (() => void) => {
    let alive = true;
    setImg(null);
    loadImage(region.hillshade, origin)
      .then((i: HTMLImageElement): void => {
        if (alive) setImg(i);
      })
      .catch((): void => undefined);
    return (): void => {
      alive = false;
    };
  }, [region, origin]);

  useEffect((): void => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const n = tile.ref.size;
    const toCanvas = ([x, y]: XY): XY => {
      const [c, r] = mapToPixel(x, y, tile.ref.origin_x, tile.ref.origin_y, tile.ref.res_m);
      return [((c + 0.5) / n) * N, ((r + 0.5) / n) * N];
    };
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, N, N);
    if (img) ctx.drawImage(img, 0, 0, N, N);

    // 1 km scale bar
    const kmPx = (1000 / (n * tile.ref.res_m)) * N;
    ctx.fillStyle = 'rgba(10, 11, 14, 0.78)';
    ctx.fillRect(N - kmPx - 28, N - 36, kmPx + 20, 26);
    ctx.fillStyle = '#edeae4';
    ctx.fillRect(N - kmPx - 18, N - 18, kmPx, 3);
    ctx.font = '13px "IBM Plex Sans", system-ui, sans-serif';
    ctx.fillText('1 km', N - kmPx - 18, N - 23);

    const pts = drawing && hover && route.length > 0 ? [...route, hover] : route;
    if (pts.length === 0) return;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const stroke = (list: XY[], dashed: boolean): void => {
      ctx.setLineDash(dashed ? [10, 8] : []);
      ctx.beginPath();
      list.forEach((p: XY, i: number): void => {
        const [px, py] = toCanvas(p);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = '#0a0b0e';
      ctx.lineWidth = 8;
      ctx.stroke();
      ctx.strokeStyle = '#edeae4';
      ctx.lineWidth = 3.5;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    stroke(route, false);
    if (pts.length > route.length && route.length > 0) stroke([route[route.length - 1], pts[pts.length - 1]], true);

    // Vertices: a ringed start, a solid end arrow-dot, small joints between.
    route.forEach((p: XY, i: number): void => {
      const [px, py] = toCanvas(p);
      const isStart = i === 0;
      const isEnd = i === route.length - 1 && route.length > 1;
      ctx.beginPath();
      ctx.arc(px, py, isStart ? 9 : isEnd ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = isStart ? '#0a0b0e' : '#edeae4';
      ctx.fill();
      ctx.lineWidth = isStart ? 3 : 2;
      ctx.strokeStyle = isStart ? '#edeae4' : '#0a0b0e';
      ctx.stroke();
      if (isStart || isEnd) {
        const label = isStart ? 'Start' : 'End';
        ctx.font = '600 14px "IBM Plex Sans", system-ui, sans-serif';
        const w = ctx.measureText(label).width;
        const lx = Math.min(Math.max(px + 14, 6), N - w - 18);
        const ly = Math.min(Math.max(py - 14, 22), N - 8);
        ctx.fillStyle = 'rgba(10, 11, 14, 0.82)';
        ctx.fillRect(lx - 6, ly - 16, w + 12, 22);
        ctx.fillStyle = '#edeae4';
        ctx.fillText(label, lx, ly);
      }
    });
  }, [img, route, tile, hover, drawing]);

  const toMap = (e: PointerEvent<HTMLCanvasElement> | MouseEvent<HTMLCanvasElement>): XY => {
    const rect = e.currentTarget.getBoundingClientRect();
    const n = tile.ref.size;
    const col = ((e.clientX - rect.left) / rect.width) * n - 0.5;
    const row = ((e.clientY - rect.top) / rect.height) * n - 0.5;
    return pixelToMap(col, row, tile.ref.origin_x, tile.ref.origin_y, tile.ref.res_m);
  };

  return (
    <canvas
      ref={ref}
      width={N}
      height={N}
      role="img"
      aria-label={`Shaded terrain of ${region.name}, 15 by 15 km. Click to draw a route.`}
      onClick={(e): void => onAdd(toMap(e))}
      onPointerMove={(e): void => {
        if (drawing && route.length > 0) onHover(toMap(e));
      }}
      onPointerLeave={(): void => onHover(null)}
    />
  );
}
