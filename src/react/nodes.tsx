import { useEffect, type ReactNode } from "react";
import {
  joinPath,
  parsePath,
  resolveRelativePath,
  type ControlElement,
  type Option,
  type Resolved,
  type Schema,
  type UIElement,
} from "../engine";
import { BaseProvider, shallowArrayEqual, useBase, useFormSelector, useSchemaForm } from "./context";
import { humanize, pickRenderer, type ControlProps } from "./controls";

type Options = NonNullable<ControlElement["options"]>;
const NO_OPTIONS: Options = {};
const NO_ERRORS: string[] = [];

const lastSegment = (path: string) => {
  const segs = parsePath(path);
  const last = segs[segs.length - 1];
  return typeof last === "string" ? last : "";
};
const idFor = (path: string) => "sf-" + (path || "root").replace(/[^a-zA-Z0-9_-]+/g, "-");

const typeOf = (s: Schema): string | undefined => {
  const t = Array.isArray(s.type) ? s.type.find((x: string) => x !== "null") : s.type;
  return t ?? (s.properties ? "object" : s.items ? "array" : undefined);
};

/** Errors set directly on a path (e.g. object/array-level errors like minItems). */
function usePathErrors(path: string): string[] {
  return useFormSelector(
    (s) => (s.fieldMeta?.[path]?.errors as string[] | undefined) ?? NO_ERRORS,
    shallowArrayEqual,
  );
}

// ================================================================= UI schema elements

export function UIElementView({ el }: { el: UIElement }) {
  const { engine } = useSchemaForm();
  const { base } = useBase();
  const state = useFormSelector((s) => engine.ruleState(el.rule, base, s.values));
  if (state.hidden) return null;

  let inner: ReactNode;
  if (el.type === "Control") inner = <ControlView el={el} />;
  else {
    const children = el.elements.map((child, i) => <UIElementView key={i} el={child} />);
    if (el.type === "Group")
      inner = (
        <fieldset className="sf-group">
          {el.label && <legend>{el.label}</legend>}
          {children}
        </fieldset>
      );
    else inner = <div className={el.type === "HorizontalLayout" ? "sf-row" : "sf-col"}>{children}</div>;
  }
  return state.disabled ? <BaseProvider disabled>{inner}</BaseProvider> : inner;
}

function ControlView({ el }: { el: ControlElement }) {
  const { engine } = useSchemaForm();
  const { base } = useBase();
  const path = resolveRelativePath(el.path, base);
  // undefined when the field isn't part of the active schema (inactive branch, if/then not met, not loaded yet)
  const node = useFormSelector((s) => engine.schemaAt(path, s.values));
  const required = useFormSelector((s) => engine.requiredAt(path, s.values));
  if (node === undefined) return null;
  return <SchemaNode schema={node} path={path} label={el.label} options={el.options} required={required} />;
}

// ================================================================= schema nodes

interface NodeProps {
  schema: unknown;
  path: string;
  label?: string;
  options?: Options;
  required?: boolean;
}

/** Resolves the schema at `path` for the current values and renders the matching node. */
export function SchemaNode({ schema, path, label, options = NO_OPTIONS, required = false }: NodeProps) {
  const { engine } = useSchemaForm();
  const resolved = useFormSelector((s) => engine.resolve(schema, path, s.values));
  const s = resolved.schema;
  const title = label ?? s.title ?? humanize(lastSegment(path));
  const choice = Array.isArray(s.enum) || !!s["x-options"];
  const type = typeOf(s);

  const switcher =
    resolved.combinator && !resolved.combinator.discriminator ? (
      <BranchSwitch node={schema} path={path} resolved={resolved} label={title} />
    ) : null;

  if (type === "object" && !choice)
    return <ObjectNode node={schema} resolved={resolved} path={path} label={title} options={options} switcher={switcher} />;

  const itemsChoice =
    type === "array" && s.items !== undefined && engine.resolve(s.items, joinPath(path, 0), undefined).schema;
  if (type === "array" && s.items !== undefined && !(itemsChoice && (itemsChoice.enum || itemsChoice["x-options"])))
    return <ArrayNode resolved={resolved} path={path} label={title} options={options} />;

  return (
    <>
      {switcher}
      <FieldNode
        schema={itemsChoice ? { ...s, items: itemsChoice } : s}
        nullable={resolved.nullable}
        path={path}
        label={title}
        options={options}
        required={required}
      />
    </>
  );
}

