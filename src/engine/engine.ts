import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import type { QueryClient } from "@tanstack/query-core";
import jsonLogic from "json-logic-js";
import { AsyncCache, createQueryClient, isBlank, isIncomplete, Notifier, watchQueries } from "./async";
import { deepEqual, getIn, isWithin, joinPath, parsePath, parsePointer, formatPath, resolveRelativePath, setIn } from "./path";
import { withPatches } from "./provenance";
import { deref, idOf, Memo, merge, normalize, primaryType, without } from "./schema-ops";
import {
  COMPUTE_SOURCE,
  USER_SOURCE,
  isControl,
  type AsyncEntry,
  type AsyncSourceRef,
  type Combinator,
  type Compute,
  type Condition,
  type DataLogic,
  type Rule,
  type UIElement,
  type Loaders,
  type Prefill,
  type Option,
  type Patch,
  type Provenance,
  type Resolved,
  type Schema,
  type ValidationResult,
} from "./types";

export interface EngineOptions {
  schema: Schema;
  loaders?: Loaders;
  /** Cache for loader results. Pass your app's client to share results between forms. */
  queryClient?: QueryClient;
  /** Custom error text. Return undefined to fall back to the defaults. */
  messages?: (error: ErrorObject) => string | undefined;
  /** Throw on schema features the renderer can't handle (default true). */
  strict?: boolean;
}

/**
 * A node's own keywords for Ajv: children are rebuilt by `concretize`, and our `x-` keywords mean
 * nothing to Ajv. `x-messages` stays: error messages are looked up on the failing schema.
 */
function forValidation(s: Schema): Schema {
  const drop = Object.keys(s).filter(
    (k) => (k.startsWith("x-") && k !== "x-messages") || k === "properties" || k === "items" || k === "required" || k === "$schema",
  );
  return without(s, ...drop);
}

/** Load state of a condition's or rule's `source`, when it isn't ready yet. */
type Waiting = "loading" | "error";
const RULE_LOAD_FAILED = "Couldn't check this value. Please try again.";


/** Passes `applyComputed` makes before concluding the computes chase each other. */
const MAX_COMPUTE_PASSES = 10;
const SKIP = Symbol("skip");
const NOT_HELD = Object.freeze({ holds: false });

type Flat = {
  schema: Schema;
  combinator?: Combinator;
  nullable: boolean;
  extend?: AsyncEntry;
  /** Child keys whose `x-hidden` reads a source that is still loading or failed. */
  waiting?: Record<string, Waiting>;
};

export class FormEngine {
  readonly root: Schema;
  readonly queryClient: QueryClient;
  /** Bumps when async data arrives or a oneOf branch is picked; React subscribes to it. */
  readonly notifier: Notifier;
  private cache: AsyncCache;
  /** User-picked branch for oneOf/anyOf without a discriminator, by field path. */
  private selections = new Map<string, number>();

  private ajv: Ajv;
  private validators = new WeakMap<object, ValidateFunction>();
  private resolvedMemo = new Memo<Resolved>();
  /** Helper schemas built once per combinator array (keyed by its identity). */
  private derivedMemo = new Memo<any>();
  /** Concrete schemas interned by content, so equal structures share one compiled validator. */
  private concreteMemo = new Memo<Schema>();
  private messages?: EngineOptions["messages"];
  /** Last concretize / check result, reused while the values and the loaded data are unchanged. */
  private lastResults: Partial<Record<"concrete" | "check", { values: unknown; version: number; result: unknown }>> = {};

  constructor(opts: EngineOptions) {
    this.root = opts.schema;
    this.messages = opts.messages;
    this.queryClient = opts.queryClient ?? createQueryClient();
    this.notifier = new Notifier((notify) => watchQueries(this.queryClient, notify));
    this.cache = new AsyncCache(opts.loaders ?? {}, this.queryClient);
    this.ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    addFormats(this.ajv);
    if (opts.strict !== false) {
      const problems = findUnsupported(this.root);
      if (problems.length) throw new Error("Unsupported schema features:\n- " + problems.join("\n- "));
    }
  }

  // ============================================================== helpers

  /** Compile once per schema object, with the root's definitions available to $refs. */
  private compile(schema: Schema): ValidateFunction {
    let fn = this.validators.get(schema);
    if (!fn) {
      fn = this.ajv.compile({ ...without(schema, "$schema"), definitions: this.root.definitions, $defs: this.root.$defs });
      this.validators.set(schema, fn);
    }
    return fn;
  }

  /** Does `value` satisfy `schema`? */
  test(schema: unknown, value: unknown): boolean {
    return this.compile(normalize(schema))(value) as boolean;
  }

