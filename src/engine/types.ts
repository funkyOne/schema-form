/** JSON Schema object. Kept loose on purpose: we accept any draft-07-ish schema. */
export type Schema = { [key: string]: any };

/** A JSON Logic expression, e.g. { "==": [{ "var": "country" }, "GB"] } */
export type JsonLogic = unknown;

// ---------------------------------------------------------------- async sources

/**
 * Declared on a schema node to fetch something from your API:
 *   "x-options": { "source": "cities", "params": { "country": { "var": "address.country" } } }
 *   "x-extend":  { "source": "productFields", "params": { "product": { "var": "$self.product" } } }
 *
 * Each param is a JSON Logic expression evaluated against the form values.
 * If any param evaluates to null/undefined/"" the source is "idle" and nothing is fetched.
 *
 * `select` picks part of the response by path ("cities", "lists.postcodes"), so one call can
 * feed several fields: refs with the same source and params share a single request.
 * A missing part reads as an empty list (x-options) or no extra fields (x-extend).
 */
export interface AsyncSourceRef {
  source: string;
  params?: Record<string, JsonLogic>;
  select?: string;
  /**
   * x-options only. By default the loaded list is enforced: the value must be one of it and
   * is cleared when it isn't. `false` keeps the list for display only, so values that arrive
   * from elsewhere (an import, an older draft, a lookup) are kept and validated by the
   * field's own keywords.
   */
  strict?: boolean;
}

/**
 * Fetch data for a field's value and write it into other fields. Declared on the field whose
 * value drives the fetch:
 *   "x-prefill": { "source": "company", "params": { "number": { "var": "$self" } },
 *                  "fill": { "companyName": "name", "/address.postcode": "address.postcode" } }
 * `fill` maps target field paths (relative to the object holding the field, "/" = absolute) to
 * paths in the response. Only targets the response has a value for are written.
 *
 * Assistive, not validation: it only suggests values, which are then validated like any other.
 * A validating engine (e.g. on the server) may ignore it.
 */
export interface Prefill extends AsyncSourceRef {
  fill: Record<string, string>;
  /**
   * "button" (default): a button next to the field runs it.
   * "change": runs automatically whenever its params change and are all filled in.
   */
  trigger?: "button" | "change";
  /**
   * Which targets the response may overwrite (default: "always" for a button, "unedited" on change):
   * - "always": every target the response has a value for.
   * - "unedited": only targets that are empty or were last written by a prefill or compute;
   *   values the user typed, or loaded without provenance, are kept.
   */
  overwrite?: "always" | "unedited";
  /** Button text (default "Look up"). */
  label?: string;
}

/**
 * Derive a field's value from other fields, declared on the field it writes:
 *   "x-compute": { "logic": { "*": [{ "var": "$parent.qty" }, { "var": "$parent.price" }] } }
 *   "x-compute": { "source": "pricing", "params": { "product": { "var": "product" } }, "select": "total" }
 *
 * A `readOnly` field is always derived. An editable one is filled while it is untouched or
 * still holds the computed value; once the user edits or clears it, their value wins (see Provenance).
 * The field a compute sits on is the only field it writes, so ownership can't overlap.
 */
export type Compute = { logic: JsonLogic } | AsyncSourceRef;

/** Provenance entries written by the engine ("compute") and by the React layer on a manual edit ("user"). */
export const COMPUTE_SOURCE = "compute";
export const USER_SOURCE = "user";

/**
 * Who last wrote each field: "compute", a prefill's source name, or "user" for a manual edit
 * (including clearing it). No entry means nobody has touched it since it was loaded.
 * Kept as data next to the values so drafts preserve it.
 */
export type Provenance = Record<string, string>;

/** One write to a field. `source` is recorded in Provenance; undefined = forget it. */
export interface Patch {
  path: string;
  value: unknown;
  source?: string;
}

/** Everything needed to resume a form: save it as a draft or browser backup. */
export interface FormSnapshot {
  values: unknown;
  provenance?: Provenance;
  /** Branch picks for oneOf/anyOf without a discriminator, by field path. */
  selections?: Record<string, number>;
}

export interface Option {
  value: string | number | boolean;
  label: string;
}

export type Loader = (
  params: Record<string, unknown>,
  ctx: { signal: AbortSignal },
) => Promise<unknown>;

/** `x-options` loaders return Option[]; `x-extend` loaders return a schema fragment. */
export type Loaders = Record<string, Loader>;

export type AsyncEntry<T = unknown> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: unknown; retry: () => void };

// ---------------------------------------------------------------- conditions

