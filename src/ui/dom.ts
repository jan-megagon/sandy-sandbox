/** Tiny DOM helpers. The UI is a few dozen elements; this is all it needs. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (key === 'text') {
      node.textContent = String(value);
    } else if (key === 'html') {
      node.innerHTML = String(value);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(child);
  }
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  opts: { class?: string; disabled?: boolean; title?: string } = {},
): HTMLButtonElement {
  return el('button', {
    text: label,
    class: opts.class ?? '',
    disabled: opts.disabled ?? false,
    title: opts.title,
    onClick: () => {
      if (!opts.disabled) onClick();
    },
  });
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

let toastTimer = 0;

/** Brief message anchored above the bottom controls. */
export function toast(root: HTMLElement, message: string, isError = false): void {
  let node = root.querySelector<HTMLDivElement>('.toast');
  if (!node) {
    node = el('div', { class: 'toast' });
    root.append(node);
  }
  node.textContent = message;
  node.classList.toggle('error', isError);
  // Restart the transition even if a toast is already showing.
  node.classList.remove('show');
  void node.offsetWidth;
  node.classList.add('show');

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node?.classList.remove('show'), isError ? 4200 : 2400);
}

export interface SheetOptions {
  title: string;
  body?: Array<Node | string>;
  actions: Array<{ label: string; onClick: () => void; class?: string }>;
  onDismiss?: () => void;
}

/** Modal card. Returns a function that removes it. */
export function sheet(root: HTMLElement, options: SheetOptions): () => void {
  const card = el('div', { class: 'sheet-card' }, [
    el('h2', { text: options.title }),
    ...(options.body ?? []),
    el(
      'div',
      { class: 'stack' },
      options.actions.map((a) => button(a.label, a.onClick, { class: a.class })),
    ),
  ]);

  const overlay = el('div', { class: 'sheet' }, [card]);
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay && options.onDismiss) options.onDismiss();
  });
  root.append(overlay);
  return () => overlay.remove();
}

export function formatRelativeTime(ms: number): string {
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)} h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)} d ago`;
  return new Date(ms).toLocaleDateString();
}
