# Use cases

Real-life requirements and how the form handles them. Add new ones at the end; when one isn't
supported yet, write it anyway and mark it **Not yet**, so it becomes the next piece of work.

Template:

```md
## N. Short name
**Need:** what the business/user wants, in one or two sentences.
**How:** the schema / UI schema / loader that expresses it.
**Status:** Supported (test: file › name) | Not yet
```

---

## 1. Dependent dropdown
**Need:** pick a country, then a city from that country's list (loaded from the API). Changing the country clears the city.
**How:** `city: { "x-options": { source: "cities", params: { country: { var: "$parent.country" } } } }`
**Status:** Supported (test: form.test › loads dependent options and clears the child when the parent changes)

## 2. One API call feeding several dropdowns
**Need:** choosing a country calls one endpoint that returns cities, postcodes and zones together; each dropdown shows its part.
**How:** same `source` and `params` on each field, plus `select` naming the part: `{ source: "region", params: {...}, select: "cities" }`. Fields sharing source + params share one request.
**Status:** Supported (test: form-features › fills both selects from one call and clears both when the parent changes)

## 3. Product-specific fields from the API
**Need:** after picking a product, show the fields that product needs, as defined by the backend.
**How:** `details: { type: "object", "x-extend": { source: "productFields", params: { product: { var: "product" } } } }`; the loader returns a schema fragment.
**Status:** Supported (test: form.test › extends the form with fields fetched for the chosen product)

## 4. Different fields per applicant type
**Need:** an individual gives name and date of birth; a company gives company name and VAT details.
**How:** `oneOf` branches with a `const` discriminator (`kind: "individual" | "company"`).
**Status:** Supported (test: form.test › switches discriminated branches)

## 5. User picks how to be contacted
**Need:** contact by email or by phone; only the chosen one is filled in and submitted.
**How:** `oneOf` without a discriminator; the form shows a branch picker.
**Status:** Supported (test: form-features › switches oneOf branches without a discriminator from their defaults)

## 6. Conditionally required field
**Need:** a postcode is required (and must be UK-shaped) only when the country is the UK.
**How:** `if: { properties: { country: { const: "GB" } } }, then: { required: ["postcode"], ... }` with a custom `x-messages.pattern`.
**Status:** Supported (test: engine.test › maps errors to field paths, including inside arrays and API-provided fields)

## 7. Show a field only when relevant
**Need:** ask for a marketing channel only if the user opted in; otherwise it is neither required nor submitted, and an earlier answer is cleared.
**How:** on the field in the schema: `"x-hidden": { "logic": { "!=": [{ "var": "marketingConsent" }, true] } }`. While it holds, the property is not part of the schema (like an unmet `if`). A UI-schema group whose fields are all hidden disappears too.
**Status:** Supported (tests: engine-features › x-hidden / x-disabled; form-features › clears values as soon as x-hidden or x-disabled takes their field away, hides a group once every field in it is hidden)

## 8. Lock a field based on another answer
**Need:** a promo code can't be used when there are previous claims; the field is disabled, emptied and not validated.
**How:** on the field in the schema: `"x-disabled": { "logic": { "var": "hasPreviousClaims" } }`. On an object it locks everything inside, wherever the layout places those fields.
**Status:** Supported (tests: engine-features › disabled fields › are not validated or submitted; form-features › disables descendants of an x-disabled object)

## 9. Repeating items with per-item rules
**Need:** list previous claims; each claim asks "what happened?" only when its type is "other".
**How:** on the item's field: `"x-hidden": { "logic": { "!=": [{ "var": "$parent.type" }, "other"] } }`. Conditions are evaluated at the field's own path, so `$parent` is the claim and `$item` the nearest array item.
**Status:** Supported (test: engine.test › hidden and disabled › evaluates $parent per array item)

## 10. Optional value that can be explicitly empty
**Need:** a field the user may clear, sending `null` rather than omitting it.
**How:** `anyOf: [{ type: "string" }, { type: "null" }]`.
**Status:** Supported (test: form-features › writes null when a nullable field is cleared)

