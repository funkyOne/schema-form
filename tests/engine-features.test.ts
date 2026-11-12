import { describe, expect, it, vi } from "vitest";
import {
  createQueryClient,
  FormEngine,
  QUERY_KEY,
  formatPath,
  getIn,
  joinPath,
  parsePath,
  parsePointer,
  prune,
  pruneProvenance,
  resolveRelativePath,
  withSource,
  withoutIndex,
  withoutPath,
  type Loaders,
  type Schema,
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

  it("validates recursive schemas", () => {
    const e = new FormEngine({
      schema: {
        definitions: {
          node: { type: "object", properties: { name: { type: "string" }, child: { $ref: "#/definitions/node" } }, required: ["name"] },
        },
        $ref: "#/definitions/node",
      },
    });
    expect(e.validate({ name: "a", child: { name: "b", child: {} } }).fields).toEqual({ "child.child.name": "This field is required" });
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
      schema: {
        type: "object",
        properties: { show: { type: "boolean" }, extra: { type: "string", "x-hidden": { logic: { "!": { var: "show" } } } } },
        required: ["extra"],
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

    expect(read({ parent: "a" })).toBe(err); // a failed query waits for retry
    fail = false;
    const notified = vi.fn();
    e.notifier.subscribe(notified);
    if (err?.status === "error") err.retry();
    expect(read({ parent: "a" })?.status).toBe("loading");
    await flush();
    expect(notified).toHaveBeenCalled();
    expect(read({ parent: "a" })?.status).toBe("success");
  });

  it("reports a missing loader as an error", async () => {
    const e = new FormEngine({ schema: { properties: { x: { "x-options": { source: "nope" } } } } });
    e.readOptions(at(e, "x", {}).schema, "x", {});
    await flush();
    const entry = e.readOptions(at(e, "x", {}).schema, "x", {});
    expect(entry?.status).toBe("error");
    expect(entry?.status === "error" && String(entry.error)).toMatch(/No loader registered for source "nope"/);
  });

  it("refetches after invalidateQueries, showing the old data meanwhile", async () => {
    let n = 0;
    const { e, read } = setup(async () => [{ value: ++n, label: String(n) }]);
    read({ parent: "a" });
    await flush();
    const first = read({ parent: "a" });
    expect(read({ parent: "a" })).toBe(first); // stable while unchanged
    await e.queryClient.invalidateQueries({ queryKey: [QUERY_KEY, "list"] });
    expect(read({ parent: "a" })).toBe(first);
    await flush();
    const entry = read({ parent: "a" });
    expect(entry?.status === "success" && entry.data).toEqual([{ value: 2, label: "2" }]);
  });

  it("passes an abort signal that fires when the query is cancelled", async () => {
    let signal: AbortSignal | undefined;
    const { e, read } = setup((_p, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    read({ parent: "a" });
    await e.queryClient.cancelQueries();
    expect(signal?.aborted).toBe(true);
  });

  it("shares results between engines that share a query client", async () => {
    const queryClient = createQueryClient();
    const loader = vi.fn(async () => [{ value: 1, label: "One" }]);
    const make = () =>
      new FormEngine({ schema: { properties: { c: { "x-options": { source: "s" } } } }, loaders: { s: loader }, queryClient });
    const a = make();
    a.readOptions(at(a, "c", {}).schema, "c", {});
    await flush();
    const b = make();
    expect(b.readOptions(at(b, "c", {}).schema, "c", {})?.status).toBe("success");
    expect(loader).toHaveBeenCalledTimes(1);
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
    expect(e.validate({ d: {} }).form).toMatch(/still loading/);
    await flush();
    expect(e.validate({ d: {} }).fields["d.z"]).toBe("This field is required");

    fail = true;
    await e.queryClient.invalidateQueries();
    e.validate({ d: {} });
    await flush();
    const r = e.validate({ d: { z: "ok" } });
    expect(r.valid).toBe(false);
    expect(r.form).toMatch(/failed to load/);
    expect(at(e, "d", {}).extend?.status).toBe("error");
    expect(e.validate({}).valid).toBe(true); // an absent object has nothing left to load
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

describe("x-hidden / x-disabled", () => {
  const yes = { logic: true };
  const no = { logic: false };
  const flagged = (cond: object) =>
    new FormEngine({
      schema: { properties: { flag: { type: "boolean" }, group: { type: "object", properties: { flag: { type: "boolean" }, x: { type: "string", "x-hidden": cond } } } } },
    });

  it("removes hidden properties from the resolved schema and its required list", () => {
    const e = new FormEngine({
      schema: { type: "object", properties: { a: { type: "string", "x-hidden": yes }, b: { type: "string", "x-hidden": no } }, required: ["a", "b"] },
    });
    const r = e.resolve(e.root, "", {}).schema;
    expect(Object.keys(r.properties)).toEqual(["b"]);
    expect(r.required).toEqual(["b"]);
    expect(e.resolve(e.root, "", {})).toBe(e.resolve(e.root, "", { other: 1 }));
  });

  it("resolves schema-condition paths relative to the holding object, or absolute with /", () => {
    const vals = { flag: true, group: { flag: false } };
    expect(flagged({ path: "flag", schema: { const: true } }).schemaAt("group.x", vals)).toBeDefined();
    expect(flagged({ path: "/flag", schema: { const: true } }).schemaAt("group.x", vals)).toBeUndefined();
    expect(flagged({ logic: { var: "$parent.flag" } }).schemaAt("group.x", vals)).toBeDefined();
    expect(flagged({ logic: { var: "flag" } }).schemaAt("group.x", vals)).toBeUndefined();
  });

  it("applies x-hidden inside if/then, $ref targets and fetched fragments", async () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        definitions: { hiddenStr: { type: "string", "x-hidden": yes } },
        properties: { r: { $ref: "#/definitions/hiddenStr" }, d: { type: "object", "x-extend": { source: "f" } } },
        if: { properties: {} },
        then: { properties: { t: { type: "string", "x-hidden": yes } } },
      },
      loaders: { f: async () => ({ properties: { inner: { type: "string", "x-hidden": yes }, keep: { type: "string" } } }) },
    });
    const v = { d: {} };
    e.resolve(e.schemaAt("d", v), "d", v);
    await flush();
    expect(Object.keys(e.resolve(e.root, "", v).schema.properties)).toEqual(["d"]);
    expect(Object.keys(e.resolve(e.schemaAt("d", v), "d", v).schema.properties)).toEqual(["keep"]);
  });

  it("lists the topmost disabled paths, per array item, including fields with no value", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: {
          off: { type: "string", "x-disabled": yes },
          obj: { type: "object", "x-disabled": { logic: { var: "lock" } }, properties: { inner: { type: "string" } } },
          rows: { type: "array", items: { type: "object", properties: { n: { type: "integer", "x-disabled": { logic: { "==": [{ var: "$parent.kind" }, "fixed"] } } }, kind: { type: "string" } } } },
        },
      },
    });
    const v = { obj: { inner: "x" }, rows: [{ kind: "fixed" }, { kind: "free" }] };
    expect([...e.disabledPaths(v)].sort()).toEqual(["off", "rows[0].n"]);
    expect([...e.disabledPaths({ ...v, lock: true })].sort()).toEqual(["obj", "off", "rows[0].n"]);
    expect(e.disabledAt("obj.inner", { ...v, lock: true })).toBe(true);
    expect(e.disabledAt("obj.inner", v)).toBe(false);
    expect(e.disabledAt("rows[1].n", v)).toBe(false);
  });

  it("applies x-disabled inside fetched fragments", async () => {
    const e = new FormEngine({
      schema: { type: "object", properties: { lock: { type: "boolean" }, d: { type: "object", "x-extend": { source: "f" } } } },
      loaders: {
        f: async () => ({
          properties: { inner: { type: "string", minLength: 5, "x-disabled": { logic: { var: "lock" } } }, keep: { type: "string" } },
          required: ["inner"],
        }),
      },
    });
    const v = { lock: true, d: { inner: "x", keep: "k" } };
    e.validate(v);
    await flush();
    expect([...e.disabledPaths(v)]).toEqual(["d.inner"]);
    expect(e.staleValues(v)).toEqual(["d.inner"]);
    expect(e.validate(v)).toMatchObject({ valid: true, data: { lock: true, d: { keep: "k" } } });
    expect(e.validate({ ...v, lock: false })).toMatchObject({ valid: false, fields: { "d.inner": expect.any(String) } });
  });

  it("applies x-hidden to properties of the active oneOf branch", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: {
          p: {
            type: "object",
            properties: { kind: { type: "string" } },
            oneOf: [
              {
                properties: { kind: { const: "a" }, short: { type: "boolean" }, x: { type: "string", "x-hidden": { logic: { var: "$parent.short" } } } },
                required: ["x"],
              },
              { properties: { kind: { const: "b" }, y: { type: "string" } } },
            ],
          },
        },
      },
    });
    const keys = (v: object) => Object.keys(e.resolve(e.schemaAt("p", v), "p", v).schema.properties);
    expect(keys({ p: { kind: "a" } })).toEqual(["kind", "short", "x"]);
    expect(keys({ p: { kind: "a", short: true } })).toEqual(["kind", "short"]);
    expect(e.validate({ p: { kind: "a" } }).fields).toEqual({ "p.x": "This field is required" });
    const short = { p: { kind: "a", short: true, x: "gone" } };
    expect(e.staleValues(short)).toEqual(["p.x"]);
    expect(e.validate(short)).toMatchObject({ valid: true, data: { p: { kind: "a", short: true } } });
  });
});

