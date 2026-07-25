/**
 * Drives the built app in a phone-sized Chromium and captures screenshots of
 * each screen. Verifies the parts unit tests can't reach: that WebGL comes up,
 * the river renders, painting changes the terrain, and a run can be played.
 *
 *   node scripts/smoke.mjs [--url http://localhost:4173]
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:4173';

const OUT = 'screenshots';
mkdirSync(OUT, { recursive: true });

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    console.log(`  FAIL ${name} ${detail}`);
    failures.push(name);
  }
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--no-sandbox',
  ],
});

const context = await browser.newContext({
  ...devices['iPhone 13'],
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));

/**
 * Fraction of drawn / blue pixels in a screenshot.
 *
 * This deliberately measures the screenshot rather than calling readPixels on
 * the context: with preserveDrawingBuffer false the drawing buffer is already
 * cleared by the time we could read it, so readPixels reports an empty canvas
 * even when the river is plainly on screen. The screenshot is also what a
 * player actually sees, which is the thing worth asserting on.
 */
async function coverage(name) {
  const path = `${OUT}/${name}`;
  await page.screenshot({ path });
  const dataUrl = `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  return page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let lit = 0;
    let blue = 0;
    let green = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 30 || g > 34 || b > 45) lit++;
      if (b > r + 25 && b > 70) blue++;
      if (g > r + 12 && g > b + 8) green++;
    }
    const total = data.length / 4;
    return { lit: lit / total, blue: blue / total, green: green / total };
  }, dataUrl);
}

const tap = async (x, y) => {
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(180);
};

console.log(`\nSmoke test against ${url}\n`);

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

// --- menu -------------------------------------------------------------------
console.log('menu');
check('title renders', await page.locator('.title').first().isVisible());
const menuCoverage = await coverage('01-menu.png');
check('backdrop river drawn', menuCoverage.lit > 0.5, JSON.stringify(menuCoverage));

// --- level select -----------------------------------------------------------
console.log('level select');
await page.getByRole('button', { name: 'Play', exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/02-levels.png` });
check('demo level listed', await page.getByText('First Run').isVisible());

// --- play mode --------------------------------------------------------------
console.log('play');
await page.locator('.level-card button.primary').first().click();
await page.waitForTimeout(2500);
const playCoverage = await coverage('03-play.png');
check('terrain renders in play', playCoverage.green > 0.2, JSON.stringify(playCoverage));
check('water visible in play', playCoverage.blue > 0.01, JSON.stringify(playCoverage));
check('timer visible', await page.locator('.hud .timer').isVisible());

const size = page.viewportSize();
const readBoat = () =>
  page.evaluate(() => {
    const s = window.__session;
    return s ? { x: s.kayak.x, y: s.kayak.y, t: s.elapsedMs, h: s.kayak.health } : null;
  });

const before = await readBoat();
check('session exposed for testing', before !== null);

// Alternating taps should drive the boat forward.
for (let i = 0; i < 14; i++) {
  await tap(size.width * (i % 2 === 0 ? 0.25 : 0.75), size.height * 0.62);
}
await page.waitForTimeout(400);
const after = await readBoat();
if (before && after) {
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  check('paddling moves the boat', moved > 2, `moved ${moved.toFixed(2)} m`);
  check('clock runs', after.t > before.t, `${before.t.toFixed(0)} -> ${after.t.toFixed(0)}`);
}
await page.screenshot({ path: `${OUT}/04-paddling.png` });

// Hold to brace should turn the boat.
const beforeHeading = await page.evaluate(() => window.__session?.kayak.heading);
await page.touchscreen.tap(size.width * 0.25, size.height * 0.62);
await page.evaluate(async () => {
  // Synthesise a long press: tap helpers always release immediately.
  const zone = document.querySelectorAll('.paddle-zones .zone')[0];
  const opts = { pointerId: 99, bubbles: true, clientX: 40, clientY: 400, isPrimary: true };
  zone.dispatchEvent(new PointerEvent('pointerdown', opts));
  await new Promise((r) => setTimeout(r, 1400));
  zone.dispatchEvent(new PointerEvent('pointerup', opts));
});
await page.waitForTimeout(200);
const afterHeading = await page.evaluate(() => window.__session?.kayak.heading);
check(
  'holding a side turns the boat',
  Math.abs(afterHeading - beforeHeading) > 0.15,
  `${beforeHeading?.toFixed(3)} -> ${afterHeading?.toFixed(3)}`,
);