## 11. Nested structure of any depth
**Need:** a tree (e.g. an org unit with child units), validated at every level.
**How:** a recursive `$ref` (`child: { $ref: "#/definitions/node" }`).
**Status:** Supported (test: engine-features › validates recursive schemas)

## 12. Prefill from an API
**Need:** type a value (e.g. a company number or postcode) and fill several other fields (name, VAT details, address) from the API, either when the user presses a button or automatically as the value changes. Only a defined set of fields is filled.
**How:** `x-prefill` on the field whose value drives the fetch:
`"x-prefill": { "source": "company", "params": { "number": { "var": "$self" } }, "label": "Find company", "fill": { "companyName": "name", "/address.line1": "address" } }`.
`fill` maps target field (relative to the object holding the field, `/` = absolute) → path in the response; values the response lacks are left alone. Each run fetches fresh data.
`"trigger"`: `"button"` (default; disabled until the params are filled, shows "Looking up…" and an error on failure) or `"change"` (runs whenever the params change and are complete; only the latest run writes).
`"overwrite"`: `"always"` (default for a button) replaces every target the response has; `"unedited"` (default on change) keeps values the user typed or that were loaded without provenance, and replaces empty fields and ones last written by a prefill or compute.
Assistive only: the server doesn't run it, it validates whatever values result.
**Status:** Supported (tests: form-features › x-prefill button, x-prefill order, x-prefill on change; engine-features › x-prefill). Demo: company number `12345678`.

## 13. Derived (computed) fields
**Need:** a total that follows other fields (sum of claim amounts, quantity × price). Some are display-only; some are a suggestion the user may change.
**How:** `"x-compute"` on the field it writes, holding JSON Logic over the form values or a loader ref (`{ source, params, select }`) for anything the server must calculate. `readOnly: true` makes it always derived; otherwise it is filled while untouched and the user's own edit (or clear) wins. The field a compute sits on is the only field it writes, so ownership cannot overlap; computes read the incoming values only, and `applyComputed` settles chains and throws if two computes chase each other. Hidden fields are not computed.
**Status:** Supported (tests: engine-features › computed fields; form-features › computed fields). Demo: claims total.