describe("multi-select options", () => {
  it("validates against options loaded with the same params as the UI", async () => {
    const loader = vi.fn(async (p: Record<string, unknown>) => (p.group === "g" ? [{ value: "a", label: "A" }] : []));
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: {
          group: { type: "string" },
          tags: { type: "array", items: { type: "string", "x-options": { source: "tags", params: { group: { var: "$parent.group" } } } } },
        },
      },
      loaders: { tags: loader },
    });
    const v = { group: "g", tags: ["a", "zzz"] };
    e.validate(v);
    await flush();
    expect(loader).toHaveBeenCalledWith({ group: "g" }, expect.anything());
    expect(e.validate(v).fields["tags[1]"]).toBe("Please choose one of the options");
  });
});

describe("one response feeding several fields (select)", () => {
  const regionSchema = (extra: Schema = {}): Schema => {
    const ref = (select: string) => ({ source: "region", params: { country: { var: "country" } }, select });
    return {
      type: "object",
      properties: {
        country: { type: "string" },
        city: { type: "string", "x-options": ref("cities") },
        postcode: { type: "string", "x-options": ref("lists.postcodes") },
        district: { type: "string", "x-options": ref("districts") },
        ...extra,
      },
    };
  };
  const region = async () => ({
    cities: [{ value: "Paris", label: "Paris" }],
    lists: { postcodes: [{ value: "75001", label: "75001" }] },
    fields: { properties: { vat: { type: "string" } }, required: ["vat"] },
  });

  it("makes one call and gives each field its own part, empty when missing", async () => {
    const loader = vi.fn(region);
    const e = new FormEngine({ schema: regionSchema(), loaders: { region: loader } });
    const v = { country: "FR" };
    const read = (f: string) => e.readOptions(at(e, f, v).schema, f, v);
    ["city", "postcode", "district"].forEach(read);
    await flush();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(read("city")).toEqual({ status: "success", data: [{ value: "Paris", label: "Paris" }] });
    expect(read("postcode")).toEqual({ status: "success", data: [{ value: "75001", label: "75001" }] });
    expect(read("district")).toEqual({ status: "success", data: [] });
    expect(read("city")).toBe(read("city"));
    expect(e.validate({ country: "FR", city: "Lyon" }).fields.city).toBe("Please choose one of the options");
  });

  it("works for x-extend too", async () => {
    const loader = vi.fn(region);
    const e = new FormEngine({
      schema: regionSchema({ tax: { type: "object", "x-extend": { source: "region", params: { country: { var: "country" } }, select: "fields" } } }),
      loaders: { region: loader },
    });
    const v = { country: "FR", tax: {} };
    e.validate(v);
    await flush();
    expect(e.validate(v).fields["tax.vat"]).toBe("This field is required");
    e.readOptions(at(e, "city", v).schema, "city", v);
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe("x-prefill", () => {
  const prefill = {
    source: "company",
    params: { number: { var: "$self" } },
    select: "result",
    fill: { name: "name" },
  };
  const make = (loader = vi.fn(async (p: Record<string, unknown>): Promise<unknown> => ({ result: { name: `Co ${p.number}`, address: { city: "Leeds" } } }))) => ({
    loader,
    e: new FormEngine({ schema: { properties: {} }, loaders: { company: loader } }),
  });

  it("maps response paths to fields relative to the holding object, skipping missing values", async () => {
    const { e } = make();
    const values = { rows: [{ number: "42" }] };
    expect(await e.prefill({ ...prefill, fill: { name: "name", "/owner.city": "address.city", missing: "nope" } }, values, "rows[0].number")).toEqual([
      { path: "rows[0].name", value: "Co 42", source: "company" },
      { path: "owner.city", value: "Leeds", source: "company" },
    ]);
  });

  it("clears fields it filled before when the new response lacks them, never the user's", async () => {
    const { e } = make(vi.fn(async () => ({ result: { name: "Only name" } })));
    const fill = { name: "name", city: "address.city", street: "address.street" };
    const values = { number: "1", name: "old", city: "Leeds", street: "Typed by hand" };
    expect(await e.prefill({ ...prefill, fill }, values, "number", { city: "company", street: "other" })).toEqual([
      { path: "name", value: "Only name", source: "company" },
      { path: "city", value: undefined },
    ]);
  });

  it("with overwrite: unedited, keeps typed and loaded values but replaces its own and computed ones", async () => {
    const { e } = make(vi.fn(async () => ({ result: { a: "A", b: "B", c: "C", d: "D", f: "F" } })));
    const fill = { a: "a", b: "b", c: "c", d: "d", f: "f" };
    // a: typed by the user, b: loaded (no provenance), c: filled by this prefill, d: computed, f: empty
    const values = { number: "1", a: "typed", b: "loaded", c: "old", d: "calc" };
    const prov = { a: "user", c: "company", d: "compute" };
    const own = [
      { path: "c", value: "C", source: "company" },
      { path: "d", value: "D", source: "company" },
      { path: "f", value: "F", source: "company" },
    ];
    expect(await e.prefill({ ...prefill, fill, overwrite: "unedited" }, values, "number", prov)).toEqual(own);
    // "unedited" is the default for trigger: "change", "always" for a button.
    expect(await e.prefill({ ...prefill, fill, trigger: "change" }, values, "number", prov)).toEqual(own);
    expect(await e.prefill({ ...prefill, fill }, values, "number", prov)).toHaveLength(5);
    expect(await e.prefill({ ...prefill, fill, trigger: "change", overwrite: "always" }, values, "number", prov)).toHaveLength(5);
  });

  it("does nothing while a param is empty, and fetches fresh data on every call", async () => {
    const { e, loader } = make();
    expect(await e.prefill(prefill, { number: "" }, "number")).toEqual([]);
    expect(loader).not.toHaveBeenCalled();
    await e.prefill(prefill, { number: "1" }, "number");
    await e.prefill(prefill, { number: "1" }, "number");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("rejects when the loader fails", async () => {
    const { e } = make(vi.fn(async () => Promise.reject(new Error("404"))));
    await expect(e.prefill(prefill, { number: "1" }, "number")).rejects.toThrow("404");
  });
});

describe("disabled fields", () => {
  it("are not validated or submitted", () => {
    const e = new FormEngine({
      schema: {
        type: "object",
        properties: { lock: { type: "boolean" }, code: { type: "string", minLength: 3, "x-disabled": { logic: { var: "lock" } } } },
        required: ["code"],
      },
    });
    expect(e.validate({ lock: false }).fields.code).toBe("This field is required");
    expect(e.validate({ lock: true })).toMatchObject({ valid: true, data: { lock: true } });
    expect(e.validate({ lock: true, code: "x" })).toMatchObject({ valid: true, data: { lock: true } });
  });
});

describe("stale values", () => {
  it("lists values of inactive branches, unmet ifs and x-hidden or x-disabled fields", async () => {
    const { schema, createLoaders } = await import("../src/demo/schema");
    const e = new FormEngine({ schema, loaders: createLoaders(0) });
    const values = {
      applicant: { kind: "individual", firstName: "Ada", companyName: "old branch" },
      hasPreviousClaims: true,
      claims: [{ type: "fire", description: "hidden for fire" }],
      marketingConsent: false,
      marketingChannel: "sms",
      promoCode: "disabled when there are claims",
    };
    expect(e.staleValues(values).sort()).toEqual(["applicant.companyName", "claims[0].description", "marketingChannel", "promoCode"]);
    expect(e.staleValues({ hasPreviousClaims: false, claims: [] })).toEqual(["claims"]);
  });

  it("leaves values under a fragment that is still loading", async () => {
    let release!: () => void;
    const e = new FormEngine({
      schema: { type: "object", properties: { d: { type: "object", "x-extend": { source: "f" } } } },
      loaders: { f: () => new Promise((r) => (release = () => r({ properties: { keep: { type: "string" } } }))) },
    });
    const values = { d: { keep: "x", drop: "y" } };
    expect(e.staleValues(values)).toEqual([]);
    release();
    await flush();
    expect(e.staleValues(values)).toEqual(["d.drop"]);
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

describe("computed fields", () => {
  const schema: Schema = {
    type: "object",
    properties: {
      qty: { type: "integer" },
      price: { type: "number" },
      total: { type: "number", readOnly: true, "x-compute": { logic: { "*": [{ var: "qty" }, { var: "price" }] } } },
      // Editable: suggested from `total`, but the user's own value sticks.
      budget: { type: "number", "x-compute": { logic: { "*": [{ var: "total" }, 2] } } },
      lines: {
        type: "array",
        items: {
          type: "object",
          properties: {
            n: { type: "integer" },
            double: { type: "integer", readOnly: true, "x-compute": { logic: { "*": [{ var: "$item.n" }, 2] } } },
          },
        },
      },
    },
  };
  const e = new FormEngine({ schema });

  it("writes derived values, chains settle in one call, and nothing changes once settled", () => {
    const r = e.applyComputed({ qty: 2, price: 5, lines: [{ n: 3 }] });
    expect(r.values).toEqual({ qty: 2, price: 5, total: 10, budget: 20, lines: [{ n: 3, double: 6 }] });
    expect(r.provenance).toEqual({ total: "compute", budget: "compute", "lines[0].double": "compute" });
    expect(e.applyComputed(r.values, r.provenance).patches).toEqual([]);
  });

  it("evaluates every compute against the incoming values in a single pass", () => {
    // budget reads the incoming (missing) total, so it is only filled on the next pass.
    expect(e.computed({ qty: 2, price: 5 })).toEqual([{ path: "total", value: 10, source: "compute" }]);
    expect(e.computed({ qty: 2, price: 5, total: 10 })).toEqual([{ path: "budget", value: 20, source: "compute" }]);
  });

  it("keeps a user's value in an editable computed field, but follows readOnly ones", () => {
    const r = e.applyComputed({ qty: 2, price: 5, total: 1, budget: 999 }, { total: "compute" });
    expect(r.values).toMatchObject({ total: 10, budget: 999 });
    expect(r.provenance).toEqual({ total: "compute" });
  });

  it("refills an editable field it owns, and forgets it when the result is empty", () => {
    const r = e.applyComputed({ qty: 2, price: 5, budget: 5 }, { budget: "compute" });
    expect(r.values).toMatchObject({ budget: 20 });
    const gone = e.applyComputed({ budget: 20 }, { budget: "compute" });
    expect(gone.values).toEqual({});
    expect(gone.provenance).toEqual({});
  });

  it("skips hidden and disabled fields", () => {
    const withTotal = (extra: object) =>
      new FormEngine({ schema: { ...schema, properties: { ...schema.properties, total: { ...schema.properties.total, ...extra } } } });
    for (const h of [withTotal({ "x-hidden": { logic: true } }), withTotal({ "x-disabled": { logic: true } })])
      expect(h.computed({ qty: 2, price: 5, total: 1 })).toEqual([{ path: "budget", value: 2, source: "compute" }]);
  });

  it("rejects computes that chase each other", () => {
    const loop = new FormEngine({
      schema: {
        properties: {
          a: { readOnly: true, "x-compute": { logic: { "+": [{ var: "b" }, 1] } } },
          b: { readOnly: true, "x-compute": { logic: { "+": [{ var: "a" }, 1] } } },
        },
      },
    });
    expect(() => loop.applyComputed({ a: 0 })).toThrow(/never settles: a, b/);
  });

  it("can take its value from a loader, idle while params are empty", async () => {
    const loader = vi.fn(async (p: Record<string, unknown>) => ({ fee: Number(p.plan) * 10 }));
    const a = new FormEngine({
      schema: {
        properties: {
          plan: { type: "string" },
          fee: { type: "number", readOnly: true, "x-compute": { source: "fees", params: { plan: { var: "plan" } }, select: "fee" } },
        },
      },
      loaders: { fees: loader },
    });
    expect(a.computed({ plan: "", fee: 1 })).toEqual([{ path: "fee", value: undefined, source: undefined }]);
    expect(a.computed({ plan: "3" })).toEqual([]); // loading: no write yet
    await flush();
    expect(a.computed({ plan: "3" })).toEqual([{ path: "fee", value: 30, source: "compute" }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("validate recomputes readOnly values the client sent, and leaves editable ones as sent", () => {
    const r = e.validate({ qty: 2, price: 5, total: 999, budget: 1, lines: [{ n: 3, double: 0 }, { n: 4 }] });
    expect(r.valid).toBe(true);
    expect(r.data).toEqual({ qty: 2, price: 5, total: 10, budget: 1, lines: [{ n: 3, double: 6 }, { n: 4, double: 8 }] });
    // An editable compute is a suggestion: an empty one stays empty on the server.
    expect(e.validate({ qty: 2, price: 5 }).data).toEqual({ qty: 2, price: 5, total: 10 });
  });

  it("validates the recomputed value, not the one sent", () => {
    const capped = new FormEngine({
      schema: {
        properties: {
          qty: { type: "integer" },
          total: { type: "number", maximum: 10, readOnly: true, "x-compute": { logic: { "*": [{ var: "qty" }, 3] } } },
        },
      },
    });
    expect(capped.validate({ qty: 5, total: 1 })).toMatchObject({ valid: false, fields: { total: "Must be <= 10" } });
    expect(capped.validate({ qty: 3, total: 999 })).toMatchObject({ valid: true, data: { qty: 3, total: 9 } });
  });

  it("blocks validation until a readOnly compute's loader answers", async () => {
    const a = new FormEngine({
      schema: {
        properties: {
          plan: { type: "string" },
          fee: { type: "number", readOnly: true, "x-compute": { source: "fees", params: { plan: { var: "plan" } }, select: "fee" } },
        },
      },
      loaders: { fees: async (p) => ({ fee: Number(p.plan) * 10 }) },
    });
    expect(a.validate({ plan: "3", fee: 1 })).toMatchObject({ valid: false, form: "Some fields are still loading…" });
    await flush();
    expect(a.validate({ plan: "3", fee: 1 })).toMatchObject({ valid: true, data: { plan: "3", fee: 30 } });
  });

  it("validate ignores readOnly computes on disabled fields", () => {
    const d = new FormEngine({
      schema: {
        properties: {
          lock: { type: "boolean" },
          t: { type: "number", readOnly: true, "x-disabled": { logic: { var: "lock" } }, "x-compute": { logic: 1 } },
        },
      },
    });
    expect(d.validate({ lock: true, t: 5 }).data).toEqual({ lock: true });
    expect(d.validate({}).data).toEqual({ t: 1 });
  });
});

describe("provenance helpers", () => {
  it("updates immutably and returns the same object when nothing changes", () => {
    const p = { a: "compute" };
    expect(withSource(p, "a", "compute")).toBe(p);
    expect(withSource(p, "a", undefined)).toEqual({});
    expect(withoutPath({ "x.y": "l", "x[0]": "l", xy: "l" }, "x")).toEqual({ xy: "l" });
    expect(withoutIndex({ "r[0].a": "l", "r[1].a": "l", "r[2].a": "l", "r[2].b": "l" }, "r", 1)).toEqual({ "r[0].a": "l", "r[1].a": "l", "r[1].b": "l" });
    expect(pruneProvenance({ a: "l", b: "l" }, { a: 1 })).toEqual({ a: "l" });
  });
});

describe("non-strict options", () => {
  const e = new FormEngine({
    schema: {
      properties: {
        strict: { type: "string", "x-options": { source: "list" } },
        loose: { type: "string", maxLength: 3, "x-options": { source: "list", strict: false } },
      },
    },
    loaders: { list: async () => [{ value: "a", label: "A" }] },
  });

  it("does not enforce or wait for the list, only the field's own keywords", async () => {
    // Still loading: strict blocks, loose doesn't.
    expect(e.validate({ loose: "zz" }).valid).toBe(true);
    expect(e.validate({ strict: "zz" }).form).toMatch(/still loading/);
    await flush();
    expect(e.validate({ strict: "zz" }).fields).toEqual({ strict: "Please choose one of the options" });
    expect(e.validate({ loose: "zz" }).valid).toBe(true);
    expect(e.validate({ loose: "zzzz" }).fields).toEqual({ loose: "Must NOT have more than 3 characters" });
  });
});
