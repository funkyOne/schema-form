import type { ComponentType, ReactNode } from "react";
import { primaryType, type AsyncEntry, type ControlElement, type CustomElement, type Option, type Schema, type UIElement } from "../engine";

/** Everything a leaf control needs. Swap these components for your design system. */
export interface ControlProps {
  id: string;
  path: string;
  schema: Schema;
  label: string;
  description?: string;
  required: boolean;
  disabled: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  onBlur: () => void;
  /** Validation messages for this field (empty until the first submit). */
  errors: string[];
  options: NonNullable<ControlElement["options"]>;
  /** Static enum choices, or choices loaded via x-options. */
  choices?: Option[];
  /** Load state of x-options; undefined for static enums. */
  choicesState?: AsyncEntry<Option[]>;
  /** Data loaded for the field's `x-data` refs, by name (e.g. rows for a table control). */
  data: Record<string, AsyncEntry>;
}

/** One section of a custom layout (e.g. a step) that has at least one active field. */
export interface LayoutSection {
  el: UIElement;
  /** The section's `label`, when it has one. */
  label?: string;
  /** Data paths of its active fields; pass them to `errorsWithin` for a section's errors. */
  fields: string[];
  /** Render the section's content. */
  render: () => ReactNode;
}

/**
 * Props of a custom layout (`<SchemaForm layouts={{ Stepper }}>`). Sections whose fields are all
 * hidden or inactive are left out. Layouts are display only: which section is open, and whether
 * errors are shown on them, is the layout's own state.
 */
export interface LayoutProps {
  el: CustomElement;
  sections: LayoutSection[];
}

export interface RendererEntry {
  name: string;
  /** Higher rank wins; return -1 to opt out. `options.widget === name` always wins. */
  rank: (schema: Schema, options: ControlProps["options"]) => number;
  component: ComponentType<ControlProps>;
}

