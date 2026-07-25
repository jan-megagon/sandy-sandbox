import type { PaddleSide } from '../game/kayak';

/**
 * Paddle input: the screen is split into a left and a right zone.
 *
 * A stroke fires on pointer *down*, not on release, so taps have no perceived
 * latency. If the finger is still down after the hold threshold the same
 * gesture becomes a brace, which continues until release. That means a quick
 * tap is a stroke and a press is a planted paddle, with no mode switch and
 * nothing for the player to learn beyond "tap to go, hold to carve".
 */

export const HOLD_THRESHOLD_MS = 200;

export interface PlayControlHandlers {
  onStroke(side: PaddleSide): void;
  onBraceStart(side: PaddleSide): void;
  onBraceEnd(side: PaddleSide): void;
}

interface ActiveTouch {
  side: PaddleSide;
  timer: number;
  bracing: boolean;
}

/**
 * Pointer capture is a nicety - it keeps a drag bound to this element - but it
 * throws if the pointer is already gone. Letting that propagate would abort the
 * rest of the handler and swallow the stroke entirely, so it is never allowed
 * to be more than best effort.
 */
function capturePointer(e: PointerEvent): void {
  try {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  } catch {
    // The pointer ended before we could capture it; nothing to do.
  }
}

export class PlayControls {
  private active = new Map<number, ActiveTouch>();
  private element: HTMLElement | null = null;

  constructor(private handlers: PlayControlHandlers) {}

  attach(element: HTMLElement): void {
    this.detach();
    this.element = element;
    element.addEventListener('pointerdown', this.onDown);
    element.addEventListener('pointerup', this.onUp);
    element.addEventListener('pointercancel', this.onUp);
    element.addEventListener('contextmenu', this.preventDefault);
  }

  detach(): void {
    const element = this.element;
    if (!element) return;
    element.removeEventListener('pointerdown', this.onDown);
    element.removeEventListener('pointerup', this.onUp);
    element.removeEventListener('pointercancel', this.onUp);
    element.removeEventListener('contextmenu', this.preventDefault);
    this.releaseAll();
    this.element = null;
  }

  /** Drop any held braces, e.g. when the run ends or the app is backgrounded. */
  releaseAll(): void {
    for (const [, touch] of this.active) {
      window.clearTimeout(touch.timer);
      if (touch.bracing) this.handlers.onBraceEnd(touch.side);
    }
    this.active.clear();
  }

  private preventDefault = (e: Event): void => {
    e.preventDefault();
  };

  private onDown = (e: PointerEvent): void => {
    const element = this.element;
    if (!element) return;
    e.preventDefault();

    const rect = element.getBoundingClientRect();
    const side: PaddleSide = e.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
    capturePointer(e);

    // Immediate stroke - the tap should feel like it lands the instant you touch.
    this.handlers.onStroke(side);

    const touch: ActiveTouch = {
      side,
      bracing: false,
      timer: window.setTimeout(() => {
        touch.bracing = true;
        this.handlers.onBraceStart(side);
      }, HOLD_THRESHOLD_MS),
    };
    this.active.set(e.pointerId, touch);
  };

  private onUp = (e: PointerEvent): void => {
    const touch = this.active.get(e.pointerId);
    if (!touch) return;
    this.active.delete(e.pointerId);
    window.clearTimeout(touch.timer);
    if (touch.bracing) this.handlers.onBraceEnd(touch.side);
  };
}
