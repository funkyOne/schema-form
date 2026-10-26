import { describe, expect, it, vi } from "vitest";
import {
  FormEngine,
  formatPath,
  getIn,
  joinPath,
  parsePath,
  parsePointer,
  prune,
  resolveRelativePath,
  type Loaders,
  type Schema,
  type UIElement,
} from "../src/engine";

/**
 * Characterization tests for engine behaviour not covered by the demo schema.
 * Each test uses a small inline schema so it documents one feature.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));
const at = (e: FormEngine, path: string, values: unknown) => e.resolve(e.schemaAt(path, values), path, values);
const props = (e: FormEngine, path: string, values: unknown) => Object.keys(at(e, path, values).schema.properties ?? {});

describe("paths", () => {
  it("parses and formats TanStack-style paths", () => {
    expect(parsePath("a.b[0].c")).toEqual(["a", "b", 0, "c"]);
    expect(parsePath("")).toEqual([]);
    expect(formatPath(["a", 0, "b"])).toBe("a[0].b");
    expect(formatPath([0, "a"])).toBe("[0].a");
    expect(joinPath("", "a")).toBe("a");
    expect(joinPath("a", 1)).toBe("a[1]");
    expect(joinPath("a[1]", "b")).toBe("a[1].b");
  });

  it("resolves UI-schema paths relative to a base", () => {
    expect(resolveRelativePath("/x.y", "claims[0]")).toBe("x.y");
    expect(resolveRelativePath("type", "claims[0]")).toBe("claims[0].type");
    expect(resolveRelativePath("type", "")).toBe("type");
    expect(resolveRelativePath("", "a")).toBe("a");
    expect(resolveRelativePath("[1]", "a")).toBe("a[1]");
  });

  it("reads values and JSON pointers", () => {
    expect(getIn({ a: [{ b: 1 }] }, "a[0].b")).toBe(1);
    expect(getIn({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(parsePointer("/a/0/b~1c~0d")).toEqual(["a", 0, "b/c~d"]);
    expect(parsePointer("")).toEqual([]);
  });
});

describe("$ref and allOf", () => {
  it("merges allOf members: properties combined, required unioned", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        allOf: [
          { properties: { a: { type: "string" } }, required: ["a"] },
          { properties: { a: { minLength: 2 }, b: { type: "number" } }, required: ["b"] },
        ],
      },
    });
    expect(props(e, "", {})).toEqual(["a", "b"]);
    expect(at(e, "", {}).schema.required).toEqual(["a", "b"]);
    expect(at(e, "a", {}).schema).toMatchObject({ type: "string", minLength: 2 });
    expect(e.validate({ a: "x", b: 1 }).fields.a).toBeDefined();
    expect(e.validate({ a: "xy", b: 1 }).valid).toBe(true);
    expect(e.validate({ a: "xy" }).fields.b).toBe("This field is required");
  });

  it("follows $ref chains in definitions and $defs, keeping sibling keywords", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        definitions: { name: { $ref: "#/$defs/str", title: "Name" } },
        $defs: { str: { type: "string", title: "Text", minLength: 1 } },
        properties: { n: { $ref: "#/definitions/name", description: "Your name" } },
      },
    });
    expect(at(e, "n", {}).schema).toMatchObject({ type: "string", title: "Name", minLength: 1, description: "Your name" });
  });

  it("supports recursive schemas lazily when resolving by path", () => {
    const e = new FormEngine({
      schema: {
        definitions: { node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/definitions/node" } } } },
        $ref: "#/definitions/node",
      },
    });
    expect(props(e, "child.child.child", {})).toEqual(["name", "child"]);
  });

  it("throws on $ref cycles and unresolvable refs", () => {
    const cyc = new FormEngine({
      schema: {
        definitions: { a: { $ref: "#/definitions/b" }, b: { $ref: "#/definitions/a" } },
        properties: { x: { $ref: "#/definitions/a" } },
      },
    });
    expect(() => at(cyc, "x", {})).toThrow(/cycle/);
    const missing = new FormEngine({ schema: { properties: { x: { $ref: "#/definitions/nope" } } } });
    expect(() => at(missing, "x", {})).toThrow(/Unresolvable/);
  });
});

describe("if / then / else", () => {
  const e = new FormEngine({
    schema: {
      type: "object",
      properties: { kind: { type: "string" } },
      if: { properties: { kind: { const: "a" } }, required: ["kind"] },
      then: { properties: { onlyA: { type: "string" } }, required: ["onlyA"] },
      else: { properties: { notA: { type: "string" } } },
    },
  });

  it("applies then or else at the root", () => {
    expect(props(e, "", { kind: "a" })).toEqual(["kind", "onlyA"]);
    expect(props(e, "", { kind: "b" })).toEqual(["kind", "notA"]);
    expect(props(e, "", {})).toEqual(["kind", "notA"]);
    expect(e.schemaAt("onlyA", { kind: "b" })).toBeUndefined();
  });

  it("validates and prunes by the active branch", () => {
    expect(e.validate({ kind: "a" }).fields.onlyA).toBe("This field is required");
    expect(e.validate({ kind: "b", onlyA: "x", notA: "y" }).data).toEqual({ kind: "b", notA: "y" });
  });

  it("applies if/then inside a oneOf branch", async () => {
    const { schema, createLoaders } = await import("../src/demo/schema");
    const demo = new FormEngine({ schema, loaders: createLoaders(0) });
    const applicant = { kind: "company", companyName: "ACME", vatRegistered: true };
    expect(demo.validate({ applicant }).fields["applicant.vatNumber"]).toBe("This field is required");
    expect(demo.validate({ applicant: { ...applicant, vatRegistered: false } }).fields["applicant.vatNumber"]).toBeUndefined();
  });
});

describe("oneOf / anyOf", () => {
  it("treats anyOf [X, null] as nullable X", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: {
          n: { anyOf: [{ type: "string", minLength: 2 }, { type: "null" }] },
          c: { anyOf: [{ enum: ["a", "b"] }, { type: "null" }] },
        },
      },
    });
    const n = at(e, "n", {});
    expect(n.nullable).toBe(true);
    expect(n.combinator).toBeUndefined();
    expect(n.schema.type).toBe("string");
    expect(e.validate({ n: null, c: null }).valid).toBe(true);
    expect(e.validate({}).valid).toBe(true);
    expect(e.validate({ n: "x" }).fields.n).toBeDefined();
    expect(e.validate({ c: "z" }).fields.c).toBe("Please choose one of the options");
  });

  it("requires the discriminator before a branch is picked", async () => {
    const { schema, createLoaders } = await import("../src/demo/schema");
    const e = new FormEngine({ schema, loaders: createLoaders(0) });
    expect(e.validate({ applicant: {} }).fields["applicant.kind"]).toBe("This field is required");
  });

  it("lets the user pick an anyOf branch without discriminator, with fallback titles", () => {
    const e = new FormEngine({
      schema: {
        properties: {
          x: {
            anyOf: [
              { type: "object", properties: { a: { type: "string" } } },
              { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
            ],
          },
        },
      },
    });
    const r = at(e, "x", {});
    expect(r.combinator).toMatchObject({ kind: "anyOf", titles: ["Option 1", "Option 2"], selected: 0 });
    expect(props(e, "x", {})).toEqual(["a"]);
    e.select("x", 1);
    expect(props(e, "x", {})).toEqual(["b"]);
    expect(e.validate({ x: {} }).fields["x.b"]).toBe("This field is required");
    e.select("x", 99); // out of range falls back to the first matching branch
    expect(at(e, "x", {}).combinator?.selected).toBe(0);
  });

  it("notifies subscribers when a branch is picked", () => {
    const e = new FormEngine({ schema: { properties: { x: { oneOf: [{ type: "string" }, { type: "number" }] } } } });
    const fn = vi.fn();
    e.notifier.subscribe(fn);
    const before = e.notifier.get();
    e.select("x", 1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(e.notifier.get()).not.toBe(before);
  });
});

describe("validation messages and pruning", () => {
  const schema: Schema = {
    type: "object",
    properties: {
      email: { type: "string", format: "email" },
      name: { type: "string", minLength: 3, "x-messages": { required: "Tell us your name", minLength: "Too short" } },
      size: { enum: ["s", "m"] },
    },
    required: ["name"],
  };

  it("uses x-messages, built-in defaults and a messages override", () => {
    const e = new FormEngine({ schema });
    expect(e.validate({}).fields).toEqual({ name: "Tell us your name" });
    expect(e.validate({ name: "ab", email: "nope", size: "xl" }).fields).toEqual({
      name: "Too short",
      email: "Must be a valid email",
      size: "Please choose one of the options",
    });
    const custom = new FormEngine({ schema, messages: (err) => (err.keyword === "format" ? "Bad email" : undefined) });
    expect(custom.validate({ name: "abc", email: "nope" }).fields).toEqual({ email: "Bad email" });
  });

  it("reports root-level errors as a form error", () => {
    const e = new FormEngine({ schema: { type: "object", properties: { a: { type: "string" } }, minProperties: 1 } });
    const r = e.validate({});
    expect(r.valid).toBe(false);
    expect(r.form).toMatch(/fewer than 1/);
  });

  it("prunes values the schema does not describe", () => {
    const s: Schema = {
      properties: { list: { items: { properties: { keep: {} } } }, obj: { properties: { keep: {} } }, any: {} },
    };
    expect(prune({ list: [{ keep: 1, drop: 2 }], obj: { keep: 1, drop: 2 }, any: { x: 1 }, drop: 1 }, s)).toEqual({
      list: [{ keep: 1 }],
      obj: { keep: 1 },
      any: { x: 1 },
    });
  });

  it("removes inactive and hidden data but keeps it in the input", () => {
    const e = new FormEngine({
      schema: { type: "object", properties: { show: { type: "boolean" }, extra: { type: "string" } }, required: ["extra"] },
      uischema: {
        type: "VerticalLayout",
        elements: [
          { type: "Control", path: "show" },
          { type: "Control", path: "extra", rule: { effect: "SHOW", condition: { logic: { var: "show" } } } },
        ],
      },
    });
    const values = { show: false, extra: "x" };
    const r = e.validate(values);
    expect(r).toMatchObject({ valid: true, data: { show: false } });
    expect(values.extra).toBe("x");
  });
});

describe("async sources", () => {
  function setup(impl: Loaders[string] = async () => [{ value: 1, label: "One" }]) {
    const loader = vi.fn(impl);
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: {
          parent: { type: "string" },
          child: { type: "number", "x-options": { source: "list", params: { p: { var: "parent" } } } },
        },
      },
      loaders: { list: loader },
    });
    const read = (v: object) => e.readOptions(at(e, "child", v).schema, "child", v);
    return { e, loader, read };
  }

  it("stays idle while any param is empty, then loads once per params", async () => {
    const { loader, read } = setup();
    expect(read({})?.status).toBe("idle");
    expect(read({ parent: "" })?.status).toBe("idle");
    expect(read({ parent: null })?.status).toBe("idle");
    expect(loader).not.toHaveBeenCalled();
    expect(read({ parent: "a" })?.status).toBe("loading");
    expect(read({ parent: "a" })?.status).toBe("loading");
    await flush();
    expect(read({ parent: "a" })).toEqual({ status: "success", data: [{ value: 1, label: "One" }] });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader.mock.calls[0]![0]).toEqual({ p: "a" });
    read({ parent: "b" });
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("returns undefined options when the schema has no x-options", () => {
    const { e } = setup();
    expect(e.readOptions({ type: "string" }, "parent", {})).toBeUndefined();
  });

  it("reports errors and retries on demand", async () => {
    let fail = true;
    const { e, read } = setup(async () => {
      if (fail) throw new Error("boom");
      return [];
    });
    read({ parent: "a" });
    await flush();
    const err = read({ parent: "a" });
    expect(err?.status).toBe("error");
    expect(e.validate({ parent: "a" }).form).toBeUndefined(); // option errors don't block validation

    fail = false;
    const notified = vi.fn();
    e.notifier.subscribe(notified);
    if (err?.status === "error") err.retry();
    expect(notified).toHaveBeenCalled();
    expect(read({ parent: "a" })?.status).toBe("loading");
    await flush();
    expect(read({ parent: "a" })?.status).toBe("success");
  });

  it("reports a missing loader as an error", () => {
    const e = new FormEngine({ schema: { properties: { x: { "x-options": { source: "nope" } } } } });
    const entry = e.readOptions(at(e, "x", {}).schema, "x", {});
    expect(entry?.status).toBe("error");
    expect(entry?.status === "error" && String(entry.error)).toMatch(/No loader registered for source "nope"/);
  });

  it("invalidates entries, aborting requests in flight and ignoring their results", async () => {
    let signal: AbortSignal | undefined;
    let n = 0;
    const { e, read } = setup(async (_p, ctx) => {
      signal = ctx.signal;
      return [{ value: ++n, label: String(n) }];
    });
    read({ parent: "a" });
    e.cache.invalidate("list");
    expect(signal?.aborted).toBe(true);
    expect(read({ parent: "a" })?.status).toBe("loading");
    await flush();
    const entry = read({ parent: "a" });
    expect(entry?.status === "success" && entry.data).toEqual([{ value: 2, label: "2" }]);
  });

  it("blocks validation while an x-extend fragment is loading or failed", async () => {
    let fail = false;
    const e = new FormEngine({
      schema: { type: "object", properties: { d: { type: "object", "x-extend": { source: "frag" } } } },
      loaders: {
        frag: async () => {
          if (fail) throw new Error("x");
          return { properties: { z: { type: "string" } }, required: ["z"] };
        },
      },
    });
    expect(e.validate({}).form).toMatch(/still loading/);
    await flush();
    expect(e.validate({}).fields["d.z"]).toBe("This field is required");

    fail = true;
    e.cache.invalidate();
    e.validate({});
    await flush();
    const r = e.validate({ d: { z: "ok" } });
    expect(r.valid).toBe(false);
    expect(r.form).toMatch(/failed to load/);
    expect(at(e, "d", {}).extend?.status).toBe("error");
  });

  it("evaluates $self, $parent and $item in params", async () => {
    const loader = vi.fn(async () => []);
    const e = new FormEngine({
      schema: {
        properties: {
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                a: { type: "string" },
                b: { "x-options": { source: "s", params: { self: { var: "$self" }, parent: { var: "$parent.a" }, item: { var: "$item.a" } } } },
              },
            },
          },
        },
      },
      loaders: { s: loader },
    });
    const v = { rows: [{ a: "x", b: "y" }] };
    e.readOptions(at(e, "rows[0].b", v).schema, "rows[0].b", v);
    expect(loader).toHaveBeenCalledWith({ self: "y", parent: "x", item: "x" }, expect.anything());
  });
});

describe("rules", () => {
  const e = new FormEngine({ schema: { properties: {} } });
  const yes = { logic: true };
  const no = { logic: false };

  it("combines HIDE / SHOW / DISABLE / ENABLE", () => {
    expect(e.ruleState(undefined, "", {})).toEqual({ hidden: false, disabled: false });
    expect(e.ruleState({ effect: "HIDE", condition: yes }, "", {})).toEqual({ hidden: true, disabled: false });
    expect(e.ruleState({ effect: "HIDE", condition: no }, "", {}).hidden).toBe(false);
    expect(e.ruleState({ effect: "ENABLE", condition: no }, "", {})).toEqual({ hidden: false, disabled: true });
    expect(e.ruleState({ effect: "ENABLE", condition: yes }, "", {}).disabled).toBe(false);
    expect(
      e.ruleState(
        [
          { effect: "SHOW", condition: no },
          { effect: "DISABLE", condition: yes },
        ],
        "",
        {},
      ),
    ).toEqual({ hidden: true, disabled: true });
  });

  it("returns the same object for the same state", () => {
    const a = e.ruleState({ effect: "HIDE", condition: { logic: { var: "x" } } }, "", { x: 1 });
    const b = e.ruleState({ effect: "HIDE", condition: { logic: { var: "x" } } }, "", { x: 2 });
    expect(a).toBe(b);
  });

  it("resolves schema-condition paths relative to the base, or absolute with /", () => {
    const vals = { flag: true, group: { flag: false } };
    const rel = { effect: "HIDE", condition: { path: "flag", schema: { const: true } } } as const;
    const abs = { effect: "HIDE", condition: { path: "/flag", schema: { const: true } } } as const;
    expect(e.ruleState(rel, "group", vals).hidden).toBe(false);
    expect(e.ruleState(abs, "group", vals).hidden).toBe(true);
    expect(e.ruleState({ effect: "HIDE", condition: { logic: { var: "$parent.flag" } } }, "group.x", vals).hidden).toBe(false);
  });

  it("collects controls hidden directly, by a hidden layout, or inside object details", () => {
    const uischema: UIElement = {
      type: "VerticalLayout",
      elements: [
        { type: "Group", rule: { effect: "HIDE", condition: yes }, elements: [{ type: "Control", path: "a" }] },
        {
          type: "Control",
          path: "obj",
          options: {
            detail: { type: "VerticalLayout", elements: [{ type: "Control", path: "inner", rule: { effect: "HIDE", condition: { logic: { var: "$parent.off" } } } }] },
          },
        },
        {
          type: "Control",
          path: "gone",
          rule: { effect: "HIDE", condition: yes },
          options: { detail: { type: "Control", path: "never" } },
        },
      ],
    };
    const eng = new FormEngine({ schema: { properties: {} }, uischema });
    expect([...eng.collectHidden({ obj: { off: true } })].sort()).toEqual(["a", "gone", "obj.inner"]);
    expect([...eng.collectHidden({ obj: { off: false } })].sort()).toEqual(["a", "gone"]);
  });
});

describe("defaults", () => {
  it("builds defaults for objects, arrays and the selected branch", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: {
          n: { type: "number", default: 3 },
          obj: { type: "object", properties: { s: { type: "string", default: "x" }, t: { type: "string" } } },
          preset: { type: "object", default: { a: 1 }, properties: { a: { default: 2 } } },
          list: { type: "array", items: { type: "string" } },
          pick: { oneOf: [{ type: "object", properties: { p: { default: 1 } } }, { type: "object", properties: { q: { default: 2 } } }] },
        },
      },
    });
    expect(e.defaults()).toEqual({ n: 3, obj: { s: "x" }, preset: { a: 1 }, list: [], pick: { p: 1 } });
    e.select("pick", 1);
    expect(e.defaults(e.schemaAt("pick", {}), "pick")).toEqual({ q: 2 });
  });

  it("returns copies, not the schema's own default objects", () => {
    const schema = { properties: { o: { type: "object", default: { a: 1 } } } };
    const e = new FormEngine({ schema });
    (e.defaults() as any).o.a = 2;
    expect(schema.properties.o.default.a).toBe(1);
  });
});
