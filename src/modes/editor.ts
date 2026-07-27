import { GestureRecognizer } from '../input/gestures';
import type { Renderer, Scene } from '../render/renderer';
import { loadSettledWater, saveSettledWater } from '../storage';
import {
  type Level,
  SETTLE_DT,
  SettleRun,
  applySettledWater,
  buildSim,
  levelGrid,
  primeSim,
  toSimSources,
} from '../sim/level';
import {
  type BrushMode,
  type DirtyRect,
  applyBrush,
  generateFractalTerrain,
  unionRect,
} from '../sim/terrain';
import type { WaterSim } from '../sim/water';
import { button, clear, el, sheet, toast } from '../ui/dom';

/**
 * Level editor.
 *
 * Terrain tools paint continuously while a finger is down; entity tools place
 * a single object per tap. The water simulation runs the whole time, so the
 * effect of every stroke on the river is visible immediately - which is the
 * point of sculpting terrain rather than drawing a river directly.
 */

type Tool = 'raise' | 'lower' | 'smooth' | 'source' | 'start' | 'goal' | 'rock' | 'erase';

const TOOLS: Array<{ id: Tool; glyph: string; label: string }> = [
  { id: 'raise', glyph: '▲', label: 'Raise' },
  { id: 'lower', glyph: '▼', label: 'Lower' },
  { id: 'smooth', glyph: '≈', label: 'Smooth' },
  { id: 'source', glyph: '◉', label: 'Spring' },
  { id: 'start', glyph: '▶', label: 'Start' },
  { id: 'goal', glyph: '◎', label: 'Goal' },
  { id: 'rock', glyph: '⬢', label: 'Rock' },
  { id: 'erase', glyph: '✕', label: 'Erase' },
];

const TERRAIN_TOOLS = new Set<Tool>(['raise', 'lower', 'smooth']);

/** Terrain plus entities, captured before an edit so it can be undone. */
interface Snapshot {
  terrain: Float32Array;
  sources: Level['sources'];
  start: Level['start'];
  goal: Level['goal'];
  obstacles: Level['obstacles'];
}

const MAX_UNDO = 12;

/**
 * Ceiling on one fast-forward, in simulated seconds. Generous, because it is
 * the settle check that normally ends the run - this only catches the levels
 * that never settle at all.
 */
const BOOST_MAX_SECONDS = 300;

/**
 * Wall-clock milliseconds per frame to spend fast-forwarding.
 *
 * This is what actually governs how long a fill takes: the solver needs a
 * fixed amount of work done, and at this rate it needs work/budget frames to
 * get through it whatever the device. It sits above a frame's 16.7 ms because
 * three frames in four skip their redraw entirely (BOOST_RENDER_EVERY) and
 * have nothing else to spend the time on. Turn it down if a fill feels rough,
 * up if it feels slow - it trades smoothness for how soon the river is ready.
 */
const BOOST_FRAME_BUDGET_MS = 20;

/**
 * Redraw one frame in this many while fast-forwarding.
 *
 * On a weak GPU the picture costs far more than the solver - this sandbox
 * spends about 95 ms of a 105 ms frame drawing - so most of a fast-forward is
 * otherwise spent rendering frames nobody asked for. Every frame skipped here
 * goes to the water instead, and four is still fast enough to watch it fill.
 */
const BOOST_RENDER_EVERY = 4;

/**
 * Metres of level that must stay inside the visible strip when panning.
 *
 * Enough to see where you are and drag your way back, small enough that you can
 * still push the level right out to a corner to work on its edge.
 */
const KEEP_IN_VIEW_METRES = 24;

export interface EditorCallbacks {
  onExit(): void;
  onTest(level: Level): void;
  onSave(level: Level): Promise<void>;
}

export class EditorMode {
  readonly level: Level;
  readonly sim: WaterSim;

