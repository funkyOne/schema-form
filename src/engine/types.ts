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
 */
export interface AsyncSourceRef {
  source: string;
  params?: Record<string, JsonLogic>;
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

// ---------------------------------------------------------------- UI schema

export type Effect = "HIDE" | "SHOW" | "DISABLE" | "ENABLE";

export type Condition =
  /** JSON Logic against { ...rootValues, $item, $parent } */
  | { logic: JsonLogic }
  /** JSON Schema test of the value at `path` (relative to the current base, "/" = absolute) */
  | { path: string; schema: Schema };

export interface Rule {
  effect: Effect;
  condition: Condition;
}

interface UIBase {
  rule?: Rule | Rule[];
}

export interface LayoutElement extends UIBase {
  type: "VerticalLayout" | "HorizontalLayout";
  elements: UIElement[];
}

export interface GroupElement extends UIBase {
  type: "Group";
  label?: string;
  elements: UIElement[];
}

export interface ControlElement extends UIBase {
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

export type UIElement = LayoutElement | GroupElement | ControlElement;

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
}

export interface ValidationResult {
  valid: boolean;
  /** Errors keyed by TanStack field name ("a.b[0].c"). */
  fields: Record<string, string>;
  /** Errors that don't belong to a field (root errors, pending loads). */
  form?: string;
}
