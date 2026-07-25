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

  constructor(
    public viewWidth = 1,
    public viewHeight = 1,
  ) {}

  setViewport(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
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
}
