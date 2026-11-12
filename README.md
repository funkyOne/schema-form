# schema-form

Schema-driven forms for React. You write a JSON Schema, a small UI schema for layout and rules, and plain async loaders for anything that comes from an API. A framework-free engine turns "schema + current values" into what the user sees right now, and the same engine validates on the server.

Built on [TanStack Form](https://tanstack.com/form) for state and [TanStack Query](https://tanstack.com/query) (`query-core`) for caching loader results.

```
JSON Schema + UI schema + loaders
            │
            ▼
   ┌──────────────────┐   resolve(path, values)   → flattened schema at a path
   │      Engine      │   validate(values)        → field errors + clean data
   │ (framework-free) │   applyComputed(values)   → derived fields
   └──────────────────┘   staleValues(values)     → values to clear
            │
            ▼
   React layer (TanStack Form + swappable controls)
```

## What it does

- **JSON Schema is the contract.** `$ref`, `allOf`, `if/then/else`, `oneOf`/`anyOf` (with a discriminator, with a branch picker, as labelled enums, as nullable types), arrays of objects, recursive schemas. Unsupported features are rejected at load time with a clear message.
- **Fields appear, hide, disable and clear themselves.** Inactive branches, unmet `if`s and rule-hidden or disabled fields are never validated, never submitted, and their values are cleared as soon as they go away.
- **API-driven parts are declared, not coded.** Dependent option lists (`x-options`), schema fragments fetched when a value changes (`x-extend`), lookup buttons that fill other fields, and computed fields (`x-compute`) all name a *source*. The host maps sources to `fetch()` in the browser or to in-process services on the server.
- **Expressions are data.** Conditions and computations are JSON Logic or JSON Schema tests, never embedded JavaScript, so forms can come from a server.
- **Errors belong to fields.** Validation runs against a concrete schema of what is visible, so you get "Enter a valid UK postcode" on the right field instead of "must match exactly one schema in oneOf". Errors a server returns from `onSubmit` are shown the same way.
- **Provenance and drafts.** The form tracks who last wrote each field (a lookup, a compute, the user) so autofill never overwrites manual input, and gives you a serialisable snapshot on every change to save as a draft or browser backup.
- **Identity-stable results.** Resolution is memoised by object identity, so typing in one field re-renders only that field and its genuine dependents.

See [IDEA.md](IDEA.md) for the principles and decisions and [USE-CASES.md](USE-CASES.md) for every supported scenario with the test that pins it.

## Install

```sh
npm install @funkyone/schema-form
```

React 18 or newer is a peer dependency.

## Usage

```tsx
import { SchemaForm } from "@funkyone/schema-form";
import "@funkyone/schema-form/styles.css";

const schema = {
  type: "object",
  properties: {
    country: { type: "string", title: "Country", "x-options": { source: "countries" } },
    city: {
      type: "string",
      title: "City",
      "x-options": { source: "cities", params: { country: { var: "country" } } },
    },
    qty: { type: "integer", title: "Quantity" },
    price: { type: "number", title: "Unit price" },
    total: {
      type: "number",
      title: "Total",
      readOnly: true,
      "x-compute": { logic: { "*": [{ var: "qty" }, { var: "price" }] } },
    },
  },
  required: ["country", "city"],
};

// Sources are plain async functions. `params` are already evaluated from the form values.
const loaders = {
  countries: () => fetch("/api/countries").then((r) => r.json()),
  cities: ({ country }, { signal }) => fetch(`/api/cities?country=${country}`, { signal }).then((r) => r.json()),
};

export function Order() {
  return (
    <SchemaForm
      schema={schema}
      loaders={loaders}
      onSubmit={async (data) => {
        const res = await fetch("/api/orders", { method: "POST", body: JSON.stringify(data) });
        // Return { fields, form } to show errors the server found.
        if (!res.ok) return res.json();
      }}
    />
  );
}
```

Without a UI schema every active property renders in schema order. Add one for layout and rules:

```ts
const uischema = {
  type: "VerticalLayout",
  elements: [
    { type: "HorizontalLayout", elements: [{ type: "Control", path: "country" }, { type: "Control", path: "city" }] },
    {
      type: "Control",
      path: "promoCode",
      rule: { effect: "DISABLE", condition: { logic: { var: "hasPreviousClaims" } } },
    },
  ],
};
```

### Drafts

```tsx
<SchemaForm
  schema={schema}
  initialState={JSON.parse(localStorage.getItem("draft") ?? "null") ?? undefined}
  onStateChange={(snapshot) => localStorage.setItem("draft", JSON.stringify(snapshot))}
  onSubmit={save}
/>
```

The snapshot holds the values, the provenance map and any branch picks. Old drafts load fine after the schema changes: values the schema no longer describes are dropped on submit.

### On the server

The engine has no React dependency:

```ts
import { FormEngine, toStandardSchema } from "@funkyone/schema-form/engine";

const engine = new FormEngine({ schema, uischema, loaders: serverLoaders });
const { valid, fields, form, data } = engine.validate(body);
// or hand `toStandardSchema(engine)` to anything that accepts a Standard Schema validator
```

Loaders on the server are the same shape as in the browser, backed by services or queries instead of HTTP. Fields fed by `x-options` or `x-extend` must have loaded before `validate` is called.

### Your own controls

Every leaf control receives a small props contract (`value`, `onChange`, `errors`, `disabled`, `choices`, ...). Pass `renderers` to replace the defaults by name or add new ones ranked by a `rank(schema, options)` function. `options.widget` on a control forces a renderer.

## Schema extensions

| Keyword | On | Meaning |
|---|---|---|
| `x-options` | a field | Option list from a source: `{ source, params?, select?, strict? }`. `strict: false` keeps the list for display only. |
| `x-extend` | an object | Schema fragment from a source, merged into the object when its params are available. |
| `x-compute` | a field | Derived value: `{ logic }` (JSON Logic) or `{ source, params, select }`. `readOnly` fields are always derived; editable ones stop once the user edits them. |
| `x-enumLabels` | an enum | Display labels, index-aligned with `enum`. |
| `x-messages` | any schema | Custom error text per keyword, e.g. `{ "pattern": "Enter a valid UK postcode" }`. |

UI schema controls accept `options.lookup` (`{ source, params, fill, label? }`) for a button that fetches data and fills other fields, `options.detail` for the layout of an object or array item, `options.widget`, `options.multi` and `options.placeholder`.

JSON Logic expressions see the root values plus `$self` (the field's own value), `$parent` (its container) and `$item` (the nearest array item).

## Development

```sh
npm install
npm run dev        # demo playground at http://localhost:5173
npm test           # vitest
npm run typecheck
npm run build:lib  # dist/ (ESM + declarations)
npm run check      # all of the above
```

The demo in `src/demo` is an insurance quote form that exercises every feature, including a simulated API with latency and a localStorage backup.

## Not supported, on purpose

Remote `$ref`s, tuple arrays, `patternProperties`, `dependentSchemas` and `unevaluated*` are rejected on load. Multi-step layouts are a display concern of the host app, not the engine. See IDEA.md for the reasoning.

## License

MIT