function ObjectNode({
  resolved,
  path,
  label,
  options,
  switcher,
}: {
  node: unknown;
  resolved: Resolved;
  path: string;
  label: string;
  options: Options;
  switcher: ReactNode;
}) {
  const s = resolved.schema;
  const errors = usePathErrors(path);
  const required: string[] = s.required ?? [];

  const content = options.detail ? (
    <BaseProvider base={path}>
      <UIElementView el={options.detail} />
    </BaseProvider>
  ) : (
    Object.entries(s.properties ?? {}).map(([key, child]) => (
      <SchemaNode key={key} schema={child} path={joinPath(path, key)} required={required.includes(key)} />
    ))
  );

  const ext = resolved.extend;
  const status =
    ext?.status === "loading" ? (
      <p className="sf-status" role="status">Loading fields…</p>
    ) : ext?.status === "error" ? (
      <p className="sf-error" role="alert">
        Couldn't load these fields.{" "}
        <button type="button" className="sf-link" onClick={ext.retry}>
          Retry
        </button>
      </p>
    ) : ext?.status === "idle" && !Object.keys(s.properties ?? {}).length ? (
      <p className="sf-status">Complete the fields above to see more options.</p>
    ) : null;

  if (!path) return <div className="sf-col">{content}</div>;
  return (
    <fieldset className="sf-object" aria-busy={ext?.status === "loading" || undefined}>
      <legend>{label}</legend>
      {switcher}
      {content}
      {status}
      {errors.length > 0 && <p className="sf-error" role="alert">{errors[0]}</p>}
    </fieldset>
  );
}

/** Picker for oneOf/anyOf branches that have no discriminator property. */
function BranchSwitch({ node, path, resolved, label }: { node: unknown; path: string; resolved: Resolved; label: string }) {
  const { engine, form } = useSchemaForm();
  const { disabled } = useBase();
  const c = resolved.combinator!;
  const name = `${idFor(path)}-branch`;
  return (
    <div className="sf-branches" role="radiogroup" aria-label={`${label}: choose one`}>
      {c.titles.map((title, i) => (
        <label key={i} className={`sf-branch${i === c.selected ? " sf-branch--active" : ""}`}>
          <input
            type="radio"
            name={name}
            checked={i === c.selected}
            disabled={disabled}
            onChange={() => {
              engine.select(path, i);
              // Start the new branch from its defaults; old values are dropped.
              form.setFieldValue(path, engine.defaults(node, path, undefined));
            }}
          />
          <span>{title}</span>
        </label>
      ))}
    </div>
  );
}

