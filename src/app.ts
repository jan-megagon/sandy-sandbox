import { EditorMode } from './modes/editor';
import { PlayMode } from './modes/play';
import { Renderer, type Scene } from './render/renderer';
import { createDemoLevel } from './levels/demo';
import {
  type Level,
  buildSim,
  cloneLevel,
  createLevel,
  decodeLevel,
  encodeLevel,
  isPlayable,
  levelGrid,
  newId,
  primeSim,
  toSimSources,
} from './sim/level';
import type { WaterSim } from './sim/water';
import {
  deleteLevel,
  hasLevel,
  listLevels,
  loadLevel,
  saveLevel,
} from './storage';
import { type Session, formatTime } from './game/session';
import { button, clear, el, formatRelativeTime, sheet, toast } from './ui/dom';

/** A screen that owns the UI layer and contributes a scene to the render loop. */
interface AppMode {
  update(dt: number): void;
  buildScene(time: number): Scene;
  dispose(): void;
}

/**
 * Handles on the live session and editor, for the browser smoke test in
 * scripts/smoke.mjs. Reading simulation state is the only way an automated
 * check can tell "the boat moved" from "a picture of a boat".
 */
declare global {
  interface Window {
    __session?: Session;
    __editor?: EditorMode;
  }
}

const FIXED_STEP = 1 / 60;

/**
 * Screen router and frame loop.
 *
 * There is exactly one canvas, one WebGL context and one loop for the whole
 * app; screens swap the mode driving it. Menus render over a live river rather
 * than a static image, which costs nothing extra since the loop is running
 * anyway.
 */
