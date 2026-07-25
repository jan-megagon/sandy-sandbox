import type { Grid } from '../sim/grid';
import type { Level } from '../sim/level';
import type { WaterSim } from '../sim/water';
import { Camera } from './camera';
import { createContext } from './gl';
import { Shape, SpritePass } from './spritePass';
import { WorldPass } from './worldPass';

/** Everything drawn on top of the terrain and water for one frame. */
export interface Scene {
  level: Level;
  sim: WaterSim;
  time: number;
  /** Contour lines and entity markers: on in the editor, off while playing. */
  editorView: boolean;
  kayak?: {
    x: number;
    y: number;
    heading: number;
    strokeFlashLeft: number;
    strokeFlashRight: number;
    health: number;
  };
  /** Brush cursor position in world metres, with radius. */
  brush?: { x: number; y: number; radius: number; valid: boolean };
}

const COLOURS = {
  kayak: [0.94, 0.42, 0.18, 1] as [number, number, number, number],
  kayakHurt: [0.75, 0.22, 0.20, 1] as [number, number, number, number],
  goal: [0.35, 0.92, 0.55, 0.95] as [number, number, number, number],
  start: [0.45, 0.78, 1.0, 0.9] as [number, number, number, number],
  rock: [0.42, 0.40, 0.38, 1] as [number, number, number, number],
  source: [0.55, 0.85, 1.0, 0.85] as [number, number, number, number],
  brush: [1, 1, 1, 0.85] as [number, number, number, number],
  brushBad: [1, 0.4, 0.4, 0.85] as [number, number, number, number],
};

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly camera: Camera;
  private worldPass: WorldPass;
  private spritePass: SpritePass;
  private gridRef: Grid;

  constructor(
    readonly canvas: HTMLCanvasElement,
    grid: Grid,
  ) {
    this.gl = createContext(canvas);
    this.gridRef = grid;
    this.worldPass = new WorldPass(this.gl, grid);
    this.spritePass = new SpritePass(this.gl);
    this.camera = new Camera();
    this.resize();
  }

  dispose(): void {
    this.worldPass.dispose();
    this.spritePass.dispose();
  }

  /** Swap in a differently-sized level without rebuilding the GL context. */
  setGrid(grid: Grid): void {
    if (
      grid.width === this.gridRef.width &&
      grid.height === this.gridRef.height &&
      grid.cellSize === this.gridRef.cellSize
    ) {
      return;
    }
    this.worldPass.dispose();
    this.worldPass = new WorldPass(this.gl, grid);
    this.gridRef = grid;
  }

  uploadTerrain(terrain: Float32Array): void {
    this.worldPass.uploadTerrain(terrain);
  }

  uploadTerrainRegion(
    terrain: Float32Array,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): void {
    this.worldPass.uploadTerrainRegion(terrain, x0, y0, x1, y1);
  }

  /**
   * Match the drawing buffer to the CSS size. Device pixel ratio is capped at
   * 2: past that a phone is shading four times the pixels for a difference
   * nobody can see, and the water shader is the expensive part.
   */
  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
    this.camera.setViewport(width, height);
  }

  /** Screen pixels per CSS pixel, needed to map pointer events into the canvas. */
  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  render(scene: Scene): void {
    const gl = this.gl;
    gl.clearColor(0.055, 0.065, 0.085, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.worldPass.draw(scene.sim, this.camera, scene.time, scene.editorView);

    const { level } = scene;
    this.spritePass.begin(this.camera, scene.time);

    if (scene.editorView) {
      for (const s of level.sources) {
        this.spritePass.draw({
          shape: Shape.Source,
          x: s.x,
          y: s.y,
          size: Math.max(s.radius, 2),
          colour: COLOURS.source,
        });
      }
    }

    for (const o of level.obstacles) {
      this.spritePass.draw({
        shape: Shape.Rock,
        x: o.x,
        y: o.y,
        size: o.radius,
        colour: COLOURS.rock,
      });
    }

    if (level.goal) {
      this.spritePass.draw({
        shape: Shape.Goal,
        x: level.goal.x,
        y: level.goal.y,
        size: level.goal.radius,
        colour: COLOURS.goal,
      });
    }

    if (level.start && scene.editorView) {
      this.spritePass.draw({
        shape: Shape.Start,
        x: level.start.x,
        y: level.start.y,
        size: 3,
        rotation: level.start.heading,
        colour: COLOURS.start,
      });
    }

    if (scene.kayak) {
      const k = scene.kayak;
      const hurt = 1 - Math.min(1, k.health / 100);
      const colour: [number, number, number, number] = [
        COLOURS.kayak[0] + (COLOURS.kayakHurt[0] - COLOURS.kayak[0]) * hurt,
        COLOURS.kayak[1] + (COLOURS.kayakHurt[1] - COLOURS.kayak[1]) * hurt,
        COLOURS.kayak[2] + (COLOURS.kayakHurt[2] - COLOURS.kayak[2]) * hurt,
        1,
      ];
      // The shader reads the left flash from the units digit and the right from
      // the fraction, so both fit in one uniform.
      const param = Math.floor(k.strokeFlashLeft * 100) + Math.min(0.999, k.strokeFlashRight);
      this.spritePass.draw({
        shape: Shape.Kayak,
        x: k.x,
        y: k.y,
        size: 0.85,
        aspect: 2.1,
        rotation: k.heading,
        colour,
        param,
      });
    }

    if (scene.brush) {
      this.spritePass.draw({
        shape: Shape.Ring,
        x: scene.brush.x,
        y: scene.brush.y,
        size: scene.brush.radius,
        colour: scene.brush.valid ? COLOURS.brush : COLOURS.brushBad,
        param: 0.035,
      });
    }

    this.spritePass.end();
  }
}