  /**
   * Data available to JSON Logic expressions: the root values plus
   * $self (value at `path`), $parent (its container) and $item (nearest array item).
   */
  scope(values: unknown, path: string): Record<string, unknown> {
    const segs = parsePath(path);
    let lastIndex = -1;
    segs.forEach((s, i) => typeof s === "number" && (lastIndex = i));
    const extra = {
      $self: getIn(values, segs),
      $parent: getIn(values, segs.slice(0, -1)),
      $item: lastIndex >= 0 ? getIn(values, segs.slice(0, lastIndex + 1)) : undefined,
    };
    return values && typeof values === "object" ? { ...(values as object), ...extra } : extra;
  }

  /** Load `ref` for the field at `path`; `missing` stands in for a `select`ed part that isn't there. */
  readAsync(ref: AsyncSourceRef, values: unknown, path: string, missing?: unknown, scope?: Record<string, unknown>): AsyncEntry {
    const entry = this.cache.read(ref.source, this.params(ref, values, path, scope));
    if (!ref.select || entry.status !== "success") return entry;
    // Same object while the response is unchanged, so fields reading a slice don't re-render.
    const select = ref.select;
    return this.derivedMemo.get(`select:${idOf(entry)}:${select}:${missing === undefined}`, () => ({
      status: "success",
      data: getIn(entry.data, select) ?? missing,
    }));
  }

