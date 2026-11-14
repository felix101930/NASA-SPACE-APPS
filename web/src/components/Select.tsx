// A custom single-choice dropdown that replaces the native <select> (which renders as an OS menu, differently on
// every platform, and ignores the dark theme).
//
// Accessibility follows the WAI-ARIA listbox pattern:
//  - the trigger is a <button aria-haspopup="listbox" aria-expanded>, named by the visible label plus the value;
//  - the popup is role="listbox" with role="option" children (aria-selected), optional role="group" sections;
//  - when open, focus sits on the listbox and aria-activedescendant points at the highlighted option.
// Keyboard: Up/Down/Home/End move, Enter/Space choose, Escape closes and returns focus to the trigger, Tab closes,
// printable keys jump by type-ahead (also on the closed trigger). A pointer press outside closes it.
// The popup is portalled to <body> with position: fixed, so no ancestor's overflow clips it; it opens below the
// trigger and flips above when there is not enough room underneath.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import '../styles/select.css';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** Optional second line under the label (a short description). */
  hint?: string;
  /** Optional section heading; consecutive options with the same group are shown together. */
  group?: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Visible label above the trigger. */
  label: string;
  /** Overrides the accessible name (defaults to the visible label). */
  ariaLabel?: string;
  /** Class of the wrapper (e.g. "field", "t3-pick"). */
  className?: string;
  /** Class of the visible label (e.g. "field-label"). */
  labelClassName?: string;
  /** Extra class on the trigger button (it always has "select sel-trigger"). */
  triggerClassName?: string;
  /** Hide the visible label (it stays available to assistive tech). */
  hideLabel?: boolean;
  /** id for the trigger button, so other elements can point at it. */
  id?: string;
}

interface PopupPlace {
  left: number;
  width: number;
  top: number | null;
  bottom: number | null;
  maxHeight: number;
  above: boolean;
}

const GAP = 6;
const MAX_H = 320;
const MIN_H = 140;
const TYPEAHEAD_MS = 600;

function place(trigger: HTMLElement): PopupPlace {
  const r = trigger.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = document.documentElement.clientWidth;
  const below = vh - r.bottom - GAP - 8;
  const aboveSpace = r.top - GAP - 8;
  const above = below < Math.min(MAX_H, MIN_H * 1.5) && aboveSpace > below;
  const width = Math.max(r.width, 200);
  const left = Math.min(Math.max(8, r.left), Math.max(8, vw - width - 8));
  return {
    left,
    width,
    top: above ? null : r.bottom + GAP,
    bottom: above ? vh - r.top + GAP : null,
    maxHeight: Math.max(MIN_H, Math.min(MAX_H, above ? aboveSpace : below)),
    above,
  };
}

