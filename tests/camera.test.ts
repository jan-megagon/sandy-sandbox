import { describe, expect, it } from 'vitest';
import { Camera } from '../src/render/camera';

const GRID = { width: 128, height: 128, cellSize: 2 };
const WORLD = GRID.width * GRID.cellSize;

/** A tall phone in device pixels, with an editor's chrome over it. */
function editorCamera(): Camera {
  const camera = new Camera(780, 1328);
  camera.setInsets(120, 416);
  return camera;
}

describe('Camera free area', () => {
  it('measures the strip the UI leaves', () => {
    const camera = editorCamera();
    expect(camera.freeHeight).toBe(1328 - 120 - 416);
    // The free strip's centre sits above the canvas centre when the bottom
    // dock is the taller of the two.
    expect(camera.freeOffsetY).toBeLessThan(0);
  });

  it('frames the level in the free strip, not behind the dock', () => {
    const camera = editorCamera();
    camera.coverLevelInFreeArea(GRID);

    const centreOnScreen = camera.worldToScreenY(WORLD / 2);
    const freeCentre = 120 + camera.freeHeight / 2;
    // This is the whole point of the exercise: the middle of the valley lands
    // in the middle of what you can see.
    expect(centreOnScreen).toBeCloseTo(freeCentre, 3);
    // And that is emphatically not the middle of the canvas.
    expect(Math.abs(centreOnScreen - 1328 / 2)).toBeGreaterThan(100);
  });

  it('leaves the level centred on the canvas when nothing is covering it', () => {
    const camera = new Camera(780, 1328);
    camera.coverLevelInFreeArea(GRID);
    expect(camera.worldToScreenY(WORLD / 2)).toBeCloseTo(1328 / 2, 3);
  });

  it('lets a zoomed-out level be panned off centre', () => {
    const camera = editorCamera();
    camera.coverLevelInFreeArea(GRID);
    const before = camera.freeCentreWorldY;

    camera.panByScreen(0, -200);
    camera.keepLevelInView(GRID, 24);

    // clampToLevel would have snapped this straight back; the editor needs to
    // be able to push the level up out from under its own toolbar.
    expect(camera.freeCentreWorldY).not.toBeCloseTo(before, 1);
  });

  it('always keeps a slice of the level in the free strip', () => {
    const camera = editorCamera();
    camera.coverLevelInFreeArea(GRID);

    for (const [dx, dy] of [
      [9000, 0],
      [-9000, 0],
      [0, 9000],
      [0, -9000],
      [9000, 9000],
    ]) {
      camera.panByScreen(dx, dy);
      camera.keepLevelInView(GRID, 24);

      const left = camera.worldToScreenX(0);
      const right = camera.worldToScreenX(WORLD);
      const top = camera.worldToScreenY(0);
      const bottom = camera.worldToScreenY(WORLD);

      const visibleW = Math.min(right, camera.viewWidth) - Math.max(left, 0);
      const visibleH = Math.min(bottom, camera.viewHeight - 416) - Math.max(top, 120);
      // 24 m at the current zoom, give or take a rounding error.
      const wanted = 24 * camera.zoom - 1;
      expect(visibleW).toBeGreaterThan(wanted);
      expect(visibleH).toBeGreaterThan(wanted);
    }
  });

  it('does not demand more overlap than the level has to give', () => {
    const camera = editorCamera();
    const tiny = { width: 4, height: 4, cellSize: 2 };
    camera.coverLevelInFreeArea(tiny);
    camera.panByScreen(9000, 9000);
    // A level smaller than the margin must still be reachable rather than
    // pinned by a constraint it can never satisfy.
    expect(() => camera.keepLevelInView(tiny, 24)).not.toThrow();
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(Number.isFinite(camera.y)).toBe(true);
  });
});
