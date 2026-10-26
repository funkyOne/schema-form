import type { ComponentType } from "react";
import type { AsyncEntry, ControlElement, Option, Schema } from "../engine";

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

const typeOf = (s: Schema) => (Array.isArray(s.type) ? s.type.find((t: string) => t !== "null") : s.type);
const isChoice = (s: Schema) => Array.isArray(s.enum) || !!s["x-options"];

// ---------------------------------------------------------------- chrome shared by all controls

export function FieldShell({
  id,
  label,
  required,
  description,
  errors,
  children,
  inline,
}: Pick<ControlProps, "id" | "label" | "required" | "description" | "errors"> & {
  children: React.ReactNode;
  inline?: boolean;
}) {
  return (
    <div className={`sf-field${inline ? " sf-field--inline" : ""}${errors.length ? " sf-field--invalid" : ""}`}>
      {inline ? (
        <label htmlFor={id} className="sf-inline-label">
          {children}
          <span>
            {label}
            {required && <span className="sf-required" aria-hidden> *</span>}
          </span>
        </label>
      ) : (
        <>
          <label htmlFor={id}>
            {label}
            {required && <span className="sf-required" aria-hidden> *</span>}
          </label>
          {children}
        </>
      )}
      {description && <p className="sf-help">{description}</p>}
      {errors.length > 0 && (
        <p className="sf-error" id={`${id}-error`} role="alert">
          {errors[0]}
        </p>
      )}
    </div>
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

const emptyToUndefined = (v: string) => (v === "" ? undefined : v);

// ---------------------------------------------------------------- default controls

export function TextControl(p: ControlProps) {
  const type = p.schema.format === "email" ? "email" : p.schema.format === "uri" ? "url" : "text";
  return (
    <FieldShell {...p}>
      <input
        {...aria(p)}
        type={type}
        value={(p.value as string) ?? ""}
        placeholder={p.options.placeholder}
        onChange={(e) => p.onChange(emptyToUndefined(e.target.value))}
      />
    </FieldShell>
  );
}

export function TextareaControl(p: ControlProps) {
  return (
    <FieldShell {...p}>
      <textarea {...aria(p)} rows={3} value={(p.value as string) ?? ""} onChange={(e) => p.onChange(emptyToUndefined(e.target.value))} />
    </FieldShell>
  );
}

export function DateControl(p: ControlProps) {
  return (
    <FieldShell {...p}>
      <input {...aria(p)} type="date" value={(p.value as string) ?? ""} onChange={(e) => p.onChange(emptyToUndefined(e.target.value))} />
    </FieldShell>
  );
}

export function NumberControl(p: ControlProps) {
  const integer = typeOf(p.schema) === "integer";
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

export function SelectControl(p: ControlProps) {
  const st = p.choicesState;
  const choices = p.choices ?? [];
  const placeholder =
    st?.status === "idle"
      ? p.options.placeholder ?? "Choose the previous field first"
      : st?.status === "loading"
        ? "Loading…"
        : st?.status === "error"
          ? "Couldn't load options"
          : p.options.placeholder ?? "Select…";
  const index = choices.findIndex((c) => c.value === p.value);
  return (
    <FieldShell {...p}>
      <div className="sf-select-row">
        <select
          {...aria(p)}
          disabled={p.disabled || (st !== undefined && st.status !== "success")}
          aria-busy={st?.status === "loading" || undefined}
          value={index >= 0 ? String(index) : ""}
          onChange={(e) => p.onChange(e.target.value === "" ? undefined : choices[Number(e.target.value)]!.value)}
        >
          <option value="">{placeholder}</option>
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
    <fieldset className={`sf-field sf-radios${p.errors.length ? " sf-field--invalid" : ""}`} id={p.id} aria-invalid={p.errors.length > 0 || undefined}>
      <legend>
        {p.label}
        {p.required && <span className="sf-required" aria-hidden> *</span>}
      </legend>
      {(p.choices ?? []).map((c, i) => (
        <label key={String(c.value)} className="sf-inline-label">
          <input
            type="radio"
            name={p.path}
            id={i === 0 ? `${p.id}-0` : undefined}
            disabled={p.disabled}
            checked={p.value === c.value}
            onChange={() => p.onChange(c.value)}
            onBlur={p.onBlur}
          />
          <span>{c.label}</span>
        </label>
      ))}
      {p.errors.length > 0 && (
        <p className="sf-error" role="alert">
          {p.errors[0]}
        </p>
      )}
    </fieldset>
  );
}

/** Array of enum values, e.g. { type: "array", items: { enum: [...] }, uniqueItems: true } */
export function MultiCheckboxControl(p: ControlProps) {
  const selected = Array.isArray(p.value) ? p.value : [];
  const toggle = (v: unknown, on: boolean) =>
    p.onChange(on ? [...selected, v] : selected.filter((x) => x !== v));
  return (
    <fieldset className={`sf-field sf-radios${p.errors.length ? " sf-field--invalid" : ""}`} id={p.id}>
      <legend>{p.label}</legend>
      {(p.choices ?? []).map((c) => (
        <label key={String(c.value)} className="sf-inline-label">
          <input type="checkbox" disabled={p.disabled} checked={selected.includes(c.value)} onChange={(e) => toggle(c.value, e.target.checked)} />
          <span>{c.label}</span>
        </label>
      ))}
      {p.errors.length > 0 && <p className="sf-error" role="alert">{p.errors[0]}</p>}
    </fieldset>
  );
}

export const defaultRenderers: RendererEntry[] = [
  { name: "text", rank: () => 1, component: TextControl },
  { name: "textarea", rank: (s, o) => (o.multi && typeOf(s) === "string" ? 6 : -1), component: TextareaControl },
  { name: "date", rank: (s) => (s.format === "date" ? 5 : -1), component: DateControl },
  { name: "number", rank: (s) => (["number", "integer"].includes(typeOf(s)) && !isChoice(s) ? 5 : -1), component: NumberControl },
  { name: "checkbox", rank: (s) => (typeOf(s) === "boolean" ? 5 : -1), component: CheckboxControl },
  { name: "select", rank: (s) => (isChoice(s) ? 10 : -1), component: SelectControl },
  // Few static choices read better as radios.
  { name: "radio", rank: (s) => (Array.isArray(s.enum) && s.enum.length <= 3 && s["x-enumLabels"] ? 11 : -1), component: RadioControl },
  { name: "multicheckbox", rank: (s) => (typeOf(s) === "array" && isChoice(s.items ?? {}) ? 10 : -1), component: MultiCheckboxControl },
];

export function pickRenderer(renderers: RendererEntry[], schema: Schema, options: ControlProps["options"]) {
  if (options.widget) {
    const forced = renderers.find((r) => r.name === options.widget);
    if (forced) return forced.component;
  }
  let best: RendererEntry | undefined;
  let bestRank = -1;
  for (const r of renderers) {
    const rank = r.rank(schema, options);
    if (rank > bestRank) (best = r), (bestRank = rank);
  }
  return (best ?? defaultRenderers[0]!).component;
}
