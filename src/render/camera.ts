import { type Grid, clamp } from '../sim/grid';

/**
 * Top-down camera. Position is the world point at the centre of the screen;
 * zoom is screen pixels per world metre.
 */
export class Camera {
  x = 0;
  y = 0;
  zoom = 8;

  minZoom = 2;
  maxZoom = 40;

  /**
   * Screen edges covered by UI, in device pixels.
   *
   * The projection still runs off the middle of the canvas - moving that would
   * put every world-to-screen conversion out of step with the pointer - but
   * anything that decides *what to look at* uses the space actually left over.
   * Without this the editor centres a level behind its own toolbar.
   */
  insetTop = 0;
  insetBottom = 0;

  constructor(
    public viewWidth = 1,
    public viewHeight = 1,
  ) {}

  setViewport(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
  }

  setInsets(top: number, bottom: number): void {
    this.insetTop = Math.max(0, top);
    this.insetBottom = Math.max(0, bottom);
  }

  /** Height of the strip that isn't behind UI. */
  get freeHeight(): number {
    return Math.max(1, this.viewHeight - this.insetTop - this.insetBottom);
  }

  /** How far the free strip's centre sits below the canvas centre, in pixels. */
  get freeOffsetY(): number {
    return (this.insetTop - this.insetBottom) / 2;
  }

  worldToScreenX(wx: number): number {
    return (wx - this.x) * this.zoom + this.viewWidth / 2;
  }

  worldToScreenY(wy: number): number {
    return (wy - this.y) * this.zoom + this.viewHeight / 2;
  }

  screenToWorldX(sx: number): number {
    return (sx - this.viewWidth / 2) / this.zoom + this.x;
  }

  screenToWorldY(sy: number): number {
    return (sy - this.viewHeight / 2) / this.zoom + this.y;
  }

  /** Zoom about a fixed screen point, so pinch-zoom stays under the fingers. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const worldX = this.screenToWorldX(screenX);
    const worldY = this.screenToWorldY(screenY);
    this.zoom = clamp(this.zoom * factor, this.minZoom, this.maxZoom);
    this.x = worldX - (screenX - this.viewWidth / 2) / this.zoom;
    this.y = worldY - (screenY - this.viewHeight / 2) / this.zoom;
  }

  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Ease towards a target. `response` is roughly how many times per second it closes the gap. */
  follow(targetX: number, targetY: number, dt: number, response = 6): void {
    const t = 1 - Math.exp(-response * dt);
    this.x += (targetX - this.x) * t;
    this.y += (targetY - this.y) * t;
  }

  /**
   * Keep the level in view. If the level is smaller than the viewport on an
   * axis it centres on that axis instead of jamming against an edge.
   */
  clampToLevel(grid: Grid, margin = 0): void {
    const worldW = grid.width * grid.cellSize;
    const worldH = grid.height * grid.cellSize;
    const halfW = this.viewWidth / 2 / this.zoom;
    const halfH = this.viewHeight / 2 / this.zoom;

    if (worldW + margin * 2 <= halfW * 2) {
      this.x = worldW / 2;
    } else {
      this.x = clamp(this.x, halfW - margin, worldW - halfW + margin);
    }

    if (worldH + margin * 2 <= halfH * 2) {
      this.y = worldH / 2;
    } else {
      this.y = clamp(this.y, halfH - margin, worldH - halfH + margin);
    }
  }

  /** Zoom level at which the whole level just fits on screen. */
  fitZoom(grid: Grid): number {
    const worldW = grid.width * grid.cellSize;
    const worldH = grid.height * grid.cellSize;
    return Math.min(this.viewWidth / worldW, this.viewHeight / worldH);
  }

  fitToLevel(grid: Grid): void {
    this.zoom = clamp(this.fitZoom(grid), this.minZoom, this.maxZoom);
    this.x = (grid.width * grid.cellSize) / 2;
    this.y = (grid.height * grid.cellSize) / 2;
  }

  /**
   * Zoom so the level covers the whole viewport, overflowing on the long axis
   * rather than letterboxing. A square level on a tall phone would otherwise
   * leave big empty bands above and below, which read as a broken screen.
   */
  coverLevel(grid: Grid): void {
    const worldW = grid.width * grid.cellSize;
    const worldH = grid.height * grid.cellSize;
    const cover = Math.max(this.viewWidth / worldW, this.viewHeight / worldH);
    this.zoom = clamp(cover, this.minZoom, this.maxZoom);
    this.x = worldW / 2;
    this.y = worldH / 2;
    this.clampToLevel(grid);
  }

  /**
   * Frame the level in the space the UI leaves, rather than on the canvas.
   *
   * Covering the whole canvas puts the middle of the level behind the toolbar,
   * which is most of a phone screen in the editor. This sizes to the free strip
   * and lets the level run on underneath the UI, so what you can see is the
   * middle of the valley rather than the top half of it.
   */
  coverLevelInFreeArea(grid: Grid): void {
    const worldW = grid.width * grid.cellSize;
    const worldH = grid.height * grid.cellSize;
    const cover = Math.max(this.viewWidth / worldW, this.freeHeight / worldH);
    this.zoom = clamp(cover, this.minZoom, this.maxZoom);
    this.centreOnFreeArea(worldW / 2, worldH / 2);
  }

  /** Put a world point at the centre of the free strip, not of the canvas. */
  centreOnFreeArea(worldX: number, worldY: number): void {
    this.x = worldX;
    // The projection is about the canvas centre, so to push a point down to the
    // free strip's centre the camera has to move the other way.
    this.y = worldY - this.freeOffsetY / this.zoom;
  }

  /** World point currently at the centre of the free strip. */
  get freeCentreWorldY(): number {
    return this.y + this.freeOffsetY / this.zoom;
  }

  /**
   * Let the view go anywhere that still shows something of the level.
   *
   * `clampToLevel` pins the view inside the level, which is right when
   * following a boat and wrong in an editor: it snaps to the centre on any axis
   * where the level is smaller than the screen, so a zoomed-out level cannot be
   * moved off the toolbar at all. This only insists that `keep` metres of the
   * level stay inside the free strip, which is enough that you can always find
   * your way back to it.
   */
  keepLevelInView(grid: Grid, keep: number): void {
    const worldW = grid.width * grid.cellSize;
    const worldH = grid.height * grid.cellSize;
    const halfW = this.viewWidth / 2 / this.zoom;
    const halfH = this.freeHeight / 2 / this.zoom;

    // Never demand more overlap than there is level, or than there is screen.
    const keepX = Math.min(keep, worldW, halfW * 2);
    const keepY = Math.min(keep, worldH, halfH * 2);

    this.x = clamp(this.x, keepX - halfW, worldW - keepX + halfW);

    // Clamp what the person actually sees - the free strip - then convert back
    // to where the camera has to sit for that to be what they see.
    const centre = clamp(this.freeCentreWorldY, keepY - halfH, worldH - keepY + halfH);
    this.y = centre - this.freeOffsetY / this.zoom;
  }
}