  private tool: Tool = 'raise';
  private brushRadius = 6;
  private brushStrength = 0.55;
  private gestures: GestureRecognizer;
  private undoStack: Snapshot[] = [];
  private dirty: DirtyRect | null = null;
  private brushCursor: { x: number; y: number } | null = null;
  private toolButtons = new Map<Tool, HTMLButtonElement>();
  private undoButton: HTMLButtonElement | null = null;
  private hintNode: HTMLElement | null = null;
  private unsavedChanges = false;
  private boost: SettleRun | null = null;
  private boostButton: HTMLButtonElement | null = null;
  /** Simulated seconds per slice, adapted to whatever this device can manage. */
  private boostSlice = 0.25;
  /** Milliseconds of fast-forward already spent in the current frame. */
  private boostSpentMs = 0;
  private boostFrame = 0;
  private panOnly = false;
  private panButton: HTMLButtonElement | null = null;
  private brushRow: HTMLElement | null = null;
  private topBarNode: HTMLElement | null = null;
  private dockNode: HTMLElement | null = null;
  private insetObserver: ResizeObserver | null = null;
  /** Set once the view has been panned or zoomed, so auto-framing backs off. */
  private viewTouched = false;

  constructor(
    level: Level,
    private renderer: Renderer,
    private ui: HTMLElement,
    private callbacks: EditorCallbacks,
  ) {
    this.level = level;
    this.sim = buildSim(level);
    // Open on a river that is already running. Waiting for the springs to fill
    // the valley in real time would mean minutes of staring at dry ground
    // before an edit shows you anything.
    primeSim(this.sim, toSimSources(level), { maxSeconds: 4 });
    // If this valley has been filled before, the settled river replaces the
    // primed one as soon as it inflates - a frame or two, not the seconds it
    // would take to compute again.
    void this.restoreSettledWater();

    this.renderer.setGrid(levelGrid(level));
    this.renderer.uploadTerrain(level.terrain);
    this.renderer.camera.coverLevelInFreeArea(levelGrid(level));

    this.gestures = new GestureRecognizer({
      onPaintStart: (x, y) => this.handlePointerDown(x, y),
      onPaintMove: (x, y) => this.handlePointerMove(x, y),
      onPaintEnd: (committed) => this.handlePointerUp(committed),
      onPanZoom: (dx, dy, scale, cx, cy) => this.handlePanZoom(dx, dy, scale, cx, cy),
      onHover: (x, y) => {
        const w = this.toWorld(x, y);
        this.brushCursor = w;
      },
    });
    this.gestures.attach(this.renderer.canvas);

    this.buildUi();
  }

  dispose(): void {
    this.boost = null;
    this.insetObserver?.disconnect();
    this.insetObserver = null;
    this.gestures.detach();
    clear(this.ui);
  }

  get hasUnsavedChanges(): boolean {
    return this.unsavedChanges;
  }

  // --- coordinate helpers ---------------------------------------------------

  /** CSS pixels from a pointer event to world metres. */
  private toWorld(cssX: number, cssY: number): { x: number; y: number } {
    const ratio = this.renderer.pixelRatio;
    const camera = this.renderer.camera;
    return {
      x: camera.screenToWorldX(cssX * ratio),
      y: camera.screenToWorldY(cssY * ratio),
    };
  }

  private inBounds(x: number, y: number): boolean {
    const g = levelGrid(this.level);
    return x >= 0 && y >= 0 && x <= g.width * g.cellSize && y <= g.height * g.cellSize;
  }

  // --- undo -----------------------------------------------------------------

  private pushUndo(): void {
    // A fast-forward is settling the ground as it stood when it started, and it
    // holds the spring list from then too. An edit invalidates both, so stop
    // rather than carry on settling terrain that no longer exists.
    if (this.boost) this.stopBoost('cancelled');

    this.undoStack.push({
      terrain: new Float32Array(this.level.terrain),
      sources: this.level.sources.map((s) => ({ ...s })),
      start: this.level.start ? { ...this.level.start } : null,
      goal: this.level.goal ? { ...this.level.goal } : null,
      obstacles: this.level.obstacles.map((o) => ({ ...o })),
    });
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.unsavedChanges = true;
    this.refreshUndoButton();
  }

  undo(): void {
    if (this.boost) this.stopBoost('cancelled');
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.level.terrain.set(snap.terrain);
    this.level.sources = snap.sources;
    this.level.start = snap.start;
    this.level.goal = snap.goal;
    this.level.obstacles = snap.obstacles;
    this.sim.terrain.set(snap.terrain);
    this.renderer.uploadTerrain(this.level.terrain);
    this.refreshUndoButton();
    this.refreshHint();
  }