/**
 * A condition on a schema property, used by `x-hidden` and `x-disabled`:
 *   "x-hidden":   { "logic": { "!": { "var": "$parent.marketingConsent" } } }
 *   "x-disabled": { "path": "vatRegistered", "schema": { "not": { "const": true } } }
 *
 * `logic` is JSON Logic against { ...rootValues, $self, $parent, $item }, evaluated at the
 * property's own path. `path` + `schema` tests the value at `path` (relative to the object
 * holding the property, "/" = absolute) against a JSON Schema.
 *
 * x-hidden: while true the property is not part of the schema at all, exactly like a property
 *   under an unmet `if`: not rendered, not required, not validated, value cleared.
 * x-disabled: while true the field (and everything under it) is shown locked, is not validated
 *   or submitted, and its value is cleared.
 */
export type Condition = DataLogic | { path: string; schema: Schema };

/**
 * JSON Logic evaluated at a field's own path ($self, $parent, $item), optionally over loaded data:
 * with `source` (+ `params`, `select`, as in AsyncSourceRef) the response is available as `$data`.
 *   { "source": "downstream", "params": { ... }, "logic": { "!": { "var": "$data.selectable.length" } } }
 * While the source is loading or failed, `$data` is undefined and validation waits (reports it
 * as still loading / failed to load), so a condition never lets data through unchecked.
 */
export interface DataLogic {
  logic: JsonLogic;
  source?: string;
  params?: Record<string, JsonLogic>;
  select?: string;
}

/**
 * A custom validation rule, declared on the field it reports on:
 *   "x-validate": [{ "logic": { "!=": [{ "var": "$self" }, { "var": "$parent.mnemonic" }] },
 *                    "message": "Description cannot be the same as Mnemonic" }]
 * `logic` must hold (be truthy) for the value to be valid. Rules run only on fields that are
 * active and hold a value (`required` covers empty ones). With `source`, the logic sees the
 * loaded response as `$data` (e.g. "a search for this code returns something").
 * Rules are part of `validate`, so they run on the server too; the form shows their errors
 * live, without waiting for a submit.
 */
export interface Rule extends DataLogic {
  message: string;
}

// ---------------------------------------------------------------- UI schema (layout only)

// Visibility and locking live in the schema (x-hidden / x-disabled); the UI schema is layout only.

export interface LayoutElement {
  type: "VerticalLayout" | "HorizontalLayout";
  /** Not shown by the built-in layouts; available to a custom layout holding this one (e.g. a step title). */
  label?: string;
  elements: UIElement[];
}

export interface GroupElement {
  type: "Group";
  label?: string;
  elements: UIElement[];
}

export interface ControlElement {
  type: "Control";
  /** Data path, e.g. "address.city". Relative to the current array item / object detail. */
  path: string;
  label?: string;
  options?: {
    /** Layout for the children of an object, or for each item of an array (paths relative to the item). */
    detail?: UIElement;
    /** Force a specific renderer by name. */
    widget?: string;
    /** Render a string as a textarea. */
    multi?: boolean;
    placeholder?: string;
    [key: string]: unknown;
  };
}

/**
 * A layout type the host renders itself (a stepper, tabs, an accordion), registered through
 * `<SchemaForm layouts={{ Stepper: MyStepper }}>`. Its `elements` are its sections (e.g. steps).
 * Purely presentational: it never gates validation.
 */
export interface CustomElement {
  type: string;
  label?: string;
  elements: UIElement[];
  options?: Record<string, unknown>;
}

export type UIElement = LayoutElement | GroupElement | ControlElement | CustomElement;

const BUILT_IN_TYPES: ReadonlySet<string> = new Set(["Control", "VerticalLayout", "HorizontalLayout", "Group"]);

export const isControl = (el: UIElement): el is ControlElement => el.type === "Control";

/** A layout type the host registers in `layouts` rather than one of the built-in types. */
export const isCustomLayout = (el: UIElement): el is CustomElement => !BUILT_IN_TYPES.has(el.type);

// ---------------------------------------------------------------- resolution

export interface Combinator {
  kind: "oneOf" | "anyOf";
  /** Branch schemas (dereferenced) and their display titles. */
  branches: Schema[];
  titles: string[];
  /** -1 when a discriminator exists but has no value yet. */
  selected: number;
  /** Property whose `const` picks the branch, when every branch has one. */
  discriminator?: string;
}

export interface Resolved {
  /** Flattened schema: no $ref/allOf/if/oneOf/anyOf/x-extend at this level. */
  schema: Schema;
  combinator?: Combinator;
  nullable: boolean;
  /** Status of an `x-extend` on this node, if any. */
  extend?: AsyncEntry;
  /** Child keys whose `x-hidden` reads a source that is still loading or failed. */
  waiting?: Record<string, "loading" | "error">;
}

/** Errors by field path plus an optional form-level message: what validation produces and what a server may return. */
export interface FormErrors {
  /** Errors keyed by TanStack field name ("a.b[0].c"). */
  fields?: Record<string, string>;
  /** An error that doesn't belong to a field (root errors, pending loads, a rejected submission). */
  form?: string;
}

export interface ValidationResult extends FormErrors {
  valid: boolean;
  fields: Record<string, string>;
}
