import type { Entity } from '@vectojs/core';

/**
 * Axis-aligned hit test in the entity's local box [0, width] × [0, height].
 * Uses worldToLocal so nested scale/rotation stay correct.
 */
export function isInsideBox(entity: Entity, globalX: number, globalY: number): boolean {
  const w = entity.width;
  const h = entity.height;
  if (w <= 0 || h <= 0) return false;
  const local = entity.worldToLocal(globalX, globalY);
  if (!local) return false;
  return local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h;
}