  private refreshUndoButton(): void {
    if (this.undoButton) this.undoButton.disabled = this.undoStack.length === 0;
  }

  // --- input ----------------------------------------------------------------

  private handlePointerDown(cssX: number, cssY: number): void {
    const p = this.toWorld(cssX, cssY);
    this.brushCursor = p;
    if (!this.inBounds(p.x, p.y)) return;

    // Sculpting has to follow the finger, so it starts here. Placing an object
    // waits for the release: it is a single irreversible act, and committing it
    // on contact means a gesture that turns out to be a pinch has already done
    // it. See handlePointerUp.
    if (TERRAIN_TOOLS.has(this.tool)) {
      this.pushUndo();
      this.paint(p.x, p.y);
    }
  }

  private handlePointerMove(cssX: number, cssY: number): void {
    const p = this.toWorld(cssX, cssY);
    this.brushCursor = p;
    if (TERRAIN_TOOLS.has(this.tool) && this.inBounds(p.x, p.y)) {
      this.paint(p.x, p.y);
    }
  }

  private handlePointerUp(committed: boolean): void {
    const p = this.brushCursor;
    if (committed && !TERRAIN_TOOLS.has(this.tool) && p && this.inBounds(p.x, p.y)) {
      this.pushUndo();
      this.placeEntity(p.x, p.y);
      this.refreshHint();
    }
    // Flush whatever the stroke touched to the GPU in one upload.
    this.flushDirty();
  }

  private handlePanZoom(dx: number, dy: number, scale: number, cx: number, cy: number): void {
    this.viewTouched = true;
    const ratio = this.renderer.pixelRatio;
    const camera = this.renderer.camera;
    camera.panByScreen(dx * ratio, dy * ratio);
    if (Math.abs(scale - 1) > 0.0005) {
      camera.zoomAt(cx * ratio, cy * ratio, scale);
    }
    camera.keepLevelInView(levelGrid(this.level), KEEP_IN_VIEW_METRES);
  }

  private paint(worldX: number, worldY: number): void {
    const cellX = worldX / this.level.cellSize;
    const cellY = worldY / this.level.cellSize;
    const rect = applyBrush(
      this.level.terrain,
      levelGrid(this.level),
      cellX,
      cellY,
      this.brushRadius,
      this.brushStrength,
      this.tool as BrushMode,
    );
    if (!rect) return;

    // The solver reads terrain directly, so keep it in step with the edit.
    const { width } = this.level;
    for (let y = rect.y0; y <= rect.y1; y++) {
      const row = y * width;
      for (let x = rect.x0; x <= rect.x1; x++) {
        this.sim.terrain[row + x] = this.level.terrain[row + x];
      }
    }
    this.dirty = unionRect(this.dirty, rect);
    this.unsavedChanges = true;
  }

  private flushDirty(): void {
    if (!this.dirty) return;
    const { x0, y0, x1, y1 } = this.dirty;
    this.renderer.uploadTerrainRegion(this.level.terrain, x0, y0, x1, y1);
    this.dirty = null;
  }

  private placeEntity(x: number, y: number): void {
    switch (this.tool) {
      case 'source':
        if (this.level.sources.length >= 16) {
          toast(this.ui, 'That is plenty of springs.', true);
          return;
        }
        this.level.sources.push({
          x,
          y,
          rate: 0.25,
          radius: this.brushRadius * this.level.cellSize,
        });
        break;
      case 'start': {
        // Keep whatever heading was already set, so nudging the start doesn't
        // silently spin the boat round.
        const heading = this.level.start?.heading ?? Math.PI / 2;
        this.level.start = { x, y, heading };
        break;
      }
      case 'goal':
        this.level.goal = { x, y, radius: 7 };
        break;
      case 'rock':
        if (this.level.obstacles.length >= 200) {
          toast(this.ui, 'Rock limit reached.', true);
          return;
        }
        this.level.obstacles.push({ x, y, radius: 1.4 + Math.random() * 1.4 });
        break;
      case 'erase':
        this.eraseNear(x, y);
        break;
      default:
        break;
    }
    this.unsavedChanges = true;
  }

