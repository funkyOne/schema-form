import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import jsonLogic from "json-logic-js";
import { AsyncCache, Notifier } from "./async";
import { getIn, joinPath, parsePath, parsePointer, formatPath, resolveRelativePath } from "./path";
import { deref, derived, idOf, Memo, merge, normalize, primaryType, without } from "./schema-ops";
import type {
  AsyncEntry,
  AsyncSourceRef,
  Combinator,
  Condition,
  Loaders,
  Option,
  Resolved,
  Rule,
  Schema,
  UIElement,
  ValidationResult,
} from "./types";

export interface EngineOptions {
  schema: Schema;
  uischema?: UIElement;
  loaders?: Loaders;
  /** Custom error text. Return undefined to fall back to the defaults. */
  messages?: (error: ErrorObject) => string | undefined;
  /** Throw on schema features the renderer can't handle (default true). */
  strict?: boolean;
}

export interface RuleState {
  hidden: boolean;
  disabled: boolean;
}
const RULE_STATES: Record<string, RuleState> = {
  "00": Object.freeze({ hidden: false, disabled: false }),
  "01": Object.freeze({ hidden: false, disabled: true }),
  "10": Object.freeze({ hidden: true, disabled: false }),
  "11": Object.freeze({ hidden: true, disabled: true }),
};

const STRIP_FOR_VALIDATION = ["properties", "items", "required", "x-options", "x-enumLabels", "x-extend", "$schema"];

type Flat = { schema: Schema; combinator?: Combinator; nullable: boolean; extend?: AsyncEntry };

export class FormEngine {
  readonly root: Schema;
  readonly uischema?: UIElement;
  /** Bumps when async data arrives or a oneOf branch is picked; React subscribes to it. */
  readonly notifier = new Notifier();
  readonly cache: AsyncCache;
  /** User-picked branch for oneOf/anyOf without a discriminator, by field path. */
  private selections = new Map<string, number>();

  private ajv: Ajv;
  private testers = new WeakMap<object, ValidateFunction>();
  private validators = new WeakMap<object, ValidateFunction>();
  private resolvedMemo = new Memo<Resolved>();
  private concreteMemo = new Memo<Schema>();
  private derivedEnum = new WeakMap<object, Schema>();
  private derivedDisc = new WeakMap<object, Schema>();
  private derivedBranches = new WeakMap<object, Schema[]>();
  private messages?: EngineOptions["messages"];

  constructor(opts: EngineOptions) {
    this.root = opts.schema;
    this.uischema = opts.uischema;
    this.messages = opts.messages;
    this.cache = new AsyncCache(opts.loaders ?? {}, this.notifier);
    this.ajv = new Ajv({ allErrors: true, strict: false, verbose: true });
    addFormats(this.ajv);
    if (opts.strict !== false) {
      const problems = findUnsupported(this.root);
      if (problems.length) throw new Error("Unsupported schema features:\n- " + problems.join("\n- "));
    }
  }

  // ============================================================== helpers

  /** Does `value` satisfy `schema`? Compiled once per schema object. */
  test(schema: unknown, value: unknown): boolean {
    const s = normalize(schema);
    let fn = this.testers.get(s);
    if (!fn) {
      fn = this.ajv.compile({ ...without(s, "$schema"), definitions: this.root.definitions, $defs: this.root.$defs });
      this.testers.set(s, fn);
    }
    return fn(value) as boolean;
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

  readAsync(ref: AsyncSourceRef, values: unknown, path: string): AsyncEntry {
    const scope = this.scope(values, path);
    const params: Record<string, unknown> = {};
    for (const [k, expr] of Object.entries(ref.params ?? {})) params[k] = jsonLogic.apply(expr as any, scope);
    return this.cache.read(ref.source, params);
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
    ].join("|");
    return this.resolvedMemo.get(key, () => ({ ...flat }));
  }

