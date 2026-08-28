/**
 * River context menu — HTML fixed-position menu.
 *
 * Mirrors scribe/src/view/contextMenu.ts (Obsidian-style) but adapted for River's
 * single-document viewer. The menu is pure HTML; the canvas only supplies the hit
 * context (code block under cursor). Pure helpers `layoutMenuRows`, `measureMenuHeight`,
 * `clampMenuPosition`, `hitTestMenuRow` are kept from gallery's canvas ContextMenu for
 * testability — they describe geometry without touching DOM.
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  hint?: string;
  accelerator?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  sectionBefore?: boolean;
  data?: unknown;
}

export type ShowOptions = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect?: (id: string, data: unknown) => void | Promise<void>;
};

/* ── Pure layout helpers (gallery parity, testable) ────────────────────────── */

export const MENU_WIDTH = 236;
const ROW_H = 30;
const PAD_Y = 8;
const SECTION_GAP = 7;

export interface MenuRow {
  id: string;
  index: number;
  y: number;
  height: number;
}

export function layoutMenuRows(items: readonly ContextMenuItem[]): MenuRow[] {
  const rows: MenuRow[] = [];
  let y = PAD_Y;
  items.forEach((item, index) => {
    if ((item.sectionBefore || item.separator) && index > 0) y += SECTION_GAP;
    if (item.separator) return;
    rows.push({ id: item.id, index, y, height: ROW_H });
    y += ROW_H;
  });
  return rows;
}

export function measureMenuHeight(items: readonly ContextMenuItem[]): number {
  const rows = layoutMenuRows(items);
  const last = rows[rows.length - 1];
  return last ? last.y + last.height + PAD_Y : 2 * PAD_Y;
}

export function clampMenuPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  boundsW: number,
  boundsH: number,
): { x: number; y: number } {
  const margin = 8;
  const cx = Math.max(margin, Math.min(x, Math.max(margin, boundsW - width - margin)));
  const cy = Math.max(margin, Math.min(y, Math.max(margin, boundsH - height - margin)));
  return { x: cx, y: cy };
}

export function hitTestMenuRow(
  rows: readonly MenuRow[],
  localX: number,
  localY: number,
): MenuRow | null {
  if (localX < 0 || localX > MENU_WIDTH) return null;
  for (const row of rows) {
    if (localY >= row.y && localY < row.y + row.height) return row;
  }
  return null;
}

/* ── DOM helpers ─────────────────────────────────────────────────────────── */

let cleanup: (() => void) | null = null;

export function getContextMenuEl(): HTMLElement | null {
  return document.getElementById('river-context-menu') as HTMLElement | null;
}

export function hideContextMenu(): void {
  const el = getContextMenuEl();
  if (!el) return;
  el.hidden = true;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '';
  el.style.left = '-9999px';
  el.style.top = '-9999px';
  if (cleanup) {
    const fn = cleanup;
    cleanup = null;
    fn();
  }
}

export function isContextMenuVisible(): boolean {
  const el = getContextMenuEl();
  return !!el && !el.hidden;
}

