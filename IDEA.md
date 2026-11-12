# Schema Form: Idea, Principles and Goals

## Idea

We need complex, data-driven forms in React. Fields appear and disappear based on other values, some fields are disabled conditionally, option lists depend on other fields and come from an API, and parts of the form itself are fetched from the server when a value changes.

JSON Forms covers this in principle, but it is slow to evolve. It is heavyweight (Redux-style core, renderer "testers"), and complex logic ends up split awkwardly between JSON Schema, UI-schema rules and custom code.

**The approach:** keep **JSON Schema** as the contract and use **TanStack Form** for state and rendering performance. In between sits a small engine of our own that turns "schema + current values" into "what the user sees right now".

```
JSON Schema + UI schema + loaders
            │
            ▼
   ┌──────────────────┐   resolve(path, values) → flattened schema
   │      Engine      │   x-hidden / x-disabled → active schema, locked paths
   │ (framework-free) │   validate(values) → field errors + clean data
   └──────────────────┘   staleValues(values) → paths to clear
            │
            ▼
   React layer (TanStack Form + our components)
```

The engine has no React dependency, so the same logic also runs on the server.

## Principles

1. **The schema is the contract.** Data shape, constraints and conditional structure live in JSON Schema (draft-07 style). The schema stays serializable, so it can be stored, versioned and served from the backend.

2. **Layout is separate from behaviour.** The UI schema describes layout only (order, groups, rows, array item layouts, widgets). Whether a field is present (`x-hidden`) or locked (`x-disabled`) is a data concern and lives in the schema, so a server (TypeScript or Java) validates exactly what the browser does without reading the UI schema.

3. **One source for visibility and validation.** A field the user can't use is never validated and never submitted. That covers inactive branches, unmet `if`s, and fields hidden by `x-hidden` *or* locked by `x-disabled` (a disabled field can't be fixed by the user, so it must not block submit). Their values are cleared from form state as soon as the field goes away, and switching back starts from defaults. Values inside a fragment that is still loading are left alone until its fields are known.

4. **Resolve, don't interpret everywhere.** Components never evaluate `$ref`, `allOf`, `if/then/else` or `oneOf` themselves. They ask the engine for the resolved schema at a path. All JSON Schema complexity lives in one place.

5. **Identity-stable results.** Resolution is memoized by object identity: the same structure returns the same object. Components re-render when the form's *shape* changes, not on every keystroke.

6. **API-driven parts are declared, not coded.** Dependent option lists (`x-options`) and fetched schema fragments (`x-extend`) are declared in the schema with parameters written as JSON Logic over form values. Loaders are plain async functions supplied by the app. Results are cached in a TanStack Query client per (source, params), so stale responses can never show. Pass the app's `QueryClient` to share the cache between forms and invalidate it with `invalidateQueries({ queryKey: ["schema-form", source] })`.

7. **Expressions are data.** Conditions are JSON Logic or JSON Schema tests, never `eval` or embedded JavaScript, so forms can safely come from the server.

8. **An explicit, supported subset.** We support a deliberate subset of JSON Schema and reject everything else at load time with a clear error. That is better than silently mishandling a schema.

9. **Renderers are swappable.** The default controls are placeholders. Each control receives a small, stable props contract (`value`, `onChange`, `errors`, `disabled`, `choices`, ...) so the design system plugs in without touching the engine.

10. **Errors belong to fields.** Validation runs against a concrete schema of what is visible, so errors map to exact field paths ("Enter a valid UK postcode") rather than "must match exactly one schema in oneOf".

## Goals

**Must have**

- `oneOf` / `anyOf`:
  - with a discriminator (a `const` property picks the branch)
  - without one (the user picks the branch)
  - as labelled enums (`oneOf` of `const` + `title`)
  - as nullable types
