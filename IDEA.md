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
   │      Engine      │   ruleState(rule, values) → hidden / disabled
   │ (framework-free) │   validate(values) → field errors + clean data
   └──────────────────┘
            │
            ▼
   React layer (TanStack Form + our components)
```

The engine has no React dependency, so the same logic also runs on the server.

## Principles

1. **The schema is the contract.** Data shape, constraints and conditional structure live in JSON Schema (draft-07 style). The schema stays serializable, so it can be stored, versioned and served from the backend.

2. **Layout and behaviour are separate from data.** A UI schema describes layout and rules (`HIDE`, `SHOW`, `DISABLE`, `ENABLE`). The data schema never contains presentation.

3. **One source for visibility and validation.** A field the user can't see is never validated and never submitted. Inactive branches, unmet `if`s and rule-hidden fields are pruned before validation. Inactive values are kept in form state, so switching back restores them.

4. **Resolve, don't interpret everywhere.** Components never evaluate `$ref`, `allOf`, `if/then/else` or `oneOf` themselves. They ask the engine for the resolved schema at a path. All JSON Schema complexity lives in one place.

5. **Identity-stable results.** Resolution is memoized by object identity: the same structure returns the same object. Components re-render when the form's *shape* changes, not on every keystroke.

6. **API-driven parts are declared, not coded.** Dependent option lists (`x-options`) and fetched schema fragments (`x-extend`) are declared in the schema with parameters written as JSON Logic over form values. Loaders are plain async functions supplied by the app. Results are cached per (source, params), so stale responses can never show.

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
- `$ref` (local) and `allOf`.
- Hide/show and disable/enable rules, scoped correctly inside array items (`$item`, `$parent`).
- Dependent option lists loaded from an API, with loading, idle, error and retry states. Child values clear when the parent changes.
- Schema extension from an API when a field changes (e.g. product → product-specific fields).
- Validation on submit, then live after the first attempt, with per-field messages and custom messages via `x-messages`.
- A submit payload with hidden and inactive data removed.

**Should have**

- Arrays of objects with add/remove and per-item layout.
- Defaults applied when fields appear.
- Values reset when fields become hidden disabled by dependant fields

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
- Replacing TanStack Form. We lean on it for state, subscriptions and submission.

## Open questions

- **Hidden-value policy.** Inactive values are kept in state today but removed on submit. Do some fields need clearing immediately instead? yes
- **Loader caching.** The cache is per form instance and only invalidated manually. Should it integrate with TanStack Query for shared caching and invalidation? yes
- **Schema versioning.** How are stored submissions validated after the schema changes?
- **Draft target.** Stay on draft-07 for tooling compatibility, or move to 2020-12 / JSON Schema v1 once it is published?