function Chevron(): JSX.Element {
  return (
    <svg className="sel-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 6.5L8 9.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Check(): JSX.Element {
  return (
    <svg className="sel-check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7.5l2.6 2.5L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Section<T extends string> {
  group: string | null;
  items: { option: SelectOption<T>; index: number }[];
}

function sections<T extends string>(options: readonly SelectOption<T>[]): Section<T>[] {
  const out: Section<T>[] = [];
  options.forEach((option: SelectOption<T>, index: number): void => {
    const g = option.group ?? null;
    const last = out[out.length - 1];
    if (last && last.group === g) last.items.push({ option, index });
    else out.push({ group: g, items: [{ option, index }] });
  });
  return out;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  ariaLabel,
  className,
  labelClassName,
  triggerClassName,
  hideLabel = false,
  id,
}: SelectProps<T>): JSX.Element {
  const uid = useId();
  const triggerId = id ?? `${uid}-trigger`;
  const labelId = `${uid}-label`;
  const listId = `${uid}-list`;
  const optId = (i: number): string => `${uid}-opt-${i}`;

  const [open, setOpen] = useState<boolean>(false);
  const [active, setActive] = useState<number>(-1);
  const [pos, setPos] = useState<PopupPlace | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });

  const selectedIndex = options.findIndex((o: SelectOption<T>): boolean => o.value === value);
  const selected: SelectOption<T> | undefined = options[selectedIndex];
  const groups = useMemo((): Section<T>[] => sections(options), [options]);
  const enabled = useCallback((i: number): boolean => i >= 0 && i < options.length && !options[i].disabled, [options]);

  const step = (from: number, dir: 1 | -1): number => {
    for (let i = from + dir; i >= 0 && i < options.length; i += dir) if (enabled(i)) return i;
    return from;
  };
  const first = (): number => step(-1, 1);
  const last = (): number => step(options.length, -1);

  /** Type-ahead: the next enabled option whose label starts with the typed text (cycling on a repeated letter). */
  const typeAhead = (key: string, from: number): number => {
    const now = performance.now();
    const t = typed.current;
    t.text = now - t.at > TYPEAHEAD_MS ? key : t.text + key;
    t.at = now;
    const q = t.text.toLowerCase();
    const repeated = q.length > 1 && q.split('').every((c: string): boolean => c === q[0]);
    const needle = repeated ? q[0] : q;
    const start = repeated || q.length === 1 ? from + 1 : from;
    for (let k = 0; k < options.length; k++) {
      const i = (((start + k) % options.length) + options.length) % options.length;
      if (enabled(i) && options[i].label.toLowerCase().startsWith(needle)) return i;
    }
    return -1;
  };

  const openList = (at?: number): void => {
    const trig = triggerRef.current;
    if (trig) setPos(place(trig));
    setActive(at !== undefined && at >= 0 ? at : enabled(selectedIndex) ? selectedIndex : first());
    setOpen(true);
  };

  const close = (focusTrigger: boolean): void => {
    setOpen(false);
    if (focusTrigger) triggerRef.current?.focus();
  };

  const choose = (i: number): void => {
    if (!enabled(i)) return;
    if (options[i].value !== value) onChange(options[i].value);
    close(true);
  };

  // Focus the listbox when it opens; keep the highlighted option visible.
  useLayoutEffect((): void => {
    if (open) listRef.current?.focus({ preventScroll: true });
  }, [open]);
  useLayoutEffect((): void => {
    if (!open || active < 0) return;
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !el) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top - 4;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }, [open, active, pos]);

  // While open: a press outside closes; scrolling or resizing re-anchors the popup to the trigger.
  useEffect((): (() => void) | void => {
    if (!open) return;
    const onDown = (e: PointerEvent): void => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (wrapRef.current?.contains(t) || listRef.current?.contains(t)) return;
      setOpen(false);
    };
    let raf = 0;
    const onMove = (e: Event): void => {
      if (e.target instanceof Node && listRef.current?.contains(e.target)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame((): void => {
        const trig = triggerRef.current;
        if (trig) setPos(place(trig));
      });
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return (): void => {
      cancelAnimationFrame(raf);
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
      case 'Enter':
      case ' ':
        e.preventDefault();
        openList();
        return;
      case 'Home':
        e.preventDefault();
        openList(first());
        return;
      case 'End':
        e.preventDefault();
        openList(last());
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const i = typeAhead(e.key, selectedIndex);
          if (i >= 0) {
            e.preventDefault();
            openList(i);
          }
        }
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a: number): number => (a < 0 ? first() : step(a, 1)));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a: number): number => (a < 0 ? last() : step(a, -1)));
        return;
      case 'Home':
      case 'PageUp':
        e.preventDefault();
        setActive(first());
        return;
      case 'End':
      case 'PageDown':
        e.preventDefault();
        setActive(last());
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0) choose(active);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        return;
      case 'Tab':
        // Let focus move on naturally; just close.
        setOpen(false);
        return;
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const i = typeAhead(e.key, active);
          if (i >= 0) {
            e.preventDefault();
            setActive(i);
          }
        }
    }
  };

  const popup =
    open && pos
      ? createPortal(
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            className="sel-pop"
            data-side={pos.above ? 'above' : 'below'}
            aria-labelledby={ariaLabel ? undefined : labelId}
            aria-label={ariaLabel}
            aria-activedescendant={active >= 0 ? optId(active) : undefined}
            style={{
              left: pos.left,
              minWidth: pos.width,
              top: pos.top ?? undefined,
              bottom: pos.bottom ?? undefined,
              maxHeight: pos.maxHeight,
            }}
            onKeyDown={onListKey}
            onBlur={(e): void => {
              const next = e.relatedTarget;
              if (next instanceof Node && (listRef.current?.contains(next) || wrapRef.current?.contains(next))) return;
              setOpen(false);
            }}
          >
            {groups.map((s: Section<T>, gi: number) => {
              const items = s.items.map(({ option, index }) => {
                const isSel = index === selectedIndex;
                return (
                  <div
                    key={option.value}
                    id={optId(index)}
                    role="option"
                    aria-selected={isSel}
                    aria-disabled={option.disabled || undefined}
                    data-index={index}
                    data-active={index === active || undefined}
                    className="sel-opt"
                    onPointerMove={(): void => {
                      if (enabled(index) && index !== active) setActive(index);
                    }}
                    onPointerDown={(e): void => e.preventDefault()}
                    onClick={(): void => choose(index)}
                  >
                    <span className="sel-opt-mark">{isSel && <Check />}</span>
                    <span className="sel-opt-text">
                      <span className="sel-opt-label">{option.label}</span>
                      {option.hint && <span className="sel-opt-hint">{option.hint}</span>}
                    </span>
                  </div>
                );
              });
              if (s.group === null) return items;
              const gid = `${uid}-g-${gi}`;
              return (
                <div key={gid} role="group" aria-labelledby={gid} className="sel-group">
                  <div id={gid} className="sel-group-label" role="presentation">
                    {s.group}
                  </div>
                  {items}
                </div>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={`sel ${className ?? ''}`} ref={wrapRef}>
      <span id={labelId} className={hideLabel ? 'sr-only' : labelClassName}>
        {label}
      </span>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`select sel-trigger ${triggerClassName ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={ariaLabel ? undefined : `${labelId} ${triggerId}`}
        aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label ?? ''}` : undefined}
        onClick={(): void => (open ? close(false) : openList())}
        onKeyDown={onTriggerKey}
      >
        <span className="sel-value">{selected?.label ?? '—'}</span>
        <Chevron />
      </button>
      {popup}
    </div>
  );
}