  /** Evaluate a ref's JSON Logic params for the field at `path`. */
  params(ref: AsyncSourceRef, values: unknown, path: string, scope = this.scope(values, path)): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(ref.params ?? {})) params[k] = jsonLogic.apply(expr as any, scope);
    return params;
  }

  /**
   * Evaluate JSON Logic at the field `self`, with the response of its `source` (if any) as `$data`.
   * `waiting` is set while that source is loading or failed.
   */
  evalLogic(d: DataLogic, values: unknown, self: string): { result: unknown; waiting?: Waiting } {
    const scope = this.scope(values, self);
    let waiting: Waiting | undefined;
    if (d.source) {
      const entry = this.readAsync(d as AsyncSourceRef, values, self, undefined, scope);
      if (entry.status === "loading" || entry.status === "error") waiting = entry.status;
      scope.$data = entry.status === "success" ? entry.data : undefined;
    }
    return { result: jsonLogic.apply(d.logic as any, scope), waiting };
  }

  /**
   * Run the `x-prefill` of the field at `path` and return the writes to make.
   * Targets the response has a value for are filled and attributed to the prefill's source.
   * Targets it lacks are cleared only if this source filled them before (per `provenance`),
   * so values the user typed are never cleared; with `overwrite: "unedited"` they aren't
   * overwritten either. Returns [] while a param is still empty.
   */
  async prefill(prefill: Prefill, values: unknown, path: string, provenance: Provenance = {}): Promise<Patch[]> {
    const params = this.params(prefill, values, path);
    if (isIncomplete(params)) return [];
    const response = await this.cache.fetch(prefill.source, params);
    const data = prefill.select ? getIn(response, prefill.select) : response;
    const overwrite = prefill.overwrite ?? (prefill.trigger === "change" ? "unedited" : "always");
    const base = formatPath(parsePath(path).slice(0, -1));
    const out: Patch[] = [];
    for (const [target, from] of Object.entries(prefill.fill)) {
      const value = getIn(data, from);
      const to = resolveRelativePath(target, base);
      const who = provenance[to];
      if (value !== undefined) {
        // "unedited" keeps what the user typed, and values loaded without provenance.
        const kept = overwrite === "unedited" && getIn(values, to) !== undefined && (who === undefined || who === USER_SOURCE);
        if (!kept) out.push({ path: to, value, source: prefill.source });
      } else if (who === prefill.source && getIn(values, to) !== undefined) out.push({ path: to, value: undefined });
    }
    return out;
  }

  // ============================================================== computed fields

  /**
   * One pass over the active fields: the writes their `x-compute`s want to make, each
   * evaluated against the incoming `values` (no compute sees another's output).
   * A readOnly field is always written. An editable one only while it is empty (and not
   * cleared by the user) or still holds a computed value: the user's own edits win.
   * Disabled fields are skipped (hidden ones aren't in the schema), and fields under a missing
   * object wait for it to exist.
   */
  computed(values: unknown, provenance: Provenance = {}, disabled = this.disabledPaths(values)): Patch[] {
    return this.computePass(values, provenance, disabled, false).patches;
  }

  /**
   * One compute pass. With `readOnlyOnly`, editable (assistive) computes are ignored, which is
   * what validation needs; `waiting` lists readOnly fields whose loader hasn't answered yet.
   */
  private computePass(
    values: unknown,
    provenance: Provenance,
    disabled: Set<string>,
    readOnlyOnly: boolean,
  ): { patches: Patch[]; waiting: string[] } {
    const out: Patch[] = [];
    const waiting: string[] = [];
    const walk = (node: unknown, path: string) => {
      const r = this.resolve(node, path, values);
      const s = r.schema;
      const value = getIn(values, path);
      const readOnly = s.readOnly === true;
      if (s["x-compute"] && path && (readOnly || !readOnlyOnly)) {
        const result = this.evalCompute(s["x-compute"], path, values, r.nullable);
        const who = provenance[path];
        const owned = who !== USER_SOURCE && (value === undefined || who === COMPUTE_SOURCE);
        if (result === SKIP) {
          if (readOnly) waiting.push(path);
        } else if ((readOnly || owned) && !deepEqual(result, value))
          out.push({ path, value: result, source: result === undefined ? undefined : COMPUTE_SOURCE });
      }
      if (value === undefined && path) return;
      for (const k of Object.keys(s.properties ?? {})) {
        const child = joinPath(path, k);
        if (!disabled.has(child)) walk(s.properties[k], child);
      }
      if (s.items !== undefined && Array.isArray(value)) value.forEach((_, i) => walk(s.items, joinPath(path, i)));
    };
    walk(this.root, "");
    return { patches: out, waiting };
  }

  /**
   * Recompute every readOnly `x-compute` until settled, ignoring editable ones. A readOnly value
   * is defined by its formula, so whatever the client sent for it is replaced.
   */
  private withDerived(values: unknown): { values: unknown; waiting: string[] } {
    for (let pass = 0; ; pass++) {
      const { patches, waiting } = this.computePass(values, {}, this.disabledPaths(values), true);
      if (!patches.length) return { values, waiting };
      if (pass >= MAX_COMPUTE_PASSES) {
        const paths = [...new Set(patches.map((p) => p.path))].join(", ");
        throw new Error(`x-compute never settles: ${paths}. Computed fields must not read each other in a cycle.`);
      }
      for (const p of patches) values = setIn(values, p.path, p.value);
    }
  }

  /**
   * Apply computes until nothing changes, so chains (a → b → c) settle in one call.
   * The pure form for servers, tests and event handlers; the React layer calls it on every change.
   * Throws when the computes keep rewriting each other, which means two of them read each other.
   */
  applyComputed(values: unknown, provenance: Provenance = {}): { values: unknown; provenance: Provenance; patches: Patch[] } {
    const patches: Patch[] = [];
    for (let pass = 0; ; pass++) {
      const step = this.computed(values, provenance);
      if (!step.length) return { values, provenance, patches };
      if (pass >= MAX_COMPUTE_PASSES) {
        const paths = [...new Set(step.map((p) => p.path))].join(", ");
        throw new Error(`x-compute never settles: ${paths}. Computed fields must not read each other in a cycle.`);
      }
      for (const p of step) values = setIn(values, p.path, p.value);
      provenance = withPatches(provenance, step);
      patches.push(...step);
    }
  }

  private evalCompute(compute: Compute, path: string, values: unknown, nullable: boolean): unknown {
    let result: unknown;
    if ("logic" in compute) result = jsonLogic.apply(compute.logic as any, this.scope(values, path));
    else {
      const entry = this.readAsync(compute, values, path);
      if (entry.status === "loading" || entry.status === "error") return SKIP;
      result = entry.status === "idle" ? undefined : entry.data;
    }
    // JSON Logic arithmetic on a missing input gives NaN; neither NaN nor (unless nullable) null is a value.
    if (typeof result === "number" && Number.isNaN(result)) return undefined;
    return result === null && !nullable ? undefined : result;
  }

  // ============================================================== resolution

  /**
   * Flatten the schema at `path` for the current values: follow $ref, merge allOf,
   * apply if/then/else, pick the active oneOf/anyOf branch, and merge any loaded
   * x-extend fragment. Returns the same object for the same structure.
   */
  resolve(node: unknown, path: string, values: unknown): Resolved {
    const flat = this.flatten(node, path, values);
    const c = flat.combinator;
    const key = [
      idOf(flat.schema),
      c ? `${c.kind}:${idOf(c.branches)}:${c.selected}:${c.discriminator ?? ""}` : "",
      flat.nullable ? "n" : "",
      flat.extend ? `${flat.extend.status}:${idOf(flat.extend)}` : "",
      flat.waiting ? JSON.stringify(flat.waiting) : "",
    ].join("|");
    return this.resolvedMemo.get(key, () => ({ ...flat }));
  }

  private flatten(node: unknown, path: string, values: unknown): Flat {
    const value = getIn(values, path);
    let s = deref(this.root, node);
    let combinator: Combinator | undefined;
    let nullable = false;
    let extend: AsyncEntry | undefined;
    let waiting: Record<string, Waiting> | undefined;
    const take = (r: Flat, strip: string[] = []) => {
      s = merge(s, strip.length ? without(r.schema, ...strip) : r.schema);
      combinator ??= r.combinator;
      nullable ||= r.nullable;
      extend ??= r.extend;
      if (r.waiting) waiting = { ...waiting, ...r.waiting };
    };

    if (Array.isArray(s.allOf)) {
      const subs = s.allOf;
      s = without(s, "allOf");
      for (const sub of subs) take(this.flatten(sub, path, values));
    }

    if (s.if !== undefined) {
      // `properties` passes vacuously on non-objects, so test an empty object instead of undefined.
      const subject = value === undefined && primaryType(s) === "object" ? {} : value;
      const branch = this.test(s.if, subject) ? s.then : s.else;
      s = without(s, "if", "then", "else");
      if (branch !== undefined) take(this.flatten(branch, path, values));
    }

    for (const kind of ["oneOf", "anyOf"] as const) {
      if (!Array.isArray(s[kind])) continue;
      const raw: unknown[] = s[kind];
      const branches: Schema[] = this.derivedMemo.get(`branches:${idOf(raw)}`, () => raw.map((b) => deref(this.root, b)));
      s = without(s, kind);

      // Nullable shorthand: anyOf: [X, { type: "null" }]
      const nonNull = branches.filter((b) => b.type !== "null");
      if (nonNull.length === 1 && branches.length > 1) {
        take(this.flatten(nonNull[0], path, values));
        nullable = true;
        continue;
      }

      // Labelled enum: oneOf: [{ const: "a", title: "A" }, ...]
      if (branches.every((b) => "const" in b)) {
        s = merge(
          s,
          this.derivedMemo.get(`enum:${idOf(raw)}`, () => ({
            enum: branches.map((b) => b.const),
            "x-enumLabels": branches.map((b) => b.title ?? String(b.const)),
          })),
        );
        continue;
      }

      const flatBranches = branches.map((b) => this.flatten(b, path, values).schema);
      const titles = branches.map((b, i) => b.title ?? flatBranches[i]!.title ?? `Option ${i + 1}`);
      const discriminator = findDiscriminator(this.root, flatBranches);
      let selected: number;

      if (discriminator) {
        const consts = flatBranches.map((f) => deref(this.root, f.properties[discriminator]).const);
        const current = value && typeof value === "object" ? (value as any)[discriminator] : undefined;
        selected = consts.findIndex((c) => c === current);
        s = merge(
          s,
          this.derivedMemo.get(`disc:${idOf(raw)}`, () => ({
            properties: { [discriminator]: { enum: consts, "x-enumLabels": titles } },
            required: [discriminator],
          })),
        );
      } else {
        const picked = this.selections.get(path);
        selected =
          picked !== undefined && picked < branches.length
            ? picked
            : Math.max(0, branches.findIndex((b) => this.test(b, value)));
      }

      if (selected >= 0) take(this.flatten(branches[selected], path, values), ["title"]);
      combinator ??= { kind, branches, titles, selected, discriminator };
    }

    if (s["x-extend"]) {
      const ref = s["x-extend"] as AsyncSourceRef;
      s = without(s, "x-extend");
      const entry = this.readAsync(ref, values, path);
      extend = entry;
      if (entry.status === "success") take(this.flatten(entry.data, path, values), ["title"]);
    }

    if (s.properties) {
      // Hidden properties vanish here (and in nested flattens), so whether a condition is still
      // waiting for its source has to travel with the result for validation to see it.
      const own = this.withoutHidden(s, path, values);
      s = own.schema;
      if (own.waiting) waiting = { ...waiting, ...own.waiting };
    }
    return { schema: s, combinator, nullable, extend, waiting };
  }

  /**
   * Drop properties whose `x-hidden` holds, as if they sat under an unmet `if`, and note the ones
   * whose condition is still waiting for its source. Only the property's own schema (after $ref)
   * is checked, so recursive schemas stay finite.
   */
  private withoutHidden(s: Schema, path: string, values: unknown): { schema: Schema; waiting?: Record<string, Waiting> } {
    const hidden: string[] = [];
    let waiting: Record<string, Waiting> | undefined;
    for (const k of Object.keys(s.properties)) {
      const c = this.condition(s.properties[k], "x-hidden", path, k, values);
      if (c.holds) hidden.push(k);
      if (c.waiting) (waiting ??= {})[k] = c.waiting;
    }
    if (!hidden.length) return { schema: s, waiting };
    const schema = this.derivedMemo.get(`hide:${idOf(s)}:${JSON.stringify(hidden)}`, () => {
      const properties = { ...s.properties };
      for (const k of hidden) delete properties[k];
      const out: Schema = { ...s, properties };
      if (Array.isArray(s.required)) out.required = s.required.filter((k: string) => !hidden.includes(k));
      return out;
    });
    return { schema, waiting };
  }

  /** Does the `keyword` condition on child `key` of the object at `parent` hold, and is it waiting for data? */
  private condition(
    node: unknown,
    keyword: "x-hidden" | "x-disabled",
    parent: string,
    key: string | number,
    values: unknown,
  ): { holds: boolean; waiting?: Waiting } {
    const cond = deref(this.root, node)[keyword] as Condition | undefined;
    if (cond === undefined) return NOT_HELD;
    const self = joinPath(parent, key);
    if (!("logic" in cond)) return { holds: this.evalCondition(cond, parent, values, self) };
    const { result, waiting } = this.evalLogic(cond, values, self);
    return { holds: !!result, waiting };
  }

  /** The (unresolved) schema node at `path`, or undefined if that field is not active right now. */
  schemaAt(path: string, values: unknown): unknown {
    let node: unknown = this.root;
    let cur = "";
    for (const seg of parsePath(path)) {
      const { schema } = this.resolve(node, cur, values);
      const next = typeof seg === "number" ? schema.items : schema.properties?.[seg];
      if (next === undefined) return undefined;
      node = next;
      cur = joinPath(cur, seg);
    }
    return node;
  }

  requiredAt(path: string, values: unknown): boolean {
    const segs = parsePath(path);
    const last = segs.pop();
    if (typeof last !== "string") return false;
    const parentPath = formatPath(segs);
    const parent = this.schemaAt(parentPath, values);
    if (parent === undefined) return false;
    return !!this.resolve(parent, parentPath, values).schema.required?.includes(last);
  }

  /** Pick a branch of a oneOf/anyOf that has no discriminator. */
  select(path: string, index: number) {
    this.selections.set(path, index);
    this.notifier.notify();
  }

  /** Branch picks, for a draft snapshot. */
  getSelections(): Record<string, number> {
    return Object.fromEntries(this.selections);
  }

  /** Restore branch picks from a snapshot. */
  restoreSelections(selections: Record<string, number> | undefined) {
    this.selections = new Map(Object.entries(selections ?? {}));
    this.notifier.notify();
  }

  /** Load a node's `x-data` refs by name, for its control. Undefined when it has none. */
  readData(schema: Schema, path: string, values: unknown): Record<string, AsyncEntry> | undefined {
    const refs = schema["x-data"] as Record<string, AsyncSourceRef> | undefined;
    if (!refs) return undefined;
    const scope = this.scope(values, path);
    return Object.fromEntries(Object.entries(refs).map(([k, ref]) => [k, this.readAsync(ref, values, path, undefined, scope)]));
  }

  readOptions(schema: Schema, path: string, values: unknown): AsyncEntry<Option[]> | undefined {
    const ref = schema["x-options"] as AsyncSourceRef | undefined;
    return ref ? (this.readAsync(ref, values, path, []) as AsyncEntry<Option[]>) : undefined;
  }

  // ============================================================== hidden / disabled

  /**
   * Evaluate an `x-hidden` / `x-disabled` condition for the field at `self`, held by the object
   * at `base`: JSON Logic sees $self/$parent/$item of the field; a `path` test is relative to `base`.
   */
  evalCondition(cond: Condition, base: string, values: unknown, self = base): boolean {
    if ("logic" in cond) return !!this.evalLogic(cond, values, self).result;
    return this.test(cond.schema, getIn(values, resolveRelativePath(cond.path, base)));
  }

  /** Is the field at `path`, or any field above it, disabled by `x-disabled`? */
  disabledAt(path: string, values: unknown): boolean {
    let node: unknown = this.root;
    let cur = "";
    for (const seg of parsePath(path)) {
      const { schema } = this.resolve(node, cur, values);
      const next = typeof seg === "number" ? schema.items : schema.properties?.[seg];
      if (next === undefined || this.condition(next, "x-disabled", cur, seg, values).holds) return next !== undefined;
      node = next;
      cur = joinPath(cur, seg);
    }
    return false;
  }

  /**
   * The topmost data paths disabled by `x-disabled` (fields under them are implied). These are
   * treated like inactive fields: cleared, not validated, not submitted. Hidden fields need no
   * list: `x-hidden` removes them from the resolved schema.
   */
  disabledPaths(values: unknown): Set<string> {
    return this.scanDisabled(values).paths;
  }

  /** `disabledPaths`, plus the fields whose `x-disabled` is still waiting for its source. */
  private scanDisabled(values: unknown): { paths: Set<string>; waiting: Record<string, Waiting> } {
    const paths = new Set<string>();
    const waiting: Record<string, Waiting> = {};
    const check = (node: unknown, parent: string, key: string | number) => {
      const c = this.condition(node, "x-disabled", parent, key, values);
      if (c.waiting) waiting[joinPath(parent, key)] = c.waiting;
      if (c.holds) paths.add(joinPath(parent, key));
      return c.holds;
    };
    const walk = (node: unknown, path: string) => {
      const s = this.resolve(node, path, values).schema;
      const value = getIn(values, path);
      for (const k of Object.keys(s.properties ?? {})) {
        const child = joinPath(path, k);
        if (!check(s.properties[k], path, k) && getIn(values, child) !== undefined) walk(s.properties[k], child);
      }
      if (s.items !== undefined && Array.isArray(value))
        value.forEach((_, i) => {
          if (!check(s.items, path, i)) walk(s.items, joinPath(path, i));
        });
    };
    walk(this.root, "");
    return { paths, waiting };
  }

  // ============================================================== validation

  /**
   * Build a plain schema describing exactly what the user can use right now:
   * combinators resolved, inactive branches and x-hidden/x-disabled fields removed,
   * and loaded option lists turned into enums. Validating against this gives precise
   * per-field errors instead of "must match exactly one schema in oneOf".
   *
   * Fields without a value are not walked into: nothing below them can fail (a missing
   * required field is reported by its parent), and this keeps recursive schemas finite.
   */
  concretize(values: unknown): { schema: Schema; pending: string[]; failed: string[]; rules: Record<string, string> } {
    return this.reuse("concrete", values, () => this.concretizeNow(values));
  }

  private concretizeNow(values: unknown): { schema: Schema; pending: string[]; failed: string[]; rules: Record<string, string> } {
    const pending: string[] = [];
    const failed: string[] = [];
    const rules: Record<string, string> = {};
    const wait = (path: string, w: Waiting) => (w === "loading" ? pending : failed).push(path);
    const { paths: disabled, waiting: disabledWaiting } = this.scanDisabled(values);
    for (const [path, w] of Object.entries(disabledWaiting)) wait(path, w);
    // `optionsPath` is where x-options params are evaluated: for a multi-select's items that
    // is the array itself, matching what the UI loads.
    const walk = (node: unknown, path: string, optionsPath = path): Schema => {
      const r = this.resolve(node, path, values);
      const s = r.schema;
      const value = getIn(values, path);
      const out: Schema = { ...forValidation(s) };
      if (value === undefined && path) return out;

      if (r.extend?.status === "loading") pending.push(path);
      if (r.extend?.status === "error") failed.push(path);
      for (const [k, w] of Object.entries(r.waiting ?? {})) wait(joinPath(path, k), w);
      if (path && !isBlank(value)) this.checkRules(s, path, values, rules, pending);
      if (s.properties) {
        const visible = Object.keys(s.properties).filter((k) => !disabled.has(joinPath(path, k)));
        out.properties = Object.fromEntries(visible.map((k) => [k, walk(s.properties[k], joinPath(path, k))]));
        const required = (s.required ?? []).filter((k: string) => !disabled.has(joinPath(path, k)));
        if (required.length) out.required = required;
      }
      if (s.items !== undefined) {
        // One concrete schema per item, since conditions can differ between items.
        // An empty list has no items to check (and Ajv rejects `items: []`).
        if (Array.isArray(value) && value.length) {
          out.items = value.map((_, i) => walk(s.items, joinPath(path, i), path));
          out.additionalItems = false;
        }
      }
      const opts = (s["x-options"] as AsyncSourceRef | undefined)?.strict !== false && this.readOptions(s, optionsPath, values);
      if (opts && opts.status === "loading") pending.push(path);
      if (opts && opts.status === "success") out.enum = opts.data.map((o) => o.value);
      if (r.nullable) {
        if (out.type) out.type = [...new Set([...[out.type].flat(), "null"])];
        if (out.enum) out.enum = [...out.enum, null];
      }
      return out;
    };

    const schema = walk(this.root, "");
    return { schema: this.concreteMemo.get(JSON.stringify(schema), () => schema), pending, failed, rules };
  }

  /** Run the `x-validate` rules of the field at `path`; the first failing one reports. */
  private checkRules(s: Schema, path: string, values: unknown, out: Record<string, string>, pending: string[]) {
    const list = s["x-validate"] as Rule[] | Rule | undefined;
    for (const rule of [list ?? []].flat()) {
      const { result, waiting } = this.evalLogic(rule, values, path);
      if (waiting === "loading") pending.push(path);
      else if (waiting === "error") out[path] ??= RULE_LOAD_FAILED;
      else if (!result) out[path] ??= rule.message;
    }
  }

  /**
   * `x-validate` failures by field path, for showing live while the user types (before any submit).
   * Rules still waiting for their source report nothing yet. Reused while values and async data
   * are unchanged, so every field can read it cheaply.
   */
  ruleErrors(values: unknown): Record<string, string> {
    return this.check(values).rules;
  }

  /**
   * Reuse the last `slot` result while `values` is the same object and no loaded data changed.
   * The notifier counts data changes only while someone listens (a mounted form); without
   * listeners (server, tests) nothing is reused, which is always correct.
   */
  private reuse<T>(slot: "concrete" | "check", values: unknown, compute: () => T): T {
    if (!this.notifier.listening) return compute();
    // Read before computing: a fetch the computation starts bumps the version and expires this entry.
    const version = this.notifier.get();
    const last = this.lastResults[slot];
    if (last && last.values === values && last.version === version) return last.result as T;
    const result = compute();
    this.lastResults[slot] = { values, version, result };
    return result;
  }

  /**
   * Data paths of the active fields a layout element shows, relative paths resolved against
   * `base`. Empty when every field in it is hidden or inactive, so a step, tab or group with
   * nothing to show can be skipped.
   */
  fieldsOf(el: UIElement, base: string, values: unknown): string[] {
    if (!isControl(el)) return el.elements.flatMap((child) => this.fieldsOf(child, base, values));
    const path = resolveRelativePath(el.path, base);
    return this.schemaAt(path, values) === undefined ? [] : [path];
  }

  /** Does a layout element show at least one active field? (`fieldsOf`, stopping at the first.) */
  hasActiveField(el: UIElement, base: string, values: unknown): boolean {
    if (!isControl(el)) return el.elements.some((child) => this.hasActiveField(child, base, values));
    return this.schemaAt(resolveRelativePath(el.path, base), values) !== undefined;
  }

  /**
   * Paths that hold a value but whose field is gone (inactive branch, unmet `if`, x-hidden
   * or x-disabled). Parts still loading are left alone: their fields aren't known yet.
   */
  staleValues(values: unknown): string[] {
    const { schema, pending, failed } = this.concretize(values);
    const loading = [...pending, ...failed];
    const stale: string[] = [];
    prune(values, schema, (path) => {
      if (!loading.some((p) => isWithin(path, p))) stale.push(path);
    });
    return stale;
  }

  /**
   * Validate `values` and return the clean data to submit. readOnly computed fields are
   * recomputed first, so a tampered or stale derived value can't get through; editable
   * computes and prefills are assistive and left as sent.
   */
  validate(values: unknown): ValidationResult & { data: unknown } {
    return this.check(values).result;
  }

  /** Validation plus the rule failures on their own, so live rule errors match what submit sees. */
  private check(values: unknown): { result: ValidationResult & { data: unknown }; rules: Record<string, string> } {
    return this.reuse("check", values, () => this.checkNow(values));
  }

  private checkNow(input: unknown): { result: ValidationResult & { data: unknown }; rules: Record<string, string> } {
    const derived = this.withDerived(input);
    const values = derived.values;
    const { schema, pending, failed, rules } = this.concretize(values);
    const data = prune(values, schema);
    const fn = this.compile(schema);
    const ok = fn(data) as boolean;
    const fields: Record<string, string> = {};
    let form: string | undefined;
    for (const e of fn.errors ?? []) {
      const segs = parsePointer(e.instancePath);
      if (e.keyword === "required") segs.push((e.params as any).missingProperty);
      const name = formatPath(segs);
      const msg = this.messageFor(e);
      if (!name) form ??= msg;
      else fields[name] ??= msg;
    }
    for (const [path, msg] of Object.entries(rules)) fields[path] ??= msg;
    const rulesOk = !Object.keys(rules).length;
    if (failed.length) form ??= "Part of this form failed to load. Please retry.";
    if (pending.length || derived.waiting.length) form ??= "Some fields are still loading…";
    const valid = ok && rulesOk && !pending.length && !failed.length && !derived.waiting.length;
    return { result: { valid, fields, form, data }, rules };
  }

  private messageFor(e: ErrorObject): string {
    const custom = this.messages?.(e);
    if (custom) return custom;
    const parent = e.parentSchema as Schema | undefined;
    if (e.keyword === "required") {
      const prop = parent?.properties?.[(e.params as any).missingProperty];
      return prop?.["x-messages"]?.required ?? "This field is required";
    }
    const fromSchema = parent?.["x-messages"]?.[e.keyword];
    if (fromSchema) return fromSchema;
    if (e.keyword === "enum") return "Please choose one of the options";
    if (e.keyword === "format") return `Must be a valid ${(e.params as any).format}`;
    const m = e.message ?? "Invalid value";
    return m.charAt(0).toUpperCase() + m.slice(1);
  }

  // ============================================================== defaults

  defaults(node: unknown = this.root, path = "", values?: unknown): unknown {
    const { schema: s } = this.resolve(node, path, values);
    if (s.default !== undefined) return structuredClone(s.default);
    const type = primaryType(s);
    if (type === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(s.properties ?? {})) {
        const d = this.defaults(child, joinPath(path, k), values);
        if (d !== undefined) out[k] = d;
      }
      return out;
    }
    if (type === "array") return [];
    return undefined;
  }
}