export class App {
  private renderer: Renderer;
  private ui: HTMLElement;
  private mode: AppMode;
  private accumulator = 0;
  private lastFrame = 0;
  private clock = 0;
  private running = true;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement, backdrop: Level) {
    this.ui = ui;
    this.renderer = new Renderer(canvas, levelGrid(backdrop));
    this.mode = new BackdropMode(backdrop, this.renderer);

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.renderer.onContextLost = () => this.handleContextLost();

    this.showMenu();
    requestAnimationFrame(this.frame);
  }

  private onResize = (): void => {
    this.renderer.resize();
  };

  /**
   * The GPU took the context away and every GL object with it. Rebuilding the
   * whole renderer mid-run would silently lose an in-progress attempt, so stop
   * and hand the choice to the player.
   */
  private handleContextLost(): void {
    this.running = false;
    clear(this.ui);
    this.ui.append(
      el('div', { class: 'screen' }, [
        el('div', { class: 'spacer' }),
        el('h1', { class: 'title', text: 'Graphics interrupted' }),
        el('p', {
          class: 'subtitle',
          text: 'The browser reclaimed the graphics context, which can happen after the app has been in the background for a while. Reload to carry on - your saved levels are untouched.',
        }),
        el('div', { class: 'spacer' }),
        button('Reload', () => location.reload(), { class: 'primary' }),
      ]),
    );
  }

  private onVisibility = (): void => {
    // Coming back from the background must not deliver one enormous timestep.
    if (!document.hidden) this.lastFrame = performance.now();
  };

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    if (this.lastFrame === 0) this.lastFrame = now;
    const frameDt = Math.min((now - this.lastFrame) / 1000, 0.25);
    this.lastFrame = now;
    this.clock += frameDt;

    this.accumulator += frameDt;
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < 6) {
      this.mode.update(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    // If we fell far behind, drop the backlog rather than spiralling.
    if (this.accumulator > FIXED_STEP * 6) this.accumulator = 0;

    this.renderer.render(this.mode.buildScene(this.clock));
  };

  /**
   * Swap screens. The outgoing mode must be torn down *before* the incoming
   * one is built: every mode clears the shared UI layer on dispose, so
   * constructing first would have the old mode wipe the new one's HUD.
   */
  private setMode(create: () => AppMode): void {
    this.mode.dispose();
    this.mode = create();
  }

  // --- screens --------------------------------------------------------------

  showMenu(): void {
    // Grab the backdrop level from the outgoing mode before it is torn down.
    const backdrop = this.mode.buildScene(0).level;
    this.setMode(() => new BackdropMode(backdrop, this.renderer));
    clear(this.ui);

    const screen = el('div', { class: 'screen' }, [
      el('div', { class: 'spacer' }),
      el('h1', { class: 'title', html: 'River <span>Kayak</span>' }),
      el('p', {
        class: 'subtitle',
        text: 'Sculpt a valley and watch the water find its way down it. Then get in a boat and paddle the river you made.',
      }),
      el('div', { class: 'spacer' }),
      el('div', { class: 'stack' }, [
        button('Play', () => this.showLevelSelect(), { class: 'primary' }),
        button('Level editor', () => this.showLevelSelect(true)),
        button('How to paddle', () => this.showHelp(), { class: 'ghost' }),
      ]),
    ]);
    this.ui.append(screen);
  }

  private showHelp(): void {
    const close = sheet(this.ui, {
      title: 'How to paddle',
      body: [
        el('p', {
          class: 'result-note',
          html:
            '<b>Tap</b> the left or right half of the screen for a paddle stroke on that side. ' +
            'A stroke pushes you forward and turns the bow <i>away</i> from the side you paddled, ' +
            'so alternating taps runs you straight.<br><br>' +
            '<b>Hold</b> a side to plant the paddle. That brakes and pivots you towards that side — ' +
            'it is how you hold a line across the current or swing round a rock.<br><br>' +
            'The current is real: it comes from the shape of the land. Read where the water runs ' +
            'fast and use it.',
        }),
      ],
      actions: [{ label: 'Got it', class: 'primary', onClick: () => close() }],
      onDismiss: () => close(),
    });
  }

  showLevelSelect(editing = false): void {
    clear(this.ui);
    const list = el('ul', { class: 'level-list' });
    const summaries = listLevels();

    if (summaries.length === 0) {
      list.append(el('li', { class: 'empty-note', text: 'No levels yet. Create one below.' }));
    }

    for (const summary of summaries) {
      const actions = el('div', { class: 'actions' });

      if (summary.playable) {
        actions.append(
          button('▶', () => void this.startPlay(summary.id), {
            class: 'primary',
            title: `Play ${summary.name}`,
          }),
        );
      }
      actions.append(
        button('✎', () => void this.startEdit(summary.id), { title: `Edit ${summary.name}` }),
      );
      actions.append(
        button('⋯', () => this.showLevelActions(summary.id, summary.name), {
          class: 'ghost',
          title: 'More',
        }),
      );

      const sub = [
        summary.playable ? null : 'Needs a start and goal',
        summary.bestMs !== undefined ? `Best ${formatTime(summary.bestMs)}` : null,
        formatRelativeTime(summary.updatedAt),
      ]
        .filter(Boolean)
        .join(' · ');

      list.append(
        el('li', { class: 'level-card' }, [
          el('div', { class: 'meta' }, [
            el('div', { class: 'name', text: summary.name }),
            el('div', { class: 'sub', text: sub }),
          ]),
          actions,
        ]),
      );
    }

    const screen = el('div', { class: 'screen' }, [
      el('div', { class: 'row' }, [
        button('‹', () => this.showMenu(), { class: 'ghost' }),
        el('h1', { class: 'title', style: 'font-size:26px', text: editing ? 'Edit' : 'Levels' }),
      ]),
      list,
      el('div', { class: 'spacer' }),
      el('div', { class: 'stack' }, [
        button('New level', () => void this.startNewLevel(), { class: 'primary' }),
        button('Paste a share code', () => this.showImport(), { class: 'ghost' }),
      ]),
    ]);
    this.ui.append(screen);
  }

  private showLevelActions(id: string, name: string): void {
    const close = sheet(this.ui, {
      title: name,
      actions: [
        {
          label: 'Share',
          onClick: () => {
            close();
            void this.showShare(id, name);
          },
        },
        {
          label: 'Duplicate',
          onClick: () => {
            close();
            void this.duplicate(id);
          },
        },
        {
          label: 'Delete',
          class: 'danger',
          onClick: () => {
            close();
            this.confirmDelete(id, name);
          },
        },
        { label: 'Cancel', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
  }

  private confirmDelete(id: string, name: string): void {
    const close = sheet(this.ui, {
      title: `Delete "${name}"?`,
      body: [el('p', { class: 'result-note', text: 'This cannot be undone.' })],
      actions: [
        {
          label: 'Delete',
          class: 'danger',
          onClick: () => {
            deleteLevel(id);
            close();
            this.showLevelSelect();
            toast(this.ui, 'Level deleted.');
          },
        },
        { label: 'Keep', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
  }

  private async duplicate(id: string): Promise<void> {
    const level = await loadLevel(id);
    if (!level) {
      toast(this.ui, 'Could not open that level.', true);
      return;
    }
    const copy = cloneLevel(level);
    copy.id = newId();
    copy.name = `${level.name} copy`;
    copy.updatedAt = Date.now();
    await saveLevel(copy);
    this.showLevelSelect();
  }

  private async showShare(id: string, name: string): Promise<void> {
    const level = await loadLevel(id);
    if (!level) {
      toast(this.ui, 'Could not open that level.', true);
      return;
    }
    const code = await encodeLevel(level);
    const url = `${location.origin}${location.pathname}#code=${code}`;

    const area = el('textarea', { readonly: 'true' });
    area.value = code;

    const copy = async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(this.ui, `${label} copied.`);
      } catch {
        // Clipboard access is often blocked without a user gesture or on http.
        area.value = text;
        area.focus();
        area.select();
        toast(this.ui, 'Select the text above and copy it.', true);
      }
    };

    const close = sheet(this.ui, {
      title: `Share "${name}"`,
      body: [
        el('p', {
          class: 'result-note',
          text: 'Anyone who opens this link gets a copy of the level, terrain and all.',
        }),
        area,
      ],
      actions: [
        { label: 'Copy link', class: 'primary', onClick: () => void copy(url, 'Link') },
        { label: 'Copy code only', onClick: () => void copy(code, 'Code') },
        ...(navigator.share
          ? [
              {
                label: 'Share…',
                onClick: () => {
                  void navigator.share?.({ title: `River Kayak: ${name}`, url }).catch(() => {});
                },
              },
            ]
          : []),
        { label: 'Done', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
  }

  private showImport(): void {
    const area = el('textarea', { placeholder: 'Paste a share code or link here' });
    const close = sheet(this.ui, {
      title: 'Import a level',
      body: [area],
      actions: [
        {
          label: 'Import',
          class: 'primary',
          onClick: () => {
            const text = area.value.trim();
            close();
            void this.importCode(text);
          },
        },
        { label: 'Cancel', onClick: () => close() },
      ],
      onDismiss: () => close(),
    });
    area.focus();
  }

  /** Accepts a bare code or a full share URL. */
  async importCode(raw: string): Promise<boolean> {
    const text = raw.trim();
    if (!text) return false;
    const code = text.includes('#code=') ? text.slice(text.indexOf('#code=') + 6) : text;

    try {
      const level = await decodeLevel(code);
      // Never overwrite an existing level with an imported one of the same id.
      if (hasLevel(level.id)) level.id = newId();
      level.updatedAt = Date.now();
      await saveLevel(level);
      this.showLevelSelect();
      toast(this.ui, `Imported "${level.name}".`);
      return true;
    } catch (err) {
      toast(this.ui, err instanceof Error ? err.message : 'That code could not be read.', true);
      return false;
    }
  }

  private async startNewLevel(): Promise<void> {
    const level = createLevel('New river');
    await saveLevel(level);
    this.openEditor(level);
  }

  private async startEdit(id: string): Promise<void> {
    const level = await loadLevel(id);
    if (!level) {
      toast(this.ui, 'Could not open that level.', true);
      return;
    }
    this.openEditor(level);
  }

  private openEditor(level: Level): void {
    let mode!: EditorMode;
    this.setMode(() => {
      mode = new EditorMode(level, this.renderer, this.ui, {
        onExit: () => this.showLevelSelect(),
        onTest: (l) => this.openPlay(l, true),
        onSave: (l) => saveLevel(l),
      });
      return mode;
    });
    window.__editor = mode;
    window.__session = undefined;
  }

  private async startPlay(id: string): Promise<void> {
    const level = await loadLevel(id);
    if (!level) {
      toast(this.ui, 'Could not open that level.', true);
      return;
    }
    if (!isPlayable(level)) {
      toast(this.ui, 'That level still needs a start and a goal.', true);
      return;
    }
    this.openPlay(level, false);
  }

  private openPlay(level: Level, fromEditor: boolean): void {
    let mode!: PlayMode;
    this.setMode(() => {
      mode = new PlayMode(level, this.renderer, this.ui, {
        onExit: () => this.showLevelSelect(),
        onEditAgain: fromEditor ? () => this.openEditor(level) : undefined,
      });
      return mode;
    });
    window.__session = mode.session;
    window.__editor = undefined;
  }
}

/**
 * The live river behind the menus. It runs the simulation at a reduced rate -
 * nobody is judging the hydraulics of a background - and drifts the camera
 * slowly down the valley.
 */
class BackdropMode implements AppMode {
  private sim: WaterSim;
  private sources;
  private drift = 0;

  constructor(
    private level: Level,
    private renderer: Renderer,
  ) {
    this.sim = buildSim(level);
    this.sources = toSimSources(level);
    primeSim(this.sim, this.sources, 12);

    const grid = levelGrid(level);
    renderer.setGrid(grid);
    renderer.uploadTerrain(level.terrain);
    renderer.camera.coverLevel(grid);
    renderer.camera.zoom *= 1.5;
    this.drift = 0.15;
  }

  update(dt: number): void {
    this.sim.applySources(this.sources, dt);
    this.sim.step(dt);

    const grid = levelGrid(this.level);
    this.drift += dt * 0.012;
    if (this.drift > 1) this.drift -= 1;
    this.renderer.camera.x = grid.width * grid.cellSize * 0.5;
    this.renderer.camera.y = this.drift * grid.height * grid.cellSize;
    this.renderer.camera.clampToLevel(grid);
  }

  buildScene(time: number): Scene {
    return { level: this.level, sim: this.sim, time, editorView: false };
  }

  dispose(): void {
    clear(document.getElementById('ui') as HTMLElement);
  }
}

/** Ensure there is something to play on a first launch. */
export async function seedDemoLevel(): Promise<Level> {
  const demo = createDemoLevel();
  if (!hasLevel(demo.id)) {
    await saveLevel(demo);
    return demo;
  }
  return (await loadLevel(demo.id)) ?? demo;
}
