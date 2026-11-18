# schema-form

Schema-driven forms for React. You write a JSON Schema (with a few `x-` keywords for behaviour), an optional UI schema for layout, and plain async loaders for anything that comes from an API. A framework-free engine turns "schema + current values" into what the user sees right now, and the same engine validates on the server.

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
- **Fields appear, hide, disable and clear themselves.** Inactive branches, unmet `if`s and fields hidden or disabled by `x-hidden` / `x-disabled` are never validated, never submitted, and their values are cleared as soon as they go away.
- **API-driven parts are declared, not coded.** Dependent option lists (`x-options`), schema fragments fetched when a value changes (`x-extend`), lookups that fill other fields (`x-prefill`), rules checked against API data (`x-validate`), and computed fields (`x-compute`) all name a *source*. The host maps sources to `fetch()` in the browser or to in-process services on the server.
- **Expressions are data.** Conditions and computations are JSON Logic or JSON Schema tests, never embedded JavaScript, so forms can come from a server.
- **Errors belong to fields.** Validation runs against a concrete schema of what is visible, so you get "Enter a valid UK postcode" on the right field instead of "must match exactly one schema in oneOf". Cross-field rules (`x-validate`), errors a server returns from `onSubmit`, and errors from checks you run yourself (`externalErrors`) are shown the same way.
- **Provenance and drafts.** The form tracks who last wrote each field (a prefill, a compute, the user) so autofill never overwrites manual input, and gives you a serialisable snapshot on every change to save as a draft or browser backup.
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

Without a UI schema every active property renders in schema order. Add one for layout; visibility and locking stay in the schema (`x-hidden`, `x-disabled`):

```ts
const uischema = {
  type: "VerticalLayout",
  elements: [
    { type: "HorizontalLayout", elements: [{ type: "Control", path: "country" }, { type: "Control", path: "city" }] },
    { type: "Group", label: "Discounts", elements: [{ type: "Control", path: "promoCode" }] },
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

const engine = new FormEngine({ schema, loaders: serverLoaders });
const { valid, fields, form, data } = engine.validate(body);
// or hand `toStandardSchema(engine)` to anything that accepts a Standard Schema validator
```

Loaders on the server are the same shape as in the browser, backed by services or queries instead of HTTP. Anything fed by a source (`x-options`, `x-extend`, readOnly `x-compute`, `x-validate` or a condition with a `source`) must have loaded before `validate` is called; until then it reports "still loading".

### Your own controls

Every leaf control receives a small props contract (`value`, `onChange`, `errors`, `disabled`, `choices`, `data`, ...). Pass `renderers` to replace the defaults by name or add new ones ranked by a `rank(schema, options)` function. `options.widget` on a control, or `x-widget` in the schema, forces a renderer, also on an object or an array of objects: the control then gets the whole value (e.g. a table of checkboxes instead of the add/remove list). `x-data` loads extra data for it, such as table rows.

### Errors from your own checks

```tsx
<SchemaForm schema={schema} externalErrors={{ amc: { fields: { foRiskSystem: "Not valid for this account" } } }} … />
```

`externalErrors` holds errors from checks the host runs itself (e.g. a remote validation when the user reaches Review), by check name. They show inline right away, stay until you replace or remove that check's entry, and block submit while present. Inside the form, `useSchemaForm().validateLocal()` tells you whether the local rules pass before you call the remote check.

All errors (external, server, schema, `x-validate`) form one stream: `useFieldErrors(path)` for one field, `useFormErrors()` for what is showing now, `useFormErrors({ all: true })` for everything that would block a submit.

### Steppers and other custom layouts

```tsx
<SchemaForm uischema={{ type: "Stepper", elements: [{ type: "Group", label: "Details", elements: […] }, …] }}
            layouts={{ Stepper: MyStepper }} … />
```

A UI schema `type` that isn't built in is rendered by the component you register in `layouts`. It gets its `sections`, each with `label`, `fields` (active field paths) and `render()`; sections whose fields are all hidden are left out. Layouts are display only and never gate validation: for a step's error badge, use `errorsWithin(useFormErrors({ all: true }), section.fields)`.

## Schema extensions

| Keyword | On | Meaning |
|---|---|---|
| `x-options` | a field | Option list from a source: `{ source, params?, select?, strict? }`. `strict: false` keeps the list for display only. |
| `x-extend` | an object | Schema fragment from a source, merged into the object when its params are available. |
| `x-compute` | a field | Derived value: `{ logic }` (JSON Logic) or `{ source, params, select }`. `readOnly` fields are always derived; editable ones stop once the user edits them. |
| `x-prefill` | a field | Fetch data for this field's value and fill other fields: `{ source, params, fill, trigger?, overwrite?, label? }`. A button by default, or automatic with `trigger: "change"`. |
| `x-validate` | a field | Rules that must hold: `[{ logic, message }]`, e.g. two fields must differ. With `{ source, params, select }` the logic sees the response as `$data` (e.g. a search must find the code). Run by `validate` (also on the server); the form shows them live once the field is edited. |
| `x-hidden` / `x-disabled` | a property | Condition `{ logic }` or `{ path, schema }`. A `{ logic }` condition may add `{ source, params, select }` and read `$data`, e.g. hide a step when a service returns no rows. |
| `x-widget` | any node | Name of the renderer to use, including for objects and arrays. |
| `x-data` | any node | `{ name: { source, params?, select? } }`; loaded and passed to the control as `data`. |
| `x-enumLabels` | an enum | Display labels, index-aligned with `enum`. |
| `x-messages` | any schema | Custom error text per keyword, e.g. `{ "pattern": "Enter a valid UK postcode" }`. |

UI schema controls accept `options.detail` for the layout of an object or array item, `options.widget`, `options.multi` and `options.placeholder`.

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

Remote `$ref`s, tuple arrays, `patternProperties`, `dependentSchemas` and `unevaluated*` are rejected on load. Multi-step layouts are display only (see custom layouts above); the engine has no per-step validation. See IDEA.md for the reasoning.

## License

MIT
