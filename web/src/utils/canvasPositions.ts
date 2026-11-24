import { browserStorage } from "./browserStorage";
import type { LayoutDirection } from "./layoutDirection";

export type CanvasPosition = { x: number; y: number };
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

// Root and visible classes deliberately do not participate: expanding, filtering or
// reopening another part of the same schema must not lose its manually placed boxes.
export function canvasPositionKey(profile: string, pkg: string, direction: LayoutDirection): string {
  return `schema-studio-canvas-positions:${JSON.stringify([profile, pkg, direction])}`;
}

export function readCanvasPositions(key: string, storage: Storage | null = browserStorage()): Map<string, CanvasPosition> {
  const positions = new Map<string, CanvasPosition>();
  try {
    const saved = JSON.parse(storage?.getItem(key) ?? "null");
    if (saved?.version !== 1 || !Array.isArray(saved.positions)) return positions;
    for (const entry of saved.positions) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [id, point] = entry;
      if (typeof id !== "string" || !id || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      positions.set(id, { x: point.x, y: point.y });
    }
  } catch { /* A malformed or unavailable cache must not prevent opening a schema. */ }
  return positions;
}

export function createCanvasPositionStore(key: string, storage: Storage | null = browserStorage()) {
  const positions = readCanvasPositions(key, storage);
  const restoredIds = new Set(positions.keys());
  let lastSaved = "";
  return {
    positions,
    restoredIds,
    save(): boolean {
      try {
        if (!storage) return false;
        const json = JSON.stringify({ version: 1, positions: [...positions] });
        // Selection and node measurement updates should not write to storage again.
        if (json !== lastSaved) storage.setItem(key, json);
        lastSaved = json;
        return true;
      } catch { return false; }
    },
  };
}