export function showContextMenu(opts: ShowOptions): void {
  const el = getContextMenuEl();
  if (!el) return;
  hideContextMenu();

  el.hidden = false;
  el.setAttribute('aria-hidden', 'false');

  const list = document.createElement('ul');
  list.className = 'river-context-menu__list';
  list.setAttribute('role', 'menu');
  list.setAttribute('aria-label', 'Context menu');

  for (const item of opts.items) {
    if (item.separator) {
      const sep = document.createElement('li');
      sep.className = 'river-context-menu__separator';
      sep.setAttribute('role', 'separator');
      list.appendChild(sep);
      continue;
    }
    if (item.sectionBefore) {
      const sep = document.createElement('li');
      sep.className = 'river-context-menu__separator';
      sep.setAttribute('role', 'separator');
      list.appendChild(sep);
    }
    const li = document.createElement('li');
    li.setAttribute('role', 'none');
    const btn = document.createElement('button');
    btn.className = 'river-context-menu__item';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.menuId = item.id;
    btn.type = 'button';
    if (item.disabled) {
      btn.setAttribute('aria-disabled', 'true');
      btn.disabled = true;
      btn.tabIndex = -1;
    } else {
      btn.tabIndex = 0;
    }

    const label = document.createElement('span');
    label.className = 'river-context-menu__label';
    label.textContent = item.label;
    btn.appendChild(label);

    const hintText = item.hint ?? item.accelerator;
    if (hintText) {
      const acc = document.createElement('span');
      acc.className = 'river-context-menu__accel';
      acc.textContent = hintText;
      btn.appendChild(acc);
    }

    if (item.checked && !item.disabled) {
      const check = document.createElement('span');
      check.className = 'river-context-menu__accel';
      check.textContent = '✓';
      check.style.marginLeft = '8px';
      btn.appendChild(check);
    }

    if (!item.disabled) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = item.id;
        const data = item.data;
        hideContextMenu();
        setTimeout(() => {
          void opts.onSelect?.(id, data);
        }, 0);
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          btn.click();
        }
      });
    }

    li.appendChild(btn);
    list.appendChild(li);
  }

  el.appendChild(list);

  el.style.left = '0';
  el.style.top = '0';
  const rect = el.getBoundingClientRect();
  const margin = 8;
  let left = opts.x;
  let top = opts.y;
  if (left + rect.width + margin > window.innerWidth) {
    left = Math.max(margin, window.innerWidth - rect.width - margin);
  }
  if (top + rect.height + margin > window.innerHeight) {
    top = Math.max(margin, window.innerHeight - rect.height - margin);
  }
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;

  const onClickOutside = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (!target) return;
    if (el.contains(target)) return;
    hideContextMenu();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideContextMenu();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const buttons = Array.from(
        el.querySelectorAll<HTMLButtonElement>('button.river-context-menu__item:not([disabled])'),
      );
      if (buttons.length === 0) return;
      const active = document.activeElement as HTMLButtonElement | null;
      const idx = buttons.indexOf(active as HTMLButtonElement);
      e.preventDefault();
      let next = 0;
      if (e.key === 'ArrowDown') next = idx < 0 ? 0 : (idx + 1) % buttons.length;
      else next = idx < 0 ? buttons.length - 1 : (idx - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };
  const onResize = (): void => {
    try {
      const rect2 = el.getBoundingClientRect();
      const margin2 = 8;
      const fits =
        rect2.left >= margin2 &&
        rect2.top >= margin2 &&
        rect2.right + margin2 <= window.innerWidth &&
        rect2.bottom + margin2 <= window.innerHeight &&
        rect2.width > 0 &&
        rect2.height > 0;
      if (!fits) hideContextMenu();
    } catch {
      // ignore
    }
  };
  const onScroll = (): void => {
    try {
      const rect2 = el.getBoundingClientRect();
      const offscreen =
        rect2.bottom < 0 ||
        rect2.top > window.innerHeight ||
        rect2.right < 0 ||
        rect2.left > window.innerWidth;
      if (offscreen) hideContextMenu();
    } catch {
      // ignore
    }
  };
  const onContextOutside = (e: MouseEvent): void => {
    const target = e.target as Node | null;
    if (!target) return;
    if (el.contains(target)) {
      e.preventDefault();
      return;
    }
    hideContextMenu();
  };

  setTimeout(() => {
    document.addEventListener('click', onClickOutside);
    document.addEventListener('auxclick', onClickOutside as unknown as EventListener);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    document.addEventListener('contextmenu', onContextOutside);
  }, 0);

  cleanup = () => {
    document.removeEventListener('click', onClickOutside);
    document.removeEventListener('auxclick', onClickOutside as unknown as EventListener);
    document.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('contextmenu', onContextOutside);
  };

  const first = list.querySelector<HTMLButtonElement>('button:not([disabled])');
  requestAnimationFrame(() => first?.focus());
}
