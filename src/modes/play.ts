import { Session, formatTime } from '../game/session';
import { PlayControls } from '../input/playControls';
import type { Renderer, Scene } from '../render/renderer';
import type { Level } from '../sim/level';
import { levelGrid } from '../sim/level';
import { recordTime } from '../storage';
import { button, clear, el, sheet } from '../ui/dom';

/**
 * Play mode: HUD, paddle zones, and the results panel.
 *
 * The paddle zones sit above the canvas and swallow all touches, so there is
 * no chance of a stray drag panning the camera mid-run.
 */

export interface PlayCallbacks {
  onExit(): void;
  /** Present when the run was launched from the editor's Test button. */
  onEditAgain?(): void;
}

export class PlayMode {
  readonly session: Session;

  private controls: PlayControls;
  private timerNode: HTMLElement;
  private healthFill: HTMLElement;
  private distanceNode: HTMLElement;
  private zones: Record<'left' | 'right', HTMLElement>;
  private resultOpen = false;
  private closeResult: (() => void) | null = null;

  constructor(
    level: Level,
    private renderer: Renderer,
    private ui: HTMLElement,
    private callbacks: PlayCallbacks,
  ) {
    this.session = new Session(level);

    const grid = levelGrid(level);
    renderer.setGrid(grid);
    renderer.uploadTerrain(level.terrain);
    renderer.camera.zoom = 14;
    renderer.camera.x = this.session.kayak.x;
    renderer.camera.y = this.session.kayak.y;
    // No margin: the level edge should meet the screen edge rather than
    // leaving a band of empty void along the top of a run that starts high.
    renderer.camera.clampToLevel(grid);

    this.controls = new PlayControls({
      onStroke: (side) => {
        this.session.stroke(side);
        this.pulse(side);
        // A short tick makes the stroke feel physical on a phone.
        navigator.vibrate?.(8);
      },
      onBraceStart: (side) => {
        this.session.setBrace(side, true);
        this.zones[side].classList.add('active');
      },
      onBraceEnd: (side) => {
        this.session.setBrace(side, false);
        this.zones[side].classList.remove('active');
      },
    });

    clear(this.ui);

    this.timerNode = el('div', { class: 'timer', text: '0:00.00' });
    this.healthFill = el('div', { style: 'width:100%' });
    this.distanceNode = el('div', { class: 'stat', text: '' });

    const hud = el('div', { class: 'hud' }, [
      button('‹', () => this.exit(), { class: 'ghost', title: 'Quit run' }),
      this.timerNode,
      el('div', { class: 'grow' }),
      el('div', { class: 'stack' }, [
        this.distanceNode,
        el('div', { class: 'health-bar' }, [this.healthFill]),
      ]),
      button('↺', () => this.restart(), { class: 'ghost', title: 'Restart' }),
    ]);

    const leftZone = el('div', { class: 'zone', 'data-label': 'Left paddle' });
    const rightZone = el('div', { class: 'zone', 'data-label': 'Right paddle' });
    this.zones = { left: leftZone, right: rightZone };
    const zoneWrap = el('div', { class: 'paddle-zones' }, [leftZone, rightZone]);

    this.ui.append(zoneWrap, hud);
    this.controls.attach(zoneWrap);
  }

  dispose(): void {
    this.controls.detach();
    this.closeResult?.();
    clear(this.ui);
  }

  private pulse(side: 'left' | 'right'): void {
    const zone = this.zones[side];
    zone.classList.add('active');
    window.setTimeout(() => {
      // Only clear it if this wasn't a hold that's still down.
      if (!this.session.kayak.isBracing(side)) zone.classList.remove('active');
    }, 110);
  }

  private restart(): void {
    this.closeResult?.();
    this.closeResult = null;
    this.resultOpen = false;
    this.controls.releaseAll();
    this.zones.left.classList.remove('active');
    this.zones.right.classList.remove('active');
    this.session.restart();
  }

  private exit(): void {
    this.controls.releaseAll();
    this.callbacks.onExit();
  }

  update(dt: number): void {
    const events = this.session.update(dt);

    if (events.impact > 0) {
      navigator.vibrate?.(Math.min(60, 12 + events.impact * 12));
    }
    if (events.won || events.capsized) {
      this.controls.releaseAll();
      this.zones.left.classList.remove('active');
      this.zones.right.classList.remove('active');
      this.showResult(events.won);
    }

    this.updateHud();

    // Look ahead of the boat so the player sees what's coming, not what's past.
    const k = this.session.kayak;
    const lead = 1.1;
    this.renderer.camera.follow(k.x + k.vx * lead, k.y + k.vy * lead, dt, 5);
    this.renderer.camera.clampToLevel(levelGrid(this.session.level));
  }

  private updateHud(): void {
    this.timerNode.textContent = formatTime(this.session.elapsedMs);

    const health = Math.max(0, this.session.health);
    this.healthFill.style.width = `${health}%`;
    this.healthFill.style.background =
      health > 55 ? 'var(--good)' : health > 25 ? '#e0b341' : 'var(--danger)';

    const distance = this.session.distanceToGoal();
    this.distanceNode.textContent = distance === null ? '' : `${Math.round(distance)} m to go`;
  }

  buildScene(time: number): Scene {
    const k = this.session.kayak;
    return {
      level: this.session.level,
      sim: this.session.sim,
      time,
      editorView: false,
      kayak: {
        x: k.x,
        y: k.y,
        heading: k.heading,
        strokeFlashLeft: k.strokeFlash.left,
        strokeFlashRight: k.strokeFlash.right,
        health: k.health,
      },
    };
  }

  private showResult(won: boolean): void {
    if (this.resultOpen) return;
    this.resultOpen = true;

    const ms = this.session.elapsedMs;
    const body: Array<Node | string> = [];
    let note = '';

    if (won) {
      const isBest = recordTime(this.session.level.id, ms);
      note = isBest ? 'New best time.' : 'Not your best — try a tighter line.';
      body.push(el('div', { class: 'result-time', text: formatTime(ms) }));
      body.push(el('div', { class: 'result-note', text: note }));
    } else {
      body.push(
        el('div', {
          class: 'result-note',
          text: 'The hull took too much damage. Pick a gentler line through the rocks.',
        }),
      );
    }

    const actions = [
      { label: 'Run it again', class: 'primary', onClick: () => this.restart() },
      ...(this.callbacks.onEditAgain
        ? [{ label: 'Back to editor', onClick: () => this.callbacks.onEditAgain?.() }]
        : []),
      { label: 'Level list', onClick: () => this.exit() },
    ];

    this.closeResult = sheet(this.ui, {
      title: won ? 'Goal reached' : 'Capsized',
      body,
      actions,
    });
  }
}
