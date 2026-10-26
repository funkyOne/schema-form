/**
 * Field paths use TanStack Form's notation: `a.b[0].c`.
 * Internally we work with segment arrays: ['a', 'b', 0, 'c'].
 */
export type Segment = string | number;

export function parsePath(path: string): Segment[] {
  if (!path) return [];
  const segs: Segment[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[2] !== undefined) segs.push(Number(m[2]));
    else segs.push(m[1]!);
  }
  return segs;
}

export function formatPath(segs: readonly Segment[]): string {
  let out = "";
  for (const s of segs) {
    if (typeof s === "number") out += `[${s}]`;
    else out += out ? `.${s}` : s;
  }
  return out;
}

export function joinPath(base: string, child: Segment): string {
  if (typeof child === "number") return `${base}[${child}]`;
  return base ? `${base}.${child}` : child;
}

/**
 * Resolve a path written in a UI schema relative to a base path.
 * - "/a.b" is absolute (from the form root)
 * - "a.b"  is relative to `base` (the root, or the current array item / object detail)
 */
export function resolveRelativePath(path: string, base: string): string {
  if (path.startsWith("/")) return path.slice(1);
  if (!base) return path;
  if (!path) return base;
  return path.startsWith("[") ? `${base}${path}` : `${base}.${path}`;
}

export function getIn(obj: unknown, path: string | readonly Segment[]): unknown {
  const segs = typeof path === "string" ? parsePath(path) : path;
  let cur: any = obj;
  for (const s of segs) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[s as any];
  }
  return cur;
}

/** JSON Pointer ("/a/0/b") -> segments. Used for AJV instancePath. */
export function parsePointer(pointer: string): Segment[] {
  if (!pointer) return [];
  return pointer
    .split("/")
    .slice(1)
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
}

/** Is `path` equal to, or nested under, `ancestor`? */
export function isWithin(path: string, ancestor: string): boolean {
  if (!ancestor) return true;
  if (path === ancestor) return true;
  return path.startsWith(ancestor + ".") || path.startsWith(ancestor + "[");
}
