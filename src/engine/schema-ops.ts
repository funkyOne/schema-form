import type { Schema } from "./types";

/*
 * Pure schema operations. Every function here is memoized on object identity,
 * so the same inputs always return the *same* object. That identity stability is
 * what lets React components subscribe to "the resolved schema at this path" and
 * only re-render when the structure actually changes, not on every keystroke.
 */

const ids = new WeakMap<object, number>();
let nextId = 1;
export function idOf(o: unknown): number {
  if (o === null || typeof o !== "object") return 0;
  let id = ids.get(o);
  if (!id) {
    id = nextId++;
    ids.set(o, id);
  }
  return id;
}

/** Bounded string-keyed memo. Clearing only costs extra re-renders, never correctness. */
export class Memo<V> {
  private map = new Map<string, V>();
  constructor(private readonly max = 10_000) {}
  get(key: string, make: () => V): V {
    let v = this.map.get(key);
    if (v === undefined) {
      v = make();
      if (this.map.size >= this.max) this.map.clear();
      this.map.set(key, v);
    }
    return v;
  }
}

const TRUE_SCHEMA: Schema = Object.freeze({}) as Schema;
const FALSE_SCHEMA: Schema = Object.freeze({ not: {} }) as Schema;

export function normalize(s: unknown): Schema {
  if (s === true || s === undefined) return TRUE_SCHEMA;
  if (s === false) return FALSE_SCHEMA;
  return s as Schema;
}

// ---------------------------------------------------------------- $ref

function resolvePointer(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#")) {
    throw new Error(`Only local $refs are supported (got "${ref}")`);
  }
  const parts = ref
    .slice(1)
    .split("/")
    .filter(Boolean)
    .map((p) => decodeURIComponent(p).replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur: any = root;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur === undefined) throw new Error(`Unresolvable $ref "${ref}"`);
  }
  return cur;
}

const derefCache = new WeakMap<object, WeakMap<object, Schema>>();

/** Follows a top-level $ref chain. Nested $refs are resolved lazily when reached. */
export function deref(root: Schema, input: unknown): Schema {
  const s = normalize(input);
  if (typeof s.$ref !== "string") return s;
  let perRoot = derefCache.get(root);
  if (!perRoot) derefCache.set(root, (perRoot = new WeakMap()));
  const hit = perRoot.get(s);
  if (hit) return hit;

  let depth = 0;
  let cur: Schema = s;
  const siblings: Schema[] = [];
  while (typeof cur.$ref === "string") {
    if (++depth > 50) throw new Error(`$ref cycle at "${s.$ref}"`);
    const rest = without(cur, "$ref");
    if (Object.keys(rest).length) siblings.push(rest);
    cur = normalize(resolvePointer(root, cur.$ref));
  }
  // Keywords next to a $ref (allowed from 2019-09) are combined with the target.
  let out = cur;
  for (const sib of siblings.reverse()) out = merge(out, sib);
  perRoot.set(s, out);
  return out;
}

// ---------------------------------------------------------------- without

const withoutMemo = new Memo<Schema>();
export function without(s: Schema, ...keys: string[]): Schema {
  if (!keys.some((k) => k in s)) return s;
  return withoutMemo.get(`${idOf(s)}-${keys.join(",")}`, () => {
    const out: Schema = { ...s };
    for (const k of keys) delete out[k];
    return out;
  });
}

// ---------------------------------------------------------------- merge

const allOfMemo = new Memo<Schema>();
/** Lazily combine two property schemas; `resolve` flattens the allOf when that property is reached. */
function both(a: unknown, b: unknown): Schema {
  if (a === b) return normalize(a);
  return allOfMemo.get(`${idOf(a)}&${idOf(b)}`, () => ({ allOf: [a, b] }));
}

const mergeMemo = new Memo<Schema>();
/**
 * Merge `b` into `a` with allOf-like semantics, for already-flattened schemas.
 * Properties present in both are combined lazily; `required` is unioned;
 * other keywords from `b` win (it is the more specific branch).
 */
export function merge(a: Schema, b: Schema): Schema {
  if (a === b || Object.keys(b).length === 0) return a;
  if (Object.keys(a).length === 0) return b;
  return mergeMemo.get(`${idOf(a)}+${idOf(b)}`, () => {
    const out: Schema = { ...a };
    for (const [k, v] of Object.entries(b)) {
      if (k === "properties" && a.properties) {
        const props: Record<string, unknown> = { ...a.properties };
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) {
          props[pk] = pk in props ? both(props[pk], pv) : pv;
        }
        out.properties = props;
      } else if (k === "required" && Array.isArray(a.required)) {
        out.required = [...new Set([...a.required, ...(v as string[])])];
      } else if (k === "items" && a.items && v) {
        out.items = both(a.items, v);
      } else if (k === "x-messages" && a["x-messages"]) {
        out[k] = { ...a[k], ...(v as object) };
      } else {
        out[k] = v;
      }
    }
    return out;
  });
}

export function primaryType(s: Schema): string | undefined {
  const t = s.type;
  if (Array.isArray(t)) return t.find((x) => x !== "null");
  if (t) return t;
  if (s.properties) return "object";
  if (s.items) return "array";
  if (Array.isArray(s.enum) && s.enum.length) {
    const v = s.enum[0];
    return v === null ? undefined : typeof v === "number" ? "number" : typeof v;
  }
  return undefined;
}