// ---------------------------------------------------------------- utilities

function findDiscriminator(root: Schema, branches: Schema[]): string | undefined {
  const first = branches[0]?.properties;
  if (!first || branches.length < 2) return undefined;
  for (const key of Object.keys(first)) {
    const consts = branches.map((b) => {
      const p = b.properties?.[key];
      return p === undefined ? undefined : deref(root, p).const;
    });
    if (consts.every((c) => c !== undefined) && new Set(consts).size === consts.length) return key;
  }
  return undefined;
}

/** Keep only values that the concrete schema describes; `onDrop` hears each removed path. */
export function prune(value: unknown, schema: Schema | undefined, onDrop?: (path: string) => void, path = ""): unknown {
  if (!schema || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = schema.items;
    if (!items) return value;
    return value.map((v, i) => prune(v, Array.isArray(items) ? items[i] : items, onDrop, joinPath(path, i)));
  }
  if (value && typeof value === "object" && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (k in schema.properties) out[k] = prune(v, schema.properties[k], onDrop, joinPath(path, k));
      else onDrop?.(joinPath(path, k));
    }
    return out;
  }
  return value;
}

/** Schema features this renderer deliberately doesn't support. */
export function findUnsupported(root: Schema): string[] {
  const problems: string[] = [];
  const seen = new Set<object>();
  const visit = (s: unknown, at: string) => {
    if (!s || typeof s !== "object" || seen.has(s)) return;
    seen.add(s);
    const n = s as Schema;
    if (typeof n.$ref === "string" && !n.$ref.startsWith("#")) problems.push(`${at}: remote $ref "${n.$ref}"`);
    if (Array.isArray(n.items) || n.prefixItems) problems.push(`${at}: tuple arrays (items as array / prefixItems)`);
    if (n.patternProperties) problems.push(`${at}: patternProperties`);
    if (n.dependentSchemas) problems.push(`${at}: dependentSchemas (use if/then)`);
    if (n.dependencies && Object.values(n.dependencies).some((d) => !Array.isArray(d)))
      problems.push(`${at}: schema dependencies (use if/then)`);
    if (n.unevaluatedProperties !== undefined || n.unevaluatedItems !== undefined)
      problems.push(`${at}: unevaluatedProperties/unevaluatedItems`);
    for (const [k, v] of Object.entries(n.properties ?? {})) visit(v, `${at}/properties/${k}`);
    for (const k of ["items", "then", "else", "if", "additionalProperties", "not"]) visit(n[k], `${at}/${k}`);
    for (const k of ["allOf", "oneOf", "anyOf"])
      (n[k] ?? []).forEach((v: unknown, i: number) => visit(v, `${at}/${k}/${i}`));
    for (const k of ["definitions", "$defs"])
      for (const [dk, dv] of Object.entries(n[k] ?? {})) visit(dv, `${at}/${k}/${dk}`);
  };
  visit(root, "#");
  return problems;
}
