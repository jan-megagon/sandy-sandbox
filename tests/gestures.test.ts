import { describe, expect, it, vi } from 'vitest';
import { GestureRecognizer } from '../src/input/gestures';

/**
 * A stand-in for the canvas. The recogniser only needs somewhere to hang
 * listeners and a rect to measure against.
 */
function fakeCanvas() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
    },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
    fire(type: string, e: Record<string, unknown>) {
      for (const fn of listeners.get(type) ?? []) {
        fn({ preventDefault() {}, target: this, ...e });
      }
    },
  };
}

function harness() {
  const events: string[] = [];
  const recogniser = new GestureRecognizer({
    onPaintStart: () => events.push('start'),
    onPaintMove: () => events.push('move'),
    onPaintEnd: (committed) => events.push(committed ? 'end' : 'abandoned'),
    onPanZoom: () => events.push('panzoom'),
  });
  const canvas = fakeCanvas();
  recogniser.attach(canvas as unknown as HTMLElement);
  return { events, canvas, recogniser };
}

const down = (id: number, x: number, y: number) => ['pointerdown', { pointerId: id, clientX: x, clientY: y }] as const;
const move = (id: number, x: number, y: number) => ['pointermove', { pointerId: id, clientX: x, clientY: y }] as const;
const up = (id: number, x: number, y: number) => ['pointerup', { pointerId: id, clientX: x, clientY: y }] as const;

describe('GestureRecognizer', () => {
  it('does not start a stroke when a second finger arrives', () => {
    vi.useFakeTimers();
    const { events, canvas } = harness();

    // The realistic case: two fingers land a few milliseconds apart.
    canvas.fire(...down(1, 100, 100));
    vi.advanceTimersByTime(30);
    canvas.fire(...down(2, 160, 130));
    vi.advanceTimersByTime(200);
    canvas.fire(...move(2, 170, 140));

    // Nothing was painted or placed. This is the bug that put a rock down on
    // every pinch.
    expect(events).not.toContain('start');
    expect(events).toContain('panzoom');
    vi.useRealTimers();
  });

  it('still treats a quick tap as a tap', () => {
    vi.useFakeTimers();
    const { events, canvas } = harness();

    canvas.fire(...down(1, 50, 50));
    vi.advanceTimersByTime(20);
    canvas.fire(...up(1, 50, 50));

    expect(events).toEqual(['start', 'end']);
    vi.useRealTimers();
  });

  it('starts a stroke as soon as the finger clearly means it', () => {
    vi.useFakeTimers();
    const { events, canvas } = harness();

    canvas.fire(...down(1, 50, 50));
    // Well inside the grace window, but far enough to be a deliberate drag.
    vi.advanceTimersByTime(10);
    canvas.fire(...move(1, 90, 50));

    expect(events[0]).toBe('start');
    expect(events).toContain('move');
    vi.useRealTimers();
  });

  it('starts a stroke on a finger held still past the grace window', () => {
    vi.useFakeTimers();
    const { events, canvas } = harness();

    canvas.fire(...down(1, 50, 50));
    vi.advanceTimersByTime(200);
    expect(events).toEqual(['start']);

    canvas.fire(...up(1, 50, 50));
    expect(events).toEqual(['start', 'end']);
    vi.useRealTimers();
  });

  it('reports an abandoned stroke differently from a finished one', () => {
    vi.useFakeTimers();
    const { events, canvas } = harness();

    canvas.fire(...down(1, 50, 50));
    vi.advanceTimersByTime(200); // becomes a real stroke
    canvas.fire(...down(2, 120, 60)); // then a second finger joins

    expect(events).toEqual(['start', 'abandoned']);
    vi.useRealTimers();
  });

  it('pans on one finger in pan-only mode, and never paints', () => {
    vi.useFakeTimers();
    const { events, canvas, recogniser } = harness();
    recogniser.singlePointerPans = true;

    canvas.fire(...down(1, 50, 50));
    vi.advanceTimersByTime(300);
    canvas.fire(...move(1, 80, 70));
    canvas.fire(...up(1, 80, 70));

    expect(events).not.toContain('start');
    expect(events).toContain('panzoom');
    vi.useRealTimers();
  });
});