  /** Remove whichever placed object is nearest the tap, within the brush radius. */
  private eraseNear(x: number, y: number): void {
    const reach = Math.max(this.brushRadius * this.level.cellSize, 4);
    let bestDist = reach;
    let removal: (() => void) | null = null;

    this.level.obstacles.forEach((o, i) => {
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < bestDist) {
        bestDist = d;
        removal = () => this.level.obstacles.splice(i, 1);
      }
    });
    this.level.sources.forEach((s, i) => {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) {
        bestDist = d;
        removal = () => this.level.sources.splice(i, 1);
      }
    });
    if (this.level.goal) {
      const g = this.level.goal;
      const d = Math.hypot(g.x - x, g.y - y);
      if (d < bestDist) {
        bestDist = d;
        removal = () => (this.level.goal = null);
      }
    }
    if (this.level.start) {
      const s = this.level.start;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) {
        bestDist = d;
        removal = () => (this.level.start = null);
      }
    }

    if (removal) (removal as () => void)();
    else toast(this.ui, 'Nothing here to erase.');
  }

  // --- loop -----------------------------------------------------------------

  update(dt: number): void {
    if (this.boost) {
      this.advanceBoost();
    } else {
      this.sim.applySources(toSimSources(this.level), dt);
      this.sim.step(dt);
    }
    // Painting uploads on stroke end, but a long drag should still show up.
    if (this.dirty) this.flushDirty();
  }

  // --- fast-forward ---------------------------------------------------------

  /**
   * Run the water forward far faster than real time until it settles.
   *
   * A valley can need minutes of simulation to fill, which is not something to
   * sit and watch at 1x. This spends part of each frame on extra solver steps
   * instead, so the river fills in front of you and the editor stays usable.
   */
  private startBoost(): void {
    if (this.boost) {
      this.stopBoost('cancelled');
      return;
    }
    if (this.level.sources.length === 0) {
      toast(this.ui, 'Place a spring first — there is nothing to fill the river.');
      return;
    }
    this.boost = new SettleRun(this.sim, toSimSources(this.level), {
      maxSeconds: BOOST_MAX_SECONDS,
    });
    this.refreshBoostButton();
    this.refreshHint();
  }

  private advanceBoost(): void {
    const boost = this.boost;
    if (!boost) return;

    // The app runs several fixed-step updates per frame when it is behind, and
    // the budget is per *frame* - without this the boost would take that many
    // budgets each time the frame rate dropped, which is exactly when it can
    // least afford to.
    if (this.boostSpentMs >= BOOST_FRAME_BUDGET_MS) return;

    const started = performance.now();
    boost.advance(this.boostSlice);
    const cost = performance.now() - started;
    this.boostSpentMs += cost;

    // Re-aim the slice at one frame budget's worth of work, so a fast phone
    // fast-forwards faster and a slow one still renders while it does.
    if (cost > 0.5) {
      const scaled = (this.boostSlice * BOOST_FRAME_BUDGET_MS) / cost;
      this.boostSlice = Math.min(4, Math.max(SETTLE_DT, scaled));
    }

    if (boost.done) this.stopBoost('done');
    else this.refreshHint();
  }

  /** Skip most redraws while filling — see BOOST_RENDER_EVERY. */
  skipRender(): boolean {
    if (!this.boost) return false;
    return this.boostFrame % BOOST_RENDER_EVERY !== 0;
  }

  private stopBoost(reason: 'done' | 'cancelled'): void {
    const report = this.boost?.report;
    this.boost = null;
    this.refreshBoostButton();
    this.refreshHint();
    if (!report) return;

    const seconds = Math.round(report.seconds);
    if (reason === 'cancelled') {
      toast(this.ui, `Stopped after ${seconds} s of fast-forward.`);
    } else if (report.settled) {
      // Worth keeping: this is the expensive result, and nothing about the
      // level has changed since it was computed.
      void saveSettledWater(this.level, this.sim.depth);
      toast(this.ui, `River settled after ${seconds} s — saved for next time.`);
    } else {
      toast(this.ui, `Fast-forwarded ${seconds} s — still filling.`);
    }
  }

  /**
   * Swap in a previously settled river, if one was stored for this exact
   * terrain and springs.
   *
   * Inflating is asynchronous, so an edit could in principle land first. The
   * fingerprint would reject the field in that case, but a fill in progress
   * would not - it is mid-run on the water this would overwrite.
   */
  private async restoreSettledWater(): Promise<void> {
    const depth = await loadSettledWater(this.level);
    if (!depth || this.boost || this.hasUnsavedChanges) return;
    applySettledWater(this.sim, toSimSources(this.level), depth);
  }

  private refreshBoostButton(): void {
    if (!this.boostButton) return;
    this.boostButton.textContent = this.boost ? 'Stop ⏹' : 'Fill ⏩';
    this.boostButton.setAttribute('aria-pressed', String(this.boost !== null));
  }

  buildScene(time: number): Scene {
    // Runs exactly once per frame, after that frame's updates, so this is where
    // the fast-forward's per-frame budget turns over.
    this.boostSpentMs = 0;
    this.boostFrame++;

    return {
      level: this.level,
      sim: this.sim,
      time,
      editorView: true,
      brush: this.brushCursor
        ? {
            x: this.brushCursor.x,
            y: this.brushCursor.y,
            radius: TERRAIN_TOOLS.has(this.tool)
              ? this.brushRadius * this.level.cellSize
              : Math.max(2, this.level.cellSize),
            valid: this.inBounds(this.brushCursor.x, this.brushCursor.y),
          }
        : undefined,
    };
  }

  // --- ui -------------------------------------------------------------------

  private setTool(tool: Tool): void {
    // Reaching for a tool is itself the decision to stop moving the view, so
    // don't make it a second tap on the Move button first.
    if (this.panOnly) this.setPanOnly(false);
    this.tool = tool;
    for (const [id, btn] of this.toolButtons) {
      btn.setAttribute('aria-pressed', String(id === tool));
    }
    this.refreshToolPanels();
    this.refreshHint();
  }

  private refreshHint(): void {
    if (!this.hintNode) return;

    if (this.boost) {
      // The elapsed count is the point: it says how much river-time the valley
      // has had, which is the thing you're waiting on.
      this.hintNode.textContent = `Filling — ${Math.round(this.boost.report.seconds)} s of river time…`;
      return;
    }

    const missing: string[] = [];
    if (this.level.sources.length === 0) missing.push('a spring');
    if (!this.level.start) missing.push('a start');
    if (!this.level.goal) missing.push('a goal');

    if (missing.length > 0) {
      this.hintNode.textContent = `Add ${missing.join(', ')} to make this playable.`;
    } else {
      this.hintNode.textContent = this.panOnly
        ? 'Move mode — drag to pan, pinch to zoom. Nothing you do here edits.'
        : 'One finger sculpts · two fingers pan and zoom.';
    }
  }

  private buildUi(): void {
    clear(this.ui);

    const titleText = el('div', { class: 'title-text', text: this.level.name });
    titleText.addEventListener('click', () => this.promptRename(titleText));

    const undoBtn = button('↶', () => this.undo(), { class: 'ghost', title: 'Undo' });
    undoBtn.disabled = true;
    this.undoButton = undoBtn;

    const topBar = el('div', { class: 'top-bar' }, [
      button('‹', () => this.confirmExit(), { class: 'ghost', title: 'Back' }),
      titleText,
      undoBtn,
      button('Save', () => void this.save(), { class: 'primary' }),
    ]);

    const toolRow = el('div', { class: 'tool-row' });
    for (const t of TOOLS) {
      const btn = el('button', {
        'aria-pressed': String(t.id === this.tool),
        onClick: () => this.setTool(t.id),
      }, [el('span', { class: 'glyph', text: t.glyph }), el('span', { text: t.label })]);
      this.toolButtons.set(t.id, btn);
      toolRow.append(btn);
    }

    const panBtn = el('button', {
      class: 'pan-toggle',
      'aria-pressed': 'false',
      title: 'Pan and zoom without editing',
      onClick: () => this.setPanOnly(!this.panOnly),
    }, [el('span', { class: 'glyph', text: '✋' }), el('span', { text: 'Move' })]);
    this.panButton = panBtn;
    toolRow.append(panBtn);

    const sizeInput = el('input', {
      type: 'range',
      min: '2',
      max: '20',
      step: '1',
      value: String(this.brushRadius),
      onInput: (e: Event) => {
        this.brushRadius = Number((e.target as HTMLInputElement).value);
      },
    });

    const strengthInput = el('input', {
      type: 'range',
      min: '10',
      max: '150',
      step: '5',
      value: String(Math.round(this.brushStrength * 100)),
      onInput: (e: Event) => {
        this.brushStrength = Number((e.target as HTMLInputElement).value) / 100;
      },
    });

    this.hintNode = el('div', { class: 'hint' });

    const boostBtn = button('Fill ⏩', () => this.startBoost(), {
      class: 'ghost',
      title: 'Run the water forward until it settles',
    });
    this.boostButton = boostBtn;

    // Brush settings mean nothing for placing a rock or panning the view, and
    // they are the tallest thing in the dock. Showing them only when they apply
    // hands the map back most of that space for most of the time.
    const brushRow = el('div', { class: 'brush-row' }, [
      el('label', { text: 'Size' }),
      sizeInput,
      el('label', { text: 'Force' }),
      strengthInput,
    ]);
    this.brushRow = brushRow;

    const dock = el('div', { class: 'bottom-dock' }, [
      this.hintNode,
      toolRow,
      brushRow,
      el('div', { class: 'row' }, [
        button('⛰', () => this.promptGenerate(), {
          class: 'ghost',
          title: 'Generate fractal terrain',
        }),
        button('Reset water', () => {
          if (this.boost) this.stopBoost('cancelled');
          this.sim.clearWater();
          toast(this.ui, 'Water cleared — the springs will refill it.');
        }, { class: 'ghost' }),
        boostBtn,
        el('div', { class: 'spacer' }),
        button('Test run ▶', () => this.testRun(), { class: 'primary' }),
      ]),
    ]);

    this.ui.append(topBar, dock);
    this.topBarNode = topBar;
    this.dockNode = dock;

    // The dock changes height as tools come and go, and the camera's idea of
    // the free strip has to follow it or the level drifts back under the UI.
    this.insetObserver = new ResizeObserver(() => this.updateViewInsets());
    this.insetObserver.observe(dock);
    this.insetObserver.observe(topBar);

    this.refreshToolPanels();
    this.refreshHint();
  }

  /**
   * Tell the camera how much of the screen the UI is covering.
   *
   * The dock does not exist when the camera is first framed, so the opening
   * view is re-framed here once there is something to measure. After that it
   * only re-frames while the view is untouched: a dock that changes height must
   * not yank a view the person has positioned themselves.
   */
  private updateViewInsets(): void {
    const ratio = this.renderer.pixelRatio;
    const top = this.topBarNode ? this.topBarNode.getBoundingClientRect().height : 0;
    const bottom = this.dockNode ? this.dockNode.getBoundingClientRect().height : 0;
    this.renderer.camera.setInsets(top * ratio, bottom * ratio);
    // The toast has to clear the dock, and the dock's height depends on which
    // tool is selected, so it is published rather than guessed at in the CSS.
    this.ui.style.setProperty('--dock-height', `${Math.round(bottom)}px`);
    if (!this.viewTouched) this.renderer.camera.coverLevelInFreeArea(levelGrid(this.level));
  }

  /** Show only the controls the current tool actually uses. */
  private refreshToolPanels(): void {
    if (!this.brushRow) return;
    const wanted = !this.panOnly && TERRAIN_TOOLS.has(this.tool);
    this.brushRow.hidden = !wanted;
  }

  /**
   * Pan-only mode: one finger moves the view instead of sculpting.
   *
   * It deliberately does not change the selected tool, so turning it off puts
   * you back on the brush you were using with the settings you had.
   */
  private setPanOnly(on: boolean): void {
    this.panOnly = on;
    this.gestures.singlePointerPans = on;
    this.brushCursor = null;
    this.panButton?.setAttribute('aria-pressed', String(on));
    this.refreshToolPanels();
    this.refreshHint();
  }

  /**
   * Roll a fresh landscape to carve a river out of.
   *
   * Every press generates a new one, and each is a normal undoable edit, so
   * rolling through a few and stepping back to the one you liked is the point
   * rather than a workaround.
   */
  private promptGenerate(): void {
    let relief = 18;
    let scale = 0.35;

    const reliefInput = el('input', {
      type: 'range',
      min: '4',
      max: '36',
      step: '1',
      value: String(relief),
      onInput: (e: Event) => {
        relief = Number((e.target as HTMLInputElement).value);
      },
    });
    const scaleInput = el('input', {
      type: 'range',
      min: '10',
      max: '90',
      step: '5',
      value: String(Math.round(scale * 100)),
      onInput: (e: Event) => {
        scale = Number((e.target as HTMLInputElement).value) / 100;
      },
    });

    const close = sheet(this.ui, {
      title: 'Generate terrain',
      body: [
        el('p', {
          class: 'result-note',
          text: 'Fractal noise tilted down the map, so the water has somewhere to run. Generate as many as you like — each one can be undone.',
        }),
        el('div', { class: 'slider-row' }, [el('label', { text: 'Relief' }), reliefInput]),
        el('div', { class: 'slider-row' }, [el('label', { text: 'Scale' }), scaleInput]),
      ],
      actions: [
        {
          label: 'Generate',
          class: 'primary',
          onClick: () => this.generateTerrain(relief, scale),
        },
        { label: 'Done', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
  }

  private generateTerrain(relief: number, scale: number): void {
    this.pushUndo();
    const seed = Math.floor(Math.random() * 1e9);
    const generated = generateFractalTerrain(levelGrid(this.level), { seed, relief, scale });

    this.level.terrain.set(generated);
    this.sim.terrain.set(generated);
    this.renderer.uploadTerrain(this.level.terrain);

    // The old river belonged to the old ground. Start the new one from scratch.
    this.sim.clearWater();
    primeSim(this.sim, toSimSources(this.level), { maxSeconds: 4 });
    toast(this.ui, 'New terrain — press Fill to see where the water goes.');
  }

  private promptRename(titleNode: HTMLElement): void {
    const input = el('input', { type: 'text', value: this.level.name, maxlength: '48' });
    const close = sheet(this.ui, {
      title: 'Level name',
      body: [input],
      actions: [
        {
          label: 'Save name',
          class: 'primary',
          onClick: () => {
            const name = input.value.trim();
            if (name) {
              this.level.name = name;
              titleNode.textContent = name;
              this.unsavedChanges = true;
            }
            close();
          },
        },
        { label: 'Cancel', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
    input.focus();
    input.select();
  }

  private testRun(): void {
    if (!this.level.start || !this.level.goal) {
      toast(this.ui, 'Place a start and a goal first.', true);
      return;
    }
    this.callbacks.onTest(this.level);
  }

  private async save(): Promise<void> {
    this.level.updatedAt = Date.now();
    try {
      await this.callbacks.onSave(this.level);
      // Keep the river with it. A level opened from the list otherwise plays on
      // whatever a few seconds of priming manages, which is a nearly dry valley
      // however long you spent filling this one.
      await saveSettledWater(this.level, this.sim.depth);
      this.unsavedChanges = false;
      toast(this.ui, 'Saved.');
    } catch (err) {
      toast(this.ui, err instanceof Error ? err.message : 'Could not save.', true);
    }
  }

  private confirmExit(): void {
    if (!this.unsavedChanges) {
      this.callbacks.onExit();
      return;
    }
    const close = sheet(this.ui, {
      title: 'Leave without saving?',
      body: [el('p', { class: 'result-note', text: 'This level has changes you have not saved.' })],
      actions: [
        {
          label: 'Save and leave',
          class: 'primary',
          onClick: () => {
            void this.save().then(() => {
              close();
              this.callbacks.onExit();
            });
          },
        },
        {
          label: 'Discard changes',
          class: 'danger',
          onClick: () => {
            close();
            this.callbacks.onExit();
          },
        },
        { label: 'Keep editing', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
  }
}
