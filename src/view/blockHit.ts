import type { Entity } from '@vectojs/core';
import { isInsideBox } from './hitTest';

/**
 * Locate the code block under a point in the rendered document.
 *
 * The walk goes through public surface only — `children`, box containment via
 * `worldToLocal`, and `getContentProjection({ textOnly: true })` — exactly like
 * `search.ts`. Code blocks are recognised structurally rather than by class
 * name because `@vectojs/markdown` does not export `CodeBlock` (and a
 * constructor-name check would break under minification anyway): a code block
 * is the one block entity that carries a string `lang` and projects with
 * `ligatures: 'none'`, which nothing else in the document tree sets.
 *
 * The projection's coarse `textOnly` tier is used deliberately: the default tier
 * builds an O(document glyphs) carrier grid, which would turn every right-click
 * into a layout-sized stall on a long file.
 */

/** What a right-click needs to know about a code block it landed on. */
export interface CodeBlockHit {
  /** The code block entity itself. */
  entity: Entity;
  /** Full source text of the block — what "copy" writes to the clipboard. */
  text: string;
  /** Fence language tag, lowercased, or null when the fence had none. */
  lang: string | null;
}

/**
 * Structural shape this module needs from a code-block entity. Declared apart
 * from `Entity` because the real class's `getContentProjection` has a stricter
 * return type than the tolerant shape a duck-typed check must accept.
 */
interface CodeBlockLike {
  width: number;
  height: number;
  worldToLocal(x: number, y: number): { x: number; y: number } | null;
  lang?: unknown;
  getContentProjection(hint?: { textOnly?: boolean }): {
    text?: string;
    ligatures?: string;
  } | null;
}

function asCandidate(entity: Entity): CodeBlockLike {
  return entity as unknown as CodeBlockLike;
}

/**
 * Structural guard for a code-block entity. Kept tolerant of anything that
 * isn't shaped like one; a false negative merely omits the copy row from the
 * menu, while a false positive would copy the wrong thing.
 */
export function isCodeBlockEntity(entity: Entity): boolean {
  const candidate = asCandidate(entity);
  if (typeof candidate.lang !== 'string') return false;
  const projection = candidate.getContentProjection?.({ textOnly: true });
  return !!projection && projection.ligatures === 'none' && typeof projection.text === 'string';
}

/**
 * Depth-first search for the innermost code block containing a point given in
 * world/canvas coordinates (what pointer events report after the canvas-rect
 * subtraction).
 *
 * Children are tested before their parent so a nested structure wins over its
 * container, and subtrees whose own box misses the point are pruned entirely.
 * Returns null when the point lands on prose, chrome, or empty space.
 */
export function findCodeBlockAt(
  root: Entity,
  globalX: number,
  globalY: number,
): CodeBlockHit | null {
  if (!isInsideBox(root, globalX, globalY)) return null;

  for (const child of root.children ?? []) {
    const hit = findCodeBlockAt(child, globalX, globalY);
    if (hit) return hit;
  }

  if (!isCodeBlockEntity(root)) return null;
  const candidate = asCandidate(root);
  const projection = candidate.getContentProjection({ textOnly: true });
  if (!projection || typeof projection.text !== 'string') return null;
  const rawLang = typeof candidate.lang === 'string' ? candidate.lang : null;
  return {
    entity: root,
    text: projection.text,
    lang: rawLang !== null && rawLang.length > 0 ? rawLang.toLowerCase() : null,
  };
}
