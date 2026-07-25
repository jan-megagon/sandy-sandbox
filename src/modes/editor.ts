import { GestureRecognizer } from '../input/gestures';
import type { Renderer, Scene } from '../render/renderer';
import { type Level, SettleRun, buildSim, levelGrid, primeSim, toSimSources } from '../sim/level';
import { type BrushMode, type DirtyRect, applyBrush, unionRect } from '../sim/terrain';
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
 * Wall-clock milliseconds per frame to spend fast-forwarding. Kept under a
 * frame so the river is visibly filling while it runs; blocking on the whole
 * job would freeze the editor for seconds and show nothing until it finished.
 */
const BOOST_FRAME_BUDGET_MS = 10;

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
  /** Simulated seconds per frame, adapted to whatever this device can manage. */
  private boostSlice = 0.25;

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

    this.renderer.setGrid(levelGrid(level));
    this.renderer.uploadTerrain(level.terrain);
    this.renderer.camera.coverLevel(levelGrid(level));

    this.gestures = new GestureRecognizer({
      onPaintStart: (x, y) => this.handlePointerDown(x, y),
      onPaintMove: (x, y) => this.handlePointerMove(x, y),
      onPaintEnd: () => this.handlePointerUp(),
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

    this.pushUndo();

    if (TERRAIN_TOOLS.has(this.tool)) {
      this.paint(p.x, p.y);
    } else {
      this.placeEntity(p.x, p.y);
      this.refreshHint();
    }
  }

  private handlePointerMove(cssX: number, cssY: number): void {
    const p = this.toWorld(cssX, cssY);
    this.brushCursor = p;
    if (TERRAIN_TOOLS.has(this.tool) && this.inBounds(p.x, p.y)) {
      this.paint(p.x, p.y);
    }
  }

  private handlePointerUp(): void {
    // Flush whatever the stroke touched to the GPU in one upload.
    this.flushDirty();
  }

  private handlePanZoom(dx: number, dy: number, scale: number, cx: number, cy: number): void {
    const ratio = this.renderer.pixelRatio;
    const camera = this.renderer.camera;
    camera.panByScreen(dx * ratio, dy * ratio);
    if (Math.abs(scale - 1) > 0.0005) {
      camera.zoomAt(cx * ratio, cy * ratio, scale);
    }
    camera.clampToLevel(levelGrid(this.level), 60);
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

    const started = performance.now();
    boost.advance(this.boostSlice);
    const cost = performance.now() - started;

    // Re-aim the slice at one frame budget's worth of work, so a fast phone
    // fast-forwards faster and a slow one still renders while it does.
    if (cost > 0.5) {
      const scaled = (this.boostSlice * BOOST_FRAME_BUDGET_MS) / cost;
      this.boostSlice = Math.min(4, Math.max(0.05, scaled));
    }

    if (boost.done) this.stopBoost('done');
    else this.refreshHint();
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
      toast(this.ui, `River settled after ${seconds} s.`);
    } else {
      toast(this.ui, `Fast-forwarded ${seconds} s — still filling.`);
    }
  }

  private refreshBoostButton(): void {
    if (!this.boostButton) return;
    this.boostButton.textContent = this.boost ? 'Stop ⏹' : 'Fill ⏩';
    this.boostButton.setAttribute('aria-pressed', String(this.boost !== null));
  }

  buildScene(time: number): Scene {
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
    this.tool = tool;
    for (const [id, btn] of this.toolButtons) {
      btn.setAttribute('aria-pressed', String(id === tool));
    }
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
      this.hintNode.textContent = 'One finger sculpts · two fingers pan and zoom.';
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

    const dock = el('div', { class: 'bottom-dock' }, [
      this.hintNode,
      toolRow,
      el('div', { class: 'slider-row' }, [el('label', { text: 'Size' }), sizeInput]),
      el('div', { class: 'slider-row' }, [el('label', { text: 'Force' }), strengthInput]),
      el('div', { class: 'row' }, [
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
    this.refreshHint();
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