- `if / then / else` at any level, including inside arrays and fetched fragments.
- `$ref` (local, including recursive schemas) and `allOf`.
- Hide and disable conditions in the schema (`x-hidden`, `x-disabled`), scoped correctly inside array items (`$item`, `$parent`).
- Dependent option lists loaded from an API, with loading, idle, error and retry states. Child values clear when the parent changes. One response can feed several fields (`select` picks each field's part).
- Schema extension from an API when a field changes (e.g. product → product-specific fields).
- Prefill (`x-prefill`): fetch data for one field, from a button or automatically on change, and fill a declared set of other fields, remembering what it filled.
- Computed fields: derived from other fields by JSON Logic or a loader, display-only or editable with the user's edit winning.
- Drafts: a serialisable snapshot to save and resume, including provenance and branch picks.
- Validation on submit, then live after the first attempt, with per-field messages and custom messages via `x-messages`.
- A submit payload with hidden and inactive data removed.

**Should have**

- Arrays of objects with add/remove and per-item layout.
- Defaults applied when fields appear.
- Values reset when fields become hidden or disabled by dependent fields.

**Success looks like**

- A new conditional form is built by writing schema + UI schema + loaders, with no new React code.
- Typing in one field re-renders only that field and its genuine dependents.

## Non-goals

- Full JSON Schema coverage. Unsupported features are rejected on load:
  - remote `$ref`s
  - tuple arrays / `prefixItems`
  - `patternProperties`
  - `dependentSchemas`
  - `unevaluated*`
- A visual form builder.
- A component library. We ship contracts and placeholders, not a design system.
- Inferred TypeScript types for form values. Add `json-schema-to-ts` if needed.
- Replacing TanStack Form. We lean on it for state, subscriptions and submission, and on TanStack Query (`query-core`) for loader caching.

## Keyword vocabulary: validation vs assistive

The schema carries two kinds of keywords. The test is whether a keyword changes **what counts as valid data**. A validating engine (the server, in TypeScript or Java) must implement the first group and may ignore the second: assistive keywords only suggest values, and whatever they produce is validated like anything the user typed.

| Keyword | Kind | Server |
|---|---|---|
| draft-07: `$ref`, `allOf`, `if`/`then`/`else`, `oneOf`/`anyOf`, `required`, … | validation | must implement |
| `x-hidden` | validation: the property is absent while it holds | must implement |
| `x-disabled` | validation: the field is excluded while it holds | must implement |
| `x-options` | validation: the loaded list is the allowed values | must implement, with its own loaders |
| `x-extend` | validation: adds fields and their rules | must implement, with its own loaders |
| `x-compute` on a `readOnly` field | validation: the value is defined by the formula | must recompute; `validate` replaces whatever was sent |
| `x-messages` | validation output: error text | should implement, for the same messages |
| `x-compute` on an editable field | assistive: a suggestion the user can override | may ignore |
| `x-prefill` | assistive: fills other fields from an API | may ignore |
| `x-enumLabels`, `title`, `description` | display | may ignore |

Provenance is assistive state too: the server doesn't need it to validate. The UI schema is layout only and never affects validation.

## Decisions

- **Everything is expressed in the schema**, so the server can run the same engine. Behaviour that needs the outside world (option lists, schema fragments, prefills, computed values from a service) names a `source`; the host maps sources to API calls in the browser and to in-process services or queries on the server via `Loaders`. The engine never knows which.
- **Computed fields are declared on the field they write** (`x-compute`). That makes one owner per field structural rather than enforced, and dependencies are whatever the expression reads. Computes see only the incoming values; `applyComputed` settles chains and throws on a cycle.
- **Provenance is data, not memory.** Who last wrote a field (`compute`, a prefill source, or `user`) lives next to the values and travels with drafts. A manual edit wins over later computes; a prefill replaces and clears only what it filled before (and with `overwrite: "unedited"` never overwrites what the user typed). There is no separate "override policy" keyword yet; `readOnly` means always derived.
- **A form snapshot is values + provenance + branch selections**, reported on every change and accepted back to resume. Storage (server drafts, localStorage) is the host's job.
- **The baseline is the opening state**, which TanStack Form already keeps (`isDirty`, `reset`). No separate record baseline.
- **Steps are not an engine concern.** A stepper is a display of the UI-schema layout; there is no per-step validation.

- **Hidden and disabled values are cleared immediately**, not kept for switching back. One engine call (`staleValues`) decides what to clear; the React layer just applies it.
- **Hidden means absent.** `x-hidden` drops the property from its parent's resolved schema (and from `required`), exactly like a property under an unmet `if`. The condition is read from the property's own schema (after `$ref`), not from its resolved form, so recursive schemas stay finite.
- **Disabled means excluded.** A field under `x-disabled` (or inside a disabled object) is not validated and not submitted. `readOnly` in the schema only disables the control.
- **Loader results live in TanStack Query** (`@tanstack/query-core`, so the engine stays framework-free). Each form gets its own client by default; pass the app's client to share the cache.

## Implementation notes

Lessons from building and simplifying the engine:

- **Validation only walks values that exist.** A missing field can't fail on its own (a missing required field is reported by its parent), so the concrete schema stops there. This keeps recursive schemas finite and validation cheap. As a result, an absent object whose `x-extend` is still loading doesn't block submit.
- **Interning instead of hand-built cache keys.** The concrete validation schema is built fresh and then reused if an identical one (by JSON) exists, so the same structure shares one compiled Ajv validator.
- **Identity is the performance contract.** `resolve` and loader entries return the same object while nothing meaningful changed. Breaking that silently re-renders every field on every keystroke; a test counts renders to guard it.
- **TanStack Query flags failed queries as invalidated.** Treating "invalidated" as "refetch" would retry a failed loader on every render. Only successful data is refetched after invalidation; failures wait for Retry.
- **Unused queries are garbage-collected** after `gcTime` (5 minutes by default in an app's client). A form left open that long briefly shows "Loading…" while a list is refetched. The default per-form client keeps entries forever.
- **Tests come first.** Characterization tests (`tests/*-features.test.*`) pin current behaviour before any refactor; intentional behaviour changes update the test in the same change.

## Open questions

- **Schema versioning.** How are stored submissions validated after the schema changes?
- **Draft target.** Stay on draft-07 for tooling compatibility, or move to 2020-12 / JSON Schema v1 once it is published?