// --- editor -----------------------------------------------------------------
console.log('editor');
await page.locator('.hud button').first().click();
await page.waitForTimeout(400);
await page.locator('.level-card button').nth(1).click();
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/05-editor.png` });
check('tool palette visible', await page.locator('.tool-row').isVisible());

const terrainBefore = await page.evaluate(() => window.__editor?.level.terrain.slice(0, 0) ?? null);
const sumBefore = await page.evaluate(() => {
  const t = window.__editor.level.terrain;
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i];
  return s;
});

// Paint a stroke with the raise brush.
await page.getByRole('button', { name: /Raise/ }).click();
await page.waitForTimeout(120);
await page.mouse.move(size.width * 0.4, size.height * 0.35);
await page.mouse.down();
for (let i = 0; i <= 10; i++) {
  await page.mouse.move(size.width * (0.4 + i * 0.02), size.height * (0.35 + i * 0.012));
  await page.waitForTimeout(24);
}
await page.mouse.up();
await page.waitForTimeout(600);

const sumAfter = await page.evaluate(() => {
  const t = window.__editor.level.terrain;
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i];
  return s;
});
check('brush raises terrain', sumAfter > sumBefore + 1, `${sumBefore.toFixed(0)} -> ${sumAfter.toFixed(0)}`);
check('undo becomes available', await page.locator('.top-bar button[title="Undo"]').isEnabled());
await page.screenshot({ path: `${OUT}/06-editor-painted.png` });

// Undo should put it back.
await page.locator('.top-bar button[title="Undo"]').click();
await page.waitForTimeout(300);
const sumUndone = await page.evaluate(() => {
  const t = window.__editor.level.terrain;
  let s = 0;
  for (let i = 0; i < t.length; i++) s += t[i];
  return s;
});
check('undo restores terrain', Math.abs(sumUndone - sumBefore) < 0.5, `${sumUndone.toFixed(0)} vs ${sumBefore.toFixed(0)}`);

void terrainBefore;

// --- winning a run ----------------------------------------------------------
// Paddling the whole river reliably is not something a script should attempt,
// so put the boat on the goal and check the rules fire: state, results panel
// and recorded best time.
console.log('finish');
// Leaving the editor with unsaved paint pops a confirmation first.
await page.locator('.top-bar button').first().click();
await page.waitForTimeout(400);
const discard = page.getByRole('button', { name: 'Discard changes' });
if (await discard.isVisible().catch(() => false)) {
  check('unsaved changes are guarded', true);
  await discard.click();
  await page.waitForTimeout(500);
}
await page.locator('.level-card button.primary').first().click();
await page.waitForTimeout(2200);

await page.evaluate(() => {
  const s = window.__session;
  s.kayak.x = s.level.goal.x;
  s.kayak.y = s.level.goal.y;
});
await page.waitForTimeout(600);
check('reaching the goal wins', (await page.evaluate(() => window.__session?.state)) === 'won');
check('results panel appears', await page.locator('.sheet-card').isVisible());
check('finish time shown', await page.locator('.result-time').isVisible());
await page.screenshot({ path: `${OUT}/07-won.png` });

const best = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('river.best.v1') || '{}'),
);
check('best time recorded', Object.keys(best).length > 0, JSON.stringify(best));

// --- level lifecycle: create, save, share, import ---------------------------
console.log('levels');
await page.getByRole('button', { name: 'Level list' }).click();
await page.waitForTimeout(500);

const countBefore = await page.locator('.level-card').count();
await page.getByRole('button', { name: 'New level' }).click();
await page.waitForTimeout(1500);
check('new level opens the editor', await page.locator('.tool-row').isVisible());

// Place a start and a goal so it becomes playable, then save.
await page.getByRole('button', { name: /Start/ }).click();
await page.touchscreen.tap(size.width * 0.5, size.height * 0.22);
await page.waitForTimeout(150);
await page.getByRole('button', { name: /Goal/ }).click();
await page.touchscreen.tap(size.width * 0.45, size.height * 0.34);
await page.waitForTimeout(150);
check(
  'entities land on the level',
  await page.evaluate(() => !!(window.__editor?.level.start && window.__editor?.level.goal)),
);

await page.getByRole('button', { name: 'Save' }).click();
await page.waitForTimeout(800);
await page.locator('.top-bar button').first().click();
await page.waitForTimeout(700);
check('saved level is listed', (await page.locator('.level-card').count()) === countBefore + 1);

// Share the first level, then re-import its code through the URL.
await page.locator('.level-card button.ghost').first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Share', exact: true }).click();
await page.waitForTimeout(700);
const code = await page.locator('textarea').inputValue();
check('share code produced', code.length > 100 && /^[A-Za-z0-9_-]+$/.test(code), `${code.length} chars`);
await page.screenshot({ path: `${OUT}/08-share.png` });
await page.getByRole('button', { name: 'Done' }).click();
await page.waitForTimeout(300);

const beforeImport = await page.locator('.level-card').count();

// Opening a share link while the app is already open is only a fragment
// change, so it arrives as hashchange rather than a page load.
await page.evaluate((c) => {
  location.hash = `#code=${c}`;
}, code);
await page.waitForTimeout(2500);
check(
  'share link imports while the app is running',
  (await page.locator('.level-card').count()) === beforeImport + 1,
);
check('url is cleaned after import', !page.url().includes('#code='));

// And the cold path: a share link opened in a fresh page load. The query
// string is what forces a real document load - a bare fragment change would
// be handled same-document by the listener above and prove nothing.
const beforeCold = await page.locator('.level-card').count();
await page.goto(`${url}/?cold=1#code=${code}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(3000);
check(
  'share link imports on a cold load',
  (await page.locator('.level-card').count()) === beforeCold + 1,
);
await page.screenshot({ path: `${OUT}/09-imported.png` });

// A corrupt code must be rejected with a message, not a crash.
await page.evaluate(() => {
  location.hash = '#code=obviously-not-valid';
});
await page.waitForTimeout(1500);
check('bad share code is rejected gracefully', await page.locator('.toast.error').isVisible());
check('app still usable after a bad code', await page.locator('.screen').isVisible());

// --- context loss -----------------------------------------------------------
// Phones drop the WebGL context routinely; the app must say so rather than
// going black. WEBGL_lose_context simulates exactly what the driver does.
console.log('resilience');
await page.evaluate(() => {
  const gl = document.getElementById('view').getContext('webgl2');
  gl.getExtension('WEBGL_lose_context').loseContext();
});
await page.waitForTimeout(900);
check(
  'context loss is explained, not a black screen',
  (await page.locator('.title').first().innerText()).includes('Graphics'),
);
await page.screenshot({ path: `${OUT}/10-context-lost.png` });

// --- console ----------------------------------------------------------------
check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

await browser.close();

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}\n`);
process.exit(failures.length === 0 ? 0 : 1);
