/**
 * Editor touch handling: one finger paints, two fingers pan and pinch-zoom.
 *
 * Uses Pointer Events rather than Touch Events so the same code path serves a
 * mouse on desktop and a finger on a phone - which also means the editor is
 * driveable by an automated browser for testing.
 */

export interface GestureHandlers {
  /** Coordinates are CSS pixels relative to the element. */
  onPaintStart?(x: number, y: number): void;
  onPaintMove?(x: number, y: number): void;
  onPaintEnd?(): void;
  /** Panning by a screen delta, and scaling about a screen point. */
  onPanZoom?(dx: number, dy: number, scale: number, centreX: number, centreY: number): void;
  /** Pointer moved without any button held (mouse hover), for the brush cursor. */
  onHover?(x: number, y: number): void;
}

interface TrackedPointer {
  x: number;
  y: number;
}

export class GestureRecognizer {
  private pointers = new Map<number, TrackedPointer>();
  private painting = false;
  /**
   * Set once a second finger lands and held until every finger lifts, so
   * releasing one finger mid-pinch doesn't drop you back into painting and
   * smear the terrain.
   */
  private multiTouch = false;
  private lastCentre = { x: 0, y: 0 };
  private lastSpread = 0;
  private attached: HTMLElement | null = null;

  constructor(private handlers: GestureHandlers) {}

  attach(element: HTMLElement): void {
    this.detach();
    this.attached = element;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('pointerleave', this.onPointerUp);
    element.addEventListener('contextmenu', this.onContextMenu);
  }

  detach(): void {
    const element = this.attached;
    if (!element) return;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('pointerleave', this.onPointerUp);
    element.removeEventListener('contextmenu', this.onContextMenu);
    this.pointers.clear();
    this.painting = false;
    this.multiTouch = false;
    this.attached = null;
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private local(e: PointerEvent): { x: number; y: number } {
    const rect = (this.attached as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private onPointerDown = (e: PointerEvent): void => {
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    try {
      // Best effort only: this throws if the pointer has already ended, and
      // letting it propagate would abandon the stroke.
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();

    if (this.pointers.size === 1) {
      this.painting = true;
      this.multiTouch = false;
      this.handlers.onPaintStart?.(p.x, p.y);
    } else if (this.pointers.size === 2) {
      // Abandon the stroke the first finger started; this is a pinch.
      if (this.painting) {
        this.painting = false;
        this.handlers.onPaintEnd?.();
      }
      this.multiTouch = true;
      this.updatePinchReference();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    const tracked = this.pointers.get(e.pointerId);
    if (!tracked) {
      if (this.pointers.size === 0) {
        const p = this.local(e);
        this.handlers.onHover?.(p.x, p.y);
      }
      return;
    }

    const p = this.local(e);
    tracked.x = p.x;
    tracked.y = p.y;
    e.preventDefault();

    if (this.pointers.size >= 2) {
      const { centre, spread } = this.pinchState();
      const dx = centre.x - this.lastCentre.x;
      const dy = centre.y - this.lastCentre.y;
      const scale = this.lastSpread > 0 ? spread / this.lastSpread : 1;
      this.handlers.onPanZoom?.(dx, dy, scale, centre.x, centre.y);
      this.lastCentre = centre;
      this.lastSpread = spread;
    } else if (this.painting) {
      this.handlers.onPaintMove?.(p.x, p.y);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;

    if (this.painting && this.pointers.size === 0) {
      this.painting = false;
      this.handlers.onPaintEnd?.();
    }
    if (this.pointers.size === 0) {
      this.multiTouch = false;
    } else if (this.pointers.size === 1) {
      // Keep gesturing rather than resuming a paint stroke.
      this.updatePinchReference();
    }
  };

  private pinchState(): { centre: { x: number; y: number }; spread: number } {
    const pts = [...this.pointers.values()];
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    const centre = { x: sx / pts.length, y: sy / pts.length };
    const spread =
      pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : this.lastSpread;
    return { centre, spread };
  }

  private updatePinchReference(): void {
    const { centre, spread } = this.pinchState();
    this.lastCentre = centre;
    this.lastSpread = spread;
  }

  get isGesturing(): boolean {
    return this.multiTouch;
  }
}