export const humanize = (s: string) => {
  const words = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Rendered as a pick list: a static enum or options loaded from the API. */
export const isChoice = (s: Schema) => Array.isArray(s.enum) || !!s["x-options"];

// ---------------------------------------------------------------- chrome shared by all controls

export function ErrorText({ errors, id }: { errors: string[]; id?: string }) {
  if (!errors.length) return null;
  return (
    <p className="sf-error" id={id} role="alert">
      {errors[0]}
    </p>
  );
}

const Label = ({ label, required }: { label: string; required: boolean }) => (
  <>
    {label}
    {required && <span className="sf-required" aria-hidden> *</span>}
  </>
);

const fieldClass = (base: string, errors: string[]) => `${base}${errors.length ? " sf-field--invalid" : ""}`;

export function FieldShell({
  id,
  label,
  required,
  description,
  errors,
  children,
  inline,
}: Pick<ControlProps, "id" | "label" | "required" | "description" | "errors"> & {
  children: ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={fieldClass(inline ? "sf-field sf-field--inline" : "sf-field", errors)}>
      {inline ? (
        <label htmlFor={id} className="sf-inline-label">
          {children}
          <span>
            <Label label={label} required={required} />
          </span>
        </label>
      ) : (
        <>
          <label htmlFor={id}>
            <Label label={label} required={required} />
          </label>
          {children}
        </>
      )}
      {description && <p className="sf-help">{description}</p>}
      <ErrorText errors={errors} id={`${id}-error`} />
    </div>
  );
}

/** A fieldset of radios or checkboxes, one per choice. */
function ChoiceGroup({ p, children }: { p: ControlProps; children: (choice: Option, i: number) => ReactNode }) {
  return (
    <fieldset className={fieldClass("sf-field sf-radios", p.errors)} id={p.id} aria-invalid={p.errors.length > 0 || undefined}>
      <legend>
        <Label label={p.label} required={p.required} />
      </legend>
      {(p.choices ?? []).map((c, i) => (
        <label key={String(c.value)} className="sf-inline-label">
          {children(c, i)}
          <span>{c.label}</span>
        </label>
      ))}
      <ErrorText errors={p.errors} />
    </fieldset>
  );
}

const aria = (p: ControlProps) => ({
  id: p.id,
  name: p.path,
  disabled: p.disabled,
  "aria-invalid": p.errors.length > 0 || undefined,
  "aria-describedby": p.errors.length ? `${p.id}-error` : undefined,
  "aria-required": p.required || undefined,
  onBlur: p.onBlur,
});

// ---------------------------------------------------------------- default controls

/** Shared by the text, textarea and date controls: strings, with "" stored as undefined. */
function StringInput({ p, type, multiline }: { p: ControlProps; type?: string; multiline?: boolean }) {
  const input = {
    ...aria(p),
    value: (p.value as string) ?? "",
    placeholder: p.options.placeholder,
    onChange: (e: { target: { value: string } }) => p.onChange(e.target.value === "" ? undefined : e.target.value),
  };
  return <FieldShell {...p}>{multiline ? <textarea {...input} rows={3} /> : <input {...input} type={type} />}</FieldShell>;
}

export const TextControl = (p: ControlProps) => (
  <StringInput p={p} type={p.schema.format === "email" ? "email" : p.schema.format === "uri" ? "url" : "text"} />
);
export const TextareaControl = (p: ControlProps) => <StringInput p={p} multiline />;
export const DateControl = (p: ControlProps) => <StringInput p={p} type="date" />;

export function NumberControl(p: ControlProps) {
  const integer = primaryType(p.schema) === "integer";
  return (
    <FieldShell {...p}>
      <input
        {...aria(p)}
        type="number"
        inputMode={integer ? "numeric" : "decimal"}
        step={integer ? 1 : "any"}
        min={p.schema.minimum}
        max={p.schema.maximum}
        value={p.value === undefined || p.value === null ? "" : String(p.value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return p.onChange(undefined);
          const n = Number(raw);
          p.onChange(Number.isNaN(n) ? raw : n);
        }}
      />
    </FieldShell>
  );
}

export function CheckboxControl(p: ControlProps) {
  return (
    <FieldShell {...p} inline>
      <input {...aria(p)} type="checkbox" checked={p.value === true} onChange={(e) => p.onChange(e.target.checked)} />
    </FieldShell>
  );
}

const SELECT_PLACEHOLDER = { idle: "Choose the previous field first", loading: "Loading…", error: "Couldn't load options" };

export function SelectControl(p: ControlProps) {
  const st = p.choicesState;
  const choices = p.choices ?? [];
  const placeholder =
    st?.status === "loading" || st?.status === "error"
      ? SELECT_PLACEHOLDER[st.status]
      : (p.options.placeholder ?? (st?.status === "idle" ? SELECT_PLACEHOLDER.idle : "Select…"));
  const index = choices.findIndex((c) => c.value === p.value);
  // A value outside the list (non-strict x-options, or still loading) stays visible as itself.
  const foreign = p.value !== undefined && p.value !== null && index < 0;
  return (
    <FieldShell {...p}>
      <div className="sf-select-row">
        <select
          {...aria(p)}
          disabled={p.disabled || (st !== undefined && st.status !== "success")}
          aria-busy={st?.status === "loading" || undefined}
          value={index >= 0 ? String(index) : foreign ? "current" : ""}
          onChange={(e) => {
            const v = e.target.value;
            p.onChange(v === "" ? undefined : v === "current" ? p.value : choices[Number(v)]!.value);
          }}
        >
          <option value="">{placeholder}</option>
          {foreign && <option value="current">{String(p.value)}</option>}
          {choices.map((c, i) => (
            <option key={String(c.value)} value={String(i)}>
              {c.label}
            </option>
          ))}
        </select>
        {st?.status === "error" && (
          <button type="button" className="sf-link" onClick={st.retry}>
            Retry
          </button>
        )}
      </div>
    </FieldShell>
  );
}

export function RadioControl(p: ControlProps) {
  return (
    <ChoiceGroup p={p}>
      {(c, i) => (
        <input
          type="radio"
          name={p.path}
          id={i === 0 ? `${p.id}-0` : undefined}
          disabled={p.disabled}
          checked={p.value === c.value}
          onChange={() => p.onChange(c.value)}
          onBlur={p.onBlur}
        />
      )}
    </ChoiceGroup>
  );
}

/** Array of enum values, e.g. { type: "array", items: { enum: [...] }, uniqueItems: true } */
export function MultiCheckboxControl(p: ControlProps) {
  const selected = Array.isArray(p.value) ? p.value : [];
  return (
    <ChoiceGroup p={p}>
      {(c) => (
        <input
          type="checkbox"
          disabled={p.disabled}
          checked={selected.includes(c.value)}
          onChange={(e) => p.onChange(e.target.checked ? [...selected, c.value] : selected.filter((x) => x !== c.value))}
        />
      )}
    </ChoiceGroup>
  );
}

const typeIs = (s: Schema, ...types: string[]) => types.includes(primaryType(s) ?? "");

export const defaultRenderers: RendererEntry[] = [
  { name: "text", rank: () => 1, component: TextControl },
  { name: "textarea", rank: (s, o) => (o.multi && typeIs(s, "string") ? 6 : -1), component: TextareaControl },
  { name: "date", rank: (s) => (s.format === "date" ? 5 : -1), component: DateControl },
  { name: "number", rank: (s) => (typeIs(s, "number", "integer") && !isChoice(s) ? 5 : -1), component: NumberControl },
  { name: "checkbox", rank: (s) => (typeIs(s, "boolean") ? 5 : -1), component: CheckboxControl },
  { name: "select", rank: (s) => (isChoice(s) ? 10 : -1), component: SelectControl },
  // Few static choices read better as radios.
  { name: "radio", rank: (s) => (Array.isArray(s.enum) && s.enum.length <= 3 && s["x-enumLabels"] ? 11 : -1), component: RadioControl },
  { name: "multicheckbox", rank: (s) => (typeIs(s, "array") && isChoice(s.items ?? {}) ? 10 : -1), component: MultiCheckboxControl },
];

/** The renderer registered under `name`, if any. */
export const findRenderer = (renderers: RendererEntry[], name: string | undefined) =>
  name ? renderers.find((r) => r.name === name) : undefined;

export function pickRenderer(renderers: RendererEntry[], schema: Schema, options: ControlProps["options"]) {
  const forced = findRenderer(renderers, options.widget);
  if (forced) return forced.component;
  let best = defaultRenderers[0]!;
  let bestRank = -1;
  for (const r of renderers) {
    const rank = r.rank(schema, options);
    if (rank > bestRank) (best = r), (bestRank = rank);
  }
  return best.component;
}
