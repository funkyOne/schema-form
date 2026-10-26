import type { Loaders, Option, Schema, UIElement } from "../engine";

/**
 * Example: an insurance quote form. It exercises every feature:
 *  - oneOf with a discriminator      (applicant: individual | company)
 *  - oneOf without a discriminator   (contact: email | phone)
 *  - labelled enums via oneOf+const  (product)
 *  - if/then/else                    (UK postcode required; claims list; VAT number)
 *  - $ref + definitions              (address, claim)
 *  - x-options: dependent API lists  (country -> city, make -> model)
 *  - x-extend: schema fetched from the API when a field changes (product -> details)
 *  - UI rules: SHOW / HIDE / DISABLE (marketing channel, claim description, promo code, VAT number)
 */
export const schema: Schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  definitions: {
    address: {
      type: "object",
      title: "Address",
      properties: {
        line1: { type: "string", title: "Address line 1", minLength: 3 },
        country: { type: "string", title: "Country", "x-options": { source: "countries" } },
        city: {
          type: "string",
          title: "City",
          "x-options": { source: "cities", params: { country: { var: "$parent.country" } } },
        },
        postcode: { type: "string", title: "Postcode" },
      },
      required: ["line1", "country", "city"],
      if: { properties: { country: { const: "GB" } }, required: ["country"] },
      then: {
        properties: {
          postcode: {
            pattern: "^[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[A-Z]{2}$",
            "x-messages": { pattern: "Enter a valid UK postcode, e.g. SW1A 1AA" },
          },
        },
        required: ["postcode"],
      },
    },
    claim: {
      type: "object",
      properties: {
        year: { type: "integer", title: "Year", minimum: 2000, maximum: 2026 },
        type: { type: "string", title: "Type", enum: ["accident", "theft", "fire", "other"] },
        amount: { type: "number", title: "Amount (£)", minimum: 0 },
        description: { type: "string", title: "What happened?" },
      },
      required: ["year", "type", "amount"],
      if: { properties: { type: { const: "other" } }, required: ["type"] },
      then: { required: ["description"] },
    },
  },
  properties: {
    applicant: {
      type: "object",
      title: "Applicant",
      properties: { kind: { type: "string", title: "Applying as" } },
      oneOf: [
        {
          title: "An individual",
          properties: {
            kind: { const: "individual" },
            firstName: { type: "string", title: "First name", minLength: 1 },
            lastName: { type: "string", title: "Last name", minLength: 1 },
            dateOfBirth: { type: "string", format: "date", title: "Date of birth" },
          },
          required: ["firstName", "lastName", "dateOfBirth"],
        },
        {
          title: "A company",
          properties: {
            kind: { const: "company" },
            companyName: { type: "string", title: "Company name", minLength: 1 },
            vatRegistered: { type: "boolean", title: "VAT registered", default: false },
            vatNumber: { type: "string", title: "VAT number", pattern: "^GB\\d{9}$" },
          },
          required: ["companyName"],
          if: { properties: { vatRegistered: { const: true } }, required: ["vatRegistered"] },
          then: { required: ["vatNumber"] },
        },
      ],
    },
    address: { $ref: "#/definitions/address" },
    product: {
      type: "string",
      title: "Product",
      oneOf: [
        { const: "car", title: "Car insurance" },
        { const: "home", title: "Home insurance" },
      ],
    },
    // The fields of this object come from the API, based on the selected product.
    details: {
      type: "object",
      title: "Product details",
      "x-extend": { source: "productFields", params: { product: { var: "product" } } },
    },
    contact: {
      type: "object",
      title: "Preferred contact",
      oneOf: [
        {
          title: "Email",
          properties: { email: { type: "string", format: "email", title: "Email" } },
          required: ["email"],
        },
        {
          title: "Phone",
          properties: {
            phone: {
              type: "string",
              title: "Phone",
              pattern: "^\\+?[0-9 ]{7,15}$",
              "x-messages": { pattern: "Enter a phone number, digits and spaces only" },
            },
          },
          required: ["phone"],
        },
      ],
    },
    hasPreviousClaims: { type: "boolean", title: "Any claims in the last 5 years?", default: false },
    marketingConsent: { type: "boolean", title: "Send me offers", default: false },
    marketingChannel: { type: "string", title: "How should we contact you?", enum: ["email", "sms", "post"] },
    promoCode: { type: "string", title: "Promo code" },
  },
  required: ["applicant", "address", "product", "contact", "marketingChannel"],
  if: { properties: { hasPreviousClaims: { const: true } }, required: ["hasPreviousClaims"] },
  then: {
    properties: {
      claims: { type: "array", title: "Claims", minItems: 1, items: { $ref: "#/definitions/claim" } },
    },
    required: ["claims"],
  },
};

const ctl = (path: string, extra: object = {}): UIElement => ({ type: "Control", path, ...extra });
const row = (...elements: UIElement[]): UIElement => ({ type: "HorizontalLayout", elements });

