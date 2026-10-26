import { describe, expect, it } from "vitest";
import { FormEngine, findUnsupported, toStandardSchema } from "../src/engine";
import { createLoaders, schema, uischema } from "../src/demo/schema";

const flush = () => new Promise((r) => setTimeout(r, 0));
const make = () => new FormEngine({ schema, uischema, loaders: createLoaders(0) });

/** Load every async source the current values depend on. */
async function settle(engine: FormEngine, values: unknown) {
  for (let i = 0; i < 5; i++) {
    engine.validate(values);
    await flush();
  }
}

const validIndividual = {
  applicant: { kind: "individual", firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1990-12-10" },
  address: { line1: "1 High St", country: "FR", city: "Paris" },
  product: "home",
  details: { propertyType: "house", rebuildCost: 250000, listed: false },
  contact: { email: "ada@example.com" },
  hasPreviousClaims: false,
  marketingConsent: false,
};

describe("resolution", () => {
  it("follows $ref and applies if/then", () => {
    const e = make();
    const node = e.schemaAt("address", {});
    expect(e.resolve(node, "address", {}).schema.required).toEqual(["line1", "country", "city"]);
    const gb = { address: { country: "GB" } };
    const r = e.resolve(e.schemaAt("address", gb), "address", gb);
    expect(r.schema.required).toEqual(["line1", "country", "city", "postcode"]);
  });

  it("does not treat a missing object as matching `if`", () => {
    const e = make();
    // hasPreviousClaims is not set: claims must not become active.
    expect(e.schemaAt("claims", {})).toBeUndefined();
    expect(e.schemaAt("claims", { hasPreviousClaims: true })).toBeDefined();
  });

  it("picks a oneOf branch by discriminator and exposes it as an enum", () => {
    const e = make();
    const none = e.resolve(e.schemaAt("applicant", {}), "applicant", {});
    expect(none.combinator?.discriminator).toBe("kind");
    expect(none.combinator?.selected).toBe(-1);
    expect(Object.keys(none.schema.properties)).toEqual(["kind"]);
    expect(none.schema.title).toBe("Applicant");

    const v = { applicant: { kind: "company" } };
    const co = e.resolve(e.schemaAt("applicant", v), "applicant", v);
    expect(Object.keys(co.schema.properties)).toEqual(["kind", "companyName", "vatRegistered", "vatNumber"]);
    expect(co.schema.title).toBe("Applicant"); // branch title doesn't leak
    const kind = e.resolve(co.schema.properties.kind, "applicant.kind", v).schema;
    expect(kind.enum).toEqual(["individual", "company"]);
    expect(kind["x-enumLabels"]).toEqual(["An individual", "A company"]);
  });

  it("uses an explicit selection for oneOf without discriminator", () => {
    const e = make();
    const at = (vals: object) => e.resolve(e.schemaAt("contact", vals), "contact", vals);
    expect(at({ contact: {} }).combinator?.selected).toBe(0);
    expect(at({ contact: { phone: "0161 123 4567" } }).combinator?.selected).toBe(1); // first matching
    e.select("contact", 0);
    expect(Object.keys(at({ contact: { phone: "0161 123 4567" } }).schema.properties)).toEqual(["email"]);
  });

  it("turns oneOf of consts into a labelled enum", () => {
    const e = make();
    const r = e.resolve(e.schemaAt("product", {}), "product", {});
    expect(r.schema.enum).toEqual(["car", "home"]);
    expect(r.combinator).toBeUndefined();
  });

  it("returns identical objects when the structure does not change", () => {
    const e = make();
    const a = { applicant: { kind: "individual", firstName: "A" } };
    const b = { applicant: { kind: "individual", firstName: "Ab" } };
    expect(e.resolve(e.schemaAt("applicant", a), "applicant", a)).toBe(
      e.resolve(e.schemaAt("applicant", b), "applicant", b),
    );
    expect(e.concretize(a).schema).toBe(e.concretize(b).schema);
  });
});

describe("async sources", () => {
  it("extends the schema from the API when a field changes", async () => {
    const e = make();
    const v = { product: "car" };
    expect(e.resolve(e.schemaAt("details", v), "details", v).extend?.status).toBe("loading");
    await flush();
    const r = e.resolve(e.schemaAt("details", v), "details", v);
    expect(r.extend?.status).toBe("success");
    expect(Object.keys(r.schema.properties)).toContain("vehicleReg");
    expect(r.schema.title).toBe("Product details");

    const home = { product: "home" };
    e.resolve(e.schemaAt("details", home), "details", home);
    await flush();
    expect(Object.keys(e.resolve(e.schemaAt("details", home), "details", home).schema.properties)).toEqual([
      "propertyType",
      "rebuildCost",
      "listed",
    ]);
  });

  it("loads dependent options only when the parent has a value", async () => {
    const e = make();
    const city = (v: object) => e.readOptions(e.schemaAt("address.city", v) as any, "address.city", v);
    expect(city({ address: {} })?.status).toBe("idle");
    expect(city({ address: { country: "DE" } })?.status).toBe("loading");
    await flush();
    const entry = city({ address: { country: "DE" } });
    expect(entry?.status === "success" && entry.data.map((o) => o.value)).toEqual(["Berlin", "Munich", "Hamburg"]);
  });

  it("supports dependent lists inside a fetched schema fragment", async () => {
    const e = make();
    const v = { product: "car", details: { make: "vw" } };
    await settle(e, v);
    const entry = e.readOptions(e.schemaAt("details.model", v) as any, "details.model", v);
    expect(entry?.status === "success" && entry.data.map((o) => o.value)).toEqual(["Golf", "Polo", "ID.3"]);
  });

  it("blocks validation while something is loading", () => {
    const e = make();
    const r = e.validate({ ...validIndividual, product: "car", details: {} });
    expect(r.valid).toBe(false);
    expect(r.form).toMatch(/loading/);
  });
});

describe("validation", () => {
  it("accepts a valid submission and prunes inactive fields", async () => {
    const e = make();
    const values = {
      ...validIndividual,
      applicant: { ...validIndividual.applicant, companyName: "stale from other branch" },
      contact: { email: "ada@example.com", phone: "stale" },
      marketingChannel: "sms", // hidden: consent is false
      claims: [{ year: 2020 }], // inactive: hasPreviousClaims is false
    };
    await settle(e, values);
    const r = e.validate(values);
    expect(r.fields).toEqual({});
    expect(r.valid).toBe(true);
    expect(r.data).toEqual(validIndividual);
  });

  it("maps errors to field paths, including inside arrays and API-provided fields", async () => {
    const e = make();
    const values = {
      ...validIndividual,
      address: { line1: "1 High St", country: "GB", city: "London", postcode: "nope" },
      product: "car",
      details: { make: "ford" },
      hasPreviousClaims: true,
      claims: [{ year: 1990, type: "other", amount: 10 }],
      marketingConsent: true,
    };
    await settle(e, values);
    const r = e.validate(values);
    expect(r.fields).toMatchObject({
      "address.postcode": "Enter a valid UK postcode, e.g. SW1A 1AA",
      "details.model": "This field is required",
      "details.vehicleReg": "This field is required",
      "claims[0].year": "Must be >= 2000",
      "claims[0].description": "This field is required",
      marketingChannel: "This field is required",
    });
  });

  it("validates values against loaded option lists", async () => {
    const e = make();
    const values = { ...validIndividual, address: { line1: "1 High St", country: "FR", city: "Berlin" } };
    await settle(e, values);
    expect(e.validate(values).fields["address.city"]).toBe("Please choose one of the options");
  });

  it("ignores required fields hidden by a UI rule", async () => {
    const e = make();
    await settle(e, validIndividual);
    expect(e.validate({ ...validIndividual, marketingConsent: false }).fields.marketingChannel).toBeUndefined();
    expect(e.validate({ ...validIndividual, marketingConsent: true }).fields.marketingChannel).toBeDefined();
  });

  it("works as a Standard Schema validator", async () => {
    const e = make();
    await settle(e, validIndividual);
    const std = toStandardSchema(e)["~standard"];
    expect(std.validate(validIndividual)).toEqual({ value: validIndividual });
    const bad = std.validate({ ...validIndividual, contact: {} }) as any;
    expect(bad.issues).toContainEqual({ message: "This field is required", path: ["contact", "email"] });
  });
});

describe("rules", () => {
  it("evaluates SHOW / DISABLE with JSON Logic and JSON Schema conditions", () => {
    const e = make();
    const show = { effect: "SHOW", condition: { logic: { var: "marketingConsent" } } } as const;
    expect(e.ruleState(show, "", { marketingConsent: false }).hidden).toBe(true);
    expect(e.ruleState(show, "", { marketingConsent: true }).hidden).toBe(false);

    const dis = { effect: "DISABLE", condition: { path: "vatRegistered", schema: { not: { const: true } } } } as const;
    expect(e.ruleState(dis, "applicant", { applicant: { vatRegistered: false } }).disabled).toBe(true);
    expect(e.ruleState(dis, "applicant", { applicant: { vatRegistered: true } }).disabled).toBe(false);
  });

  it("resolves $item inside array details", () => {
    const e = make();
    const v = { hasPreviousClaims: true, claims: [{ type: "fire" }, { type: "other" }] };
    const hidden = e.collectHidden(v);
    expect(hidden.has("claims[0].description")).toBe(true);
    expect(hidden.has("claims[1].description")).toBe(false);
  });
});

describe("defaults and support checks", () => {
  it("builds initial values from defaults", () => {
    const e = make();
    expect(e.defaults()).toEqual({
      applicant: {},
      address: {},
      details: {},
      contact: {},
      hasPreviousClaims: false,
      marketingConsent: false,
    });
  });

  it("rejects unsupported features up front", () => {
    expect(findUnsupported({ type: "array", prefixItems: [{}] })).toHaveLength(1);
    expect(() => new FormEngine({ schema: { properties: { a: { $ref: "other.json" } } } })).toThrow(/remote \$ref/);
  });
});
