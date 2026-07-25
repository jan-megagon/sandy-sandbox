import { App, seedDemoLevel } from './app';
import './styles.css';

/**
 * Bootstrap. Everything that can fail at startup - no WebGL2, a corrupt store,
 * a bad share link - fails here with a message a person can act on, rather
 * than a blank canvas.
 */
async function main(): Promise<void> {
  const canvas = document.getElementById('view') as HTMLCanvasElement | null;
  const ui = document.getElementById('ui') as HTMLElement | null;
  if (!canvas || !ui) throw new Error('Page is missing its canvas.');

  const demo = await seedDemoLevel();
  const app = new App(canvas, ui, demo);

  // A shared level arrives as a URL fragment; import it, then clean the URL so
  // a refresh doesn't import it a second time.
  const hash = location.hash;
  if (hash.startsWith('#code=')) {
    const imported = await app.importCode(hash.slice(6));
    history.replaceState(null, '', location.pathname + location.search);
    if (!imported) app.showMenu();
  }
}

function showFatalError(message: string): void {
  const ui = document.getElementById('ui');
  if (!ui) return;
  ui.innerHTML = `
    <div class="screen">
      <div class="spacer"></div>
      <h1 class="title">Can't start</h1>
      <p class="subtitle"></p>
      <div class="spacer"></div>
    </div>`;
  const p = ui.querySelector('.subtitle');
  if (p) p.textContent = message;
}

main().catch((err: unknown) => {
  console.error(err);
  const message =
    err instanceof Error && /WebGL2/.test(err.message)
      ? 'This browser does not support WebGL2, which the river renderer needs. Try an up-to-date Chrome, Safari or Firefox.'
      : err instanceof Error
        ? err.message
        : 'Something went wrong while starting up.';
  showFatalError(message);
});
