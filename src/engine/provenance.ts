import { formatPath, getIn, isWithin, parsePath } from "./path";
import type { Patch, Provenance } from "./types";

/*
 * Pure updates to the provenance map. Each returns the same object when nothing changes,
 * so stores holding it don't notify needlessly.
 */

const EMPTY: Provenance = Object.freeze({}) as Provenance;
export const noProvenance = () => EMPTY;

/** Record (or forget, when `source` is undefined) who wrote `path`. */
export function withSource(p: Provenance, path: string, source: string | undefined): Provenance {
  if (p[path] === source) return p;
  const out = { ...p };
  if (source === undefined) delete out[path];
  else out[path] = source;
  return out;
}

/** Apply the `source` part of each patch. */
export function withPatches(p: Provenance, patches: readonly Patch[]): Provenance {
  for (const x of patches) p = withSource(p, x.path, x.source);
  return p;
}

/** Forget `path` and everything under it (a value that was cleared or removed). */
export function withoutPath(p: Provenance, path: string): Provenance {
  const keys = Object.keys(p).filter((k) => isWithin(k, path));
  if (!keys.length) return p;
  const out = { ...p };
  for (const k of keys) delete out[k];
  return out;
}

/** Shift entries after an array item at `arrayPath[index]` was removed. */
export function withoutIndex(p: Provenance, arrayPath: string, index: number): Provenance {
  const depth = parsePath(arrayPath).length;
  let out = p;
  let changed = false;
  for (const [k, v] of Object.entries(p)) {
    if (!isWithin(k, arrayPath) || k === arrayPath) continue;
    const segs = parsePath(k);
    const i = segs[depth];
    if (typeof i !== "number" || i < index) continue;
    if (!changed) (out = { ...p }), (changed = true);
    delete out[k];
    if (i > index) out[formatPath([...segs.slice(0, depth), i - 1, ...segs.slice(depth + 1)])] = v;
  }
  return out;
}

/** Drop entries for paths that hold no value (e.g. after loading an old draft). */
export function pruneProvenance(p: Provenance, values: unknown): Provenance {
  const dead = Object.keys(p).filter((k) => getIn(values, k) === undefined);
  if (!dead.length) return p;
  const out = { ...p };
  for (const k of dead) delete out[k];
  return out;
}