  private flatten(node: unknown, path: string, values: unknown): Flat {
    const value = getIn(values, path);
    let s = deref(this.root, node);
    let combinator: Combinator | undefined;
    let nullable = false;
    let extend: AsyncEntry | undefined;
    const take = (r: Flat, strip: string[] = []) => {
      s = merge(s, strip.length ? without(r.schema, ...strip) : r.schema);
      combinator ??= r.combinator;
      nullable ||= r.nullable;
      extend ??= r.extend;
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
      const branches = derived(this.derivedBranches, raw, () => raw.map((b) => deref(this.root, b)));
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
          derived(this.derivedEnum, raw, () => ({
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
          derived(this.derivedDisc, raw, () => ({
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

    return { schema: s, combinator, nullable, extend };
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

  readOptions(schema: Schema, path: string, values: unknown): AsyncEntry<Option[]> | undefined {
    const ref = schema["x-options"] as AsyncSourceRef | undefined;
    return ref ? (this.readAsync(ref, values, path) as AsyncEntry<Option[]>) : undefined;
  }

  // ============================================================== rules

  ruleState(rule: Rule | Rule[] | undefined, base: string, values: unknown): RuleState {
    if (!rule) return RULE_STATES["00"]!;
    let hidden = false;
    let disabled = false;
    for (const r of Array.isArray(rule) ? rule : [rule]) {
      const hit = this.evalCondition(r.condition, base, values);
      if (r.effect === "HIDE" && hit) hidden = true;
      if (r.effect === "SHOW" && !hit) hidden = true;
      if (r.effect === "DISABLE" && hit) disabled = true;
      if (r.effect === "ENABLE" && !hit) disabled = true;
    }
    return RULE_STATES[`${+hidden}${+disabled}`]!;
  }

  evalCondition(cond: Condition, base: string, values: unknown): boolean {
    if ("logic" in cond) return !!jsonLogic.apply(cond.logic as any, this.scope(values, base));
    return this.test(cond.schema, getIn(values, resolveRelativePath(cond.path, base)));
  }

  /** Every data path whose control is hidden by a UI rule (directly or via a hidden layout). */
  collectHidden(values: unknown): Set<string> {
    const hidden = new Set<string>();
    const walk = (el: UIElement, base: string, parentHidden: boolean) => {
      const isHidden = parentHidden || this.ruleState(el.rule, base, values).hidden;
      if (el.type === "Control") {
        const path = resolveRelativePath(el.path, base);
        if (isHidden) hidden.add(path);
        const detail = el.options?.detail;
        if (!detail || isHidden) return;
        const v = getIn(values, path);
        if (Array.isArray(v)) v.forEach((_, i) => walk(detail, joinPath(path, i), false));
        else walk(detail, path, false);
        return;
      }
      for (const child of el.elements) walk(child, base, isHidden);
    };
    if (this.uischema) walk(this.uischema, "", false);
    return hidden;
  }

  // ============================================================== validation

  /**
   * Build a plain schema describing exactly what the user can see right now:
   * combinators resolved, inactive branches and rule-hidden fields removed, and
   * loaded option lists turned into enums. Validating against this gives precise
   * per-field errors instead of "must match exactly one schema in oneOf".
   */
  concretize(
    values: unknown,
    hidden = this.collectHidden(values),
  ): { schema: Schema; pending: string[]; failed: string[] } {
    const pending: string[] = [];
    const failed: string[] = [];
    const walk = (node: unknown, path: string): { schema: Schema; key: string } => {
      const r = this.resolve(node, path, values);
      const s = r.schema;
      const value = getIn(values, path);
      const keyParts: string[] = [String(idOf(s))];
      if (r.extend?.status === "loading") pending.push(path);
      if (r.extend?.status === "error") failed.push(path);

      let properties: Record<string, Schema> | undefined;
      let required: string[] | undefined;
      if (s.properties) {
        properties = {};
        for (const k of Object.keys(s.properties)) {
          const p = joinPath(path, k);
          if (hidden.has(p)) continue;
          const child = walk(s.properties[k], p);
          properties[k] = child.schema;
          keyParts.push(`${k}:${child.key}`);
        }
        const req: string[] = (s.required ?? []).filter((k: string) => !hidden.has(joinPath(path, k)));
        required = req;
        keyParts.push(`r:${req.join(",")}`);
      }

      let items: Schema | Schema[] | undefined;
      if (s.items !== undefined) {
        if (Array.isArray(value)) {
          const kids = value.map((_, i) => walk(s.items, joinPath(path, i)));
          items = kids.map((k) => k.schema);
          keyParts.push(`[${kids.map((k) => k.key).join(",")}]`);
        } else {
          const t = walk(s.items, joinPath(path, 0));
          items = t.schema;
          keyParts.push(`t:${t.key}`);
        }
      }

      let optionValues: unknown[] | undefined;
      const opts = this.readOptions(s, path, values);
      if (opts?.status === "loading") pending.push(path);
      if (opts?.status === "success") {
        optionValues = opts.data.map((o) => o.value);
        keyParts.push(`o:${idOf(opts)}`);
      }
      if (r.nullable) keyParts.push("null");

      const key = keyParts.join(";");
      const schema = this.concreteMemo.get(key, () => {
        const out: Schema = { ...without(s, ...STRIP_FOR_VALIDATION) };
        if (properties) out.properties = properties;
        if (required?.length) out.required = required;
        if (Array.isArray(items)) {
          out.items = items;
          out.additionalItems = false;
        } else if (items) out.items = items;
        if (optionValues) out.enum = optionValues;
        if (r.nullable) {
          if (out.type) out.type = [...new Set([...[out.type].flat(), "null"])];
          if (out.enum) out.enum = [...out.enum, null];
        }
        return out;
      });
      return { schema, key };
    };

    const { schema } = walk(this.root, "");
    return { schema, pending, failed };
  }

  validate(values: unknown): ValidationResult & { data: unknown } {
    const { schema, pending, failed } = this.concretize(values);
    const data = prune(values, schema);
    let fn = this.validators.get(schema);
    if (!fn) {
      fn = this.ajv.compile({ ...schema, definitions: this.root.definitions, $defs: this.root.$defs });
      this.validators.set(schema, fn);
    }
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
    if (failed.length) form ??= "Part of this form failed to load. Please retry.";
    if (pending.length) form ??= "Some fields are still loading…";
    return { valid: ok && !pending.length && !failed.length, fields, form, data };
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

/** Keep only values that the concrete schema describes. */
export function prune(value: unknown, schema: Schema | undefined): unknown {
  if (!schema || value === undefined) return value;
  if (Array.isArray(value)) {
    const items = schema.items;
    if (!items) return value;
    return value.map((v, i) => prune(v, Array.isArray(items) ? items[i] : items));
  }
  if (value && typeof value === "object" && schema.properties) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(schema.properties)) {
      const v = (value as any)[k];
      if (v !== undefined) out[k] = prune(v, schema.properties[k]);
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