## 14. Autofill provenance
**Need:** know which fields came from which source (a prefill, a compute) so a later autofill replaces or clears only its own earlier fills and never erases what the user typed; detect that the user has overridden an autofilled value.
**How:** a provenance map (field path → `"compute"`, a prefill's source name, or `"user"`) kept as data next to the values and reported in every snapshot. Prefills attribute what they fill and clear what they filled before when the new response lacks it. A manual edit, including clearing, marks the field `"user"`, which computes then leave alone. Removing an array item re-indexes entries under it.
**Status:** Supported (tests: engine-features › x-prefill › clears fields it filled before; form-features › x-prefill provenance, computed fields).

## 15. Drafts and browser backups
**Need:** save a half-filled form (server draft, localStorage) and resume it later, including after the schema changed, without losing autofill tracking or a chosen branch.
**How:** `onStateChange` gives a `FormSnapshot` (`values`, `provenance`, `selections`) on every change; pass it back as `initialState` to resume. The library stays storage-agnostic. Values the current schema no longer describes are pruned on submit, their provenance entries are dropped on load, and nothing is validated until the user submits. Fields whose options or fragments are still loading keep their values until the data lands.
**Status:** Supported (tests: form-features › computed fields › resumes from a snapshot; keeps initial values for fields that are still loading). Demo: the form is backed up to localStorage.

## 16. Externally sourced values outside the option list
**Need:** a prefilled or imported value for a field whose options are loaded from the API, where the value is not in the loaded list, must not be wiped or fail validation.
**How:** by default loaded options become a strict `enum` and a value outside the list is cleared. `"x-options": { ..., "strict": false }` keeps the list for display only: the value is validated by the field's own keywords, never cleared, shown as itself in the select, and submit doesn't wait for the list to load.
**Status:** Supported (tests: engine-features › non-strict options; form-features › non-strict options)

## 17. Server-side errors after submit
**Need:** the server rejects a submission with field-level errors (duplicate email, failed checks) that the UI should show inline next to the fields, alongside schema errors.
**How:** `onSubmit` returns `{ fields, form }`, the same shape the engine's `validate` produces (so a server running the engine can return its result as-is). Errors show inline and in the summary, the first invalid control is focused, and each clears when its field is next validated (on edit, after a submit attempt).
**Status:** Supported (test: form-features › server errors)

## 18. Cross-field validation
**Need:** Account Description must not equal Account Mnemonic; the error shows on `description` as the user types.
**How:** on the field it reports on: `"x-validate": [{ "logic": { "!=": [{ "var": "$self" }, { "var": "$parent.mnemonic" }] }, "message": "Account Description cannot be the same as Account Mnemonic" }]`. A rule's logic must hold; it is skipped while the field is empty, hidden or disabled. Rules are part of `validate` (so the server runs them too and they block submit) and the form shows their errors live once the field was edited, re-evaluated on every change, so editing the other field clears the error.
**Status:** Supported (tests: form-scenarios › 18; engine-features › x-validate rules)

## 19. Errors from a remote check, shown before submit
**Need:** a GOC code with no search results is marked "Invalid GOC" right away. AMC validation runs when the user reaches Review, and its errors show inline on their fields until fixed.
**How:** a rule over loaded data: `"x-validate": [{ "source": "gocSearch", "params": { "q": { "var": "$self" } }, "logic": { "!!": { "var": "$data.length" } }, "message": "Invalid GOC. Please enter a valid GOC" }]` (shares the request with a typeahead using the same source and params; submit waits while it loads). Hierarchy fields fill through `x-prefill` with `trigger: "change"`.
For checks the host runs itself (AMC), pass `externalErrors={{ amc: { fields: { foRiskSystem: "…" } } }}`: shown inline at once, kept until the host replaces or removes that entry (i.e. the next run), and they block submit. `useSchemaForm().validateLocal()` tells the host whether local rules pass, so it can skip AMC and clear its old errors when they don't. Mapping AMC's entities to field paths is the host's job.
**Status:** Supported (tests: form-scenarios › 19A, 19B; engine-features › x-validate rules › waits for a rule's source)

## 20. Custom control for an array of objects
**Need:** downstream systems are a table of `{ systemName, csiId }` rows with checkboxes, not an add/remove list.
**How:** `"x-widget": "downstreamTable"` on the array (or `options.widget` in the UI schema) renders it with that renderer as one field holding the whole array. `"x-data": { "selectable": { "source": "downstream", "select": "selectable" }, "automated": { … "select": "automated" } }` loads the rows (one request) and passes them to the control as `data`. Which rows are ticked, their order and keeping draft-only entries is the control's own logic.
**Status:** Supported (test: form-scenarios › 20)

## 21. Multi-step form with a Review step
**Need:** a stepper (the client's design-system component) with one step per group of fields, error badges per step after Review is visited, and Review listing the steps with errors.
**How:** a custom UI schema type, `{ "type": "Stepper", "elements": [{ "type": "Group", "label": "Classification", … }, …] }`, rendered by the component passed in `layouts={{ Stepper }}`. It receives `sections` (label, active field paths, `render()`); steps whose fields are all hidden are left out. Steps are display only and never gate validation: the stepper keeps "Review visited" itself and computes badges with `errorsWithin(useFormErrors({ all: true }), section.fields)`, which update as fields are fixed. A step can hide on service data with `"x-hidden": { "source": "downstream", "select": "selectable", "logic": { "!": { "var": "$data.length" } } }`.
**Status:** Supported (tests: form-scenarios › 21; engine-features › conditions over loaded data, fieldsOf)