function ArrayNode({ resolved, path, label, options }: { resolved: Resolved; path: string; label: string; options: Options }) {
  const { form, engine } = useSchemaForm();
  const { disabled } = useBase();
  const items = resolved.schema.items;
  const s = resolved.schema;
  return (
    <form.Field name={path} mode="array">
      {(field: any) => {
        const list: unknown[] = Array.isArray(field.state.value) ? field.state.value : [];
        const errors: string[] = field.state.meta.errors ?? [];
        const canAdd = !disabled && (s.maxItems === undefined || list.length < s.maxItems);
        return (
          <fieldset className={`sf-array${errors.length ? " sf-field--invalid" : ""}`} id={idFor(path)}>
            <legend>{label}</legend>
            {list.length === 0 && <p className="sf-status">None added yet.</p>}
            {list.map((_, i) => {
              const itemPath = joinPath(path, i);
              return (
                <div className="sf-array-item" key={i}>
                  <div className="sf-array-item-head">
                    <span>
                      {label} {i + 1}
                    </span>
                    <button type="button" className="sf-link" disabled={disabled} onClick={() => field.removeValue(i)}>
                      Remove
                    </button>
                  </div>
                  <BaseProvider base={itemPath}>
                    {options.detail ? (
                      <UIElementView el={options.detail} />
                    ) : (
                      <SchemaNode schema={items} path={itemPath} label={`${label} ${i + 1}`} />
                    )}
                  </BaseProvider>
                </div>
              );
            })}
            <button
              type="button"
              className="sf-button sf-button--secondary"
              disabled={!canAdd}
              onClick={() => field.pushValue(engine.defaults(items, joinPath(path, list.length), undefined))}
            >
              Add {label.toLowerCase().replace(/s$/, "")}
            </button>
            {errors.length > 0 && <p className="sf-error" role="alert">{errors[0]}</p>}
          </fieldset>
        );
      }}
    </form.Field>
  );
}

// ================================================================= leaf fields

function FieldNode({
  schema,
  nullable,
  path,
  label,
  options,
  required,
}: {
  schema: Schema;
  nullable: boolean;
  path: string;
  label: string;
  options: Options;
  required: boolean;
}) {
  const { form, engine, renderers } = useSchemaForm();
  const { disabled } = useBase();
  const choiceSchema: Schema = typeOf(schema) === "array" ? schema.items : schema;
  const choicesState = useFormSelector((s) => engine.readOptions(choiceSchema, path, s.values));
  const Component = pickRenderer(renderers, schema, options);

  let choices: Option[] | undefined;
  if (choicesState) choices = choicesState.status === "success" ? choicesState.data : [];
  else if (Array.isArray(choiceSchema.enum)) {
    const labels: string[] | undefined = choiceSchema["x-enumLabels"];
    choices = choiceSchema.enum.map((v: any, i: number) => ({ value: v, label: labels?.[i] ?? humanize(String(v)) }));
  }

  return (
    <form.Field name={path}>
      {(field: any) => (
        <FieldEffects field={field} schema={schema} choices={choices} choicesState={choicesState}>
          <Component
            id={idFor(path)}
            path={path}
            schema={schema}
            label={label}
            description={schema.description}
            required={required}
            disabled={disabled || schema.readOnly === true}
            value={field.state.value}
            onChange={(v) => field.handleChange(v === undefined && nullable ? null : v)}
            onBlur={field.handleBlur}
            errors={field.state.meta.errors ?? NO_ERRORS}
            options={options}
            choices={choices}
            choicesState={choicesState}
          />
        </FieldEffects>
      )}
    </form.Field>
  );
}

/**
 * Keeps a field's value consistent with its schema as the form changes shape:
 * - applies `default` when a field appears (e.g. after switching branch or loading a fragment)
 * - clears a dependent value when its option list no longer contains it (country changed -> city cleared)
 */
function FieldEffects({
  field,
  schema,
  choices,
  choicesState,
  children,
}: {
  field: any;
  schema: Schema;
  choices?: Option[];
  choicesState?: ControlProps["choicesState"];
  children: ReactNode;
}) {
  const value = field.state.value;
  useEffect(() => {
    if (value === undefined && schema.default !== undefined) field.setValue(structuredClone(schema.default));
    // Only on mount / when the schema node changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  useEffect(() => {
    if (value === undefined || value === null || !choicesState) return;
    if (Array.isArray(value) && value.length === 0) return;
    const stale =
      choicesState.status === "idle" ||
      (choicesState.status === "success" &&
        (Array.isArray(value)
          ? value.some((v) => !choices!.some((c) => c.value === v))
          : !choices!.some((c) => c.value === value)));
    if (stale) field.setValue(Array.isArray(value) ? value.filter((v) => choices?.some((c) => c.value === v)) : undefined);
  }, [choicesState, choices, value, field]);

  return <>{children}</>;
}