export const uischema: UIElement = {
  type: "VerticalLayout",
  elements: [
    ctl("applicant", {
      options: {
        detail: {
          type: "VerticalLayout",
          elements: [
            ctl("kind"),
            // Fields that aren't in the active branch simply don't render.
            row(ctl("firstName"), ctl("lastName")),
            ctl("dateOfBirth"),
            ctl("companyName"),
            row(
              ctl("vatRegistered"),
              ctl("vatNumber", {
                rule: { effect: "DISABLE", condition: { path: "vatRegistered", schema: { not: { const: true } } } },
              }),
            ),
          ],
        },
      },
    }),
    ctl("address", {
      options: {
        detail: {
          type: "VerticalLayout",
          elements: [ctl("line1"), row(ctl("country"), ctl("city")), ctl("postcode")],
        },
      },
    }),
    {
      type: "Group",
      label: "Cover",
      elements: [ctl("product"), ctl("details")],
    },
    ctl("contact"),
    {
      type: "Group",
      label: "History",
      elements: [
        ctl("hasPreviousClaims"),
        ctl("claims", {
          options: {
            detail: {
              type: "VerticalLayout",
              elements: [
                row(ctl("year"), ctl("type"), ctl("amount")),
                ctl("description", {
                  options: { multi: true },
                  // $item is the current array item.
                  rule: { effect: "SHOW", condition: { logic: { "==": [{ var: "$item.type" }, "other"] } } },
                }),
              ],
            },
          },
        }),
      ],
    },
    {
      type: "Group",
      label: "Marketing",
      elements: [
        ctl("marketingConsent"),
        ctl("marketingChannel", {
          // Hidden fields are removed before validation and submit, so "required" only applies when shown.
          rule: { effect: "SHOW", condition: { logic: { "==": [{ var: "marketingConsent" }, true] } } },
        }),
        ctl("promoCode", {
          rule: { effect: "DISABLE", condition: { logic: { var: "hasPreviousClaims" } } },
        }),
      ],
    },
  ],
};

// ---------------------------------------------------------------- fake API

const COUNTRIES: Option[] = [
  { value: "GB", label: "United Kingdom" },
  { value: "FR", label: "France" },
  { value: "DE", label: "Germany" },
];
const CITIES: Record<string, string[]> = {
  GB: ["London", "Manchester", "Bury", "Edinburgh"],
  FR: ["Paris", "Lyon", "Marseille"],
  DE: ["Berlin", "Munich", "Hamburg"],
};
const MODELS: Record<string, string[]> = {
  ford: ["Fiesta", "Focus", "Puma"],
  vw: ["Golf", "Polo", "ID.3"],
  tesla: ["Model 3", "Model Y"],
};

const PRODUCT_FIELDS: Record<string, Schema> = {
  car: {
    properties: {
      make: { type: "string", title: "Make", "x-options": { source: "makes" } },
      model: {
        type: "string",
        title: "Model",
        "x-options": { source: "models", params: { make: { var: "$parent.make" } } },
      },
      vehicleReg: { type: "string", title: "Registration", pattern: "^[A-Z0-9 ]{2,8}$" },
      annualMileage: { type: "integer", title: "Annual mileage", minimum: 0, maximum: 100000 },
      use: {
        title: "Use",
        oneOf: [
          { const: "social", title: "Social only" },
          { const: "commute", title: "Social & commuting" },
          { const: "business", title: "Business" },
        ],
      },
    },
    required: ["make", "model", "vehicleReg", "annualMileage", "use"],
  },
  home: {
    properties: {
      propertyType: { type: "string", title: "Property type", enum: ["house", "flat", "bungalow"] },
      rebuildCost: { type: "number", title: "Rebuild cost (£)", minimum: 10000 },
      listed: { type: "boolean", title: "Listed building", default: false },
    },
    required: ["propertyType", "rebuildCost"],
  },
};

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)));
  });

/** Replace these with real fetch() calls. `params` are already evaluated from the form values. */
export function createLoaders(delayMs = 400, log?: (msg: string) => void): Loaders {
  const call = async <T>(name: string, params: object, signal: AbortSignal, value: T) => {
    log?.(`GET /${name} ${JSON.stringify(params)}`);
    await wait(delayMs, signal);
    return value;
  };
  return {
    countries: (p, { signal }) => call("countries", p, signal, COUNTRIES),
    cities: (p, { signal }) =>
      call("cities", p, signal, (CITIES[p.country as string] ?? []).map((c) => ({ value: c, label: c }))),
    makes: (p, { signal }) =>
      call("makes", p, signal, [
        { value: "ford", label: "Ford" },
        { value: "vw", label: "Volkswagen" },
        { value: "tesla", label: "Tesla" },
      ]),
    models: (p, { signal }) =>
      call("models", p, signal, (MODELS[p.make as string] ?? []).map((m) => ({ value: m, label: m }))),
    productFields: (p, { signal }) => call("product-fields", p, signal, PRODUCT_FIELDS[p.product as string] ?? {}),
  };
}
