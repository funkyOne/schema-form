import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  isIncomplete,
  joinPath,
  parsePath,
  primaryType,
  resolveRelativePath,
  type ControlElement,
  type FormEngine,
  type Prefill,
  type Option,
  type Resolved,
  type Schema,
  type UIElement,
} from "../engine";
import { applyPatches, BaseProvider, forgetIndex, markManual, shallowArrayEqual, useBase, useFormSelector, useSchemaForm } from "./context";
import { ErrorText, humanize, isChoice, pickRenderer, type ControlProps } from "./controls";

type Options = NonNullable<ControlElement["options"]>;
const NO_OPTIONS: Options = {};
const NO_ERRORS: string[] = [];

const lastSegment = (path: string) => {
  const segs = parsePath(path);
  const last = segs[segs.length - 1];
  return typeof last === "string" ? last : "";
};
const idFor = (path: string) => "sf-" + (path || "root").replace(/[^a-zA-Z0-9_-]+/g, "-");

/** Errors set directly on a path (e.g. object/array-level errors like minItems). */
function usePathErrors(path: string): string[] {
  return useFormSelector(
    (s) => (s.fieldMeta?.[path]?.errors as string[] | undefined) ?? NO_ERRORS,
    shallowArrayEqual,
  );
}

// ================================================================= UI schema elements

/** Does this layout show at least one field that is part of the active schema? */
function hasActiveControl(engine: FormEngine, el: UIElement, base: string, values: unknown): boolean {
  if (el.type === "Control") return engine.schemaAt(resolveRelativePath(el.path, base), values) !== undefined;
  return el.elements.some((child) => hasActiveControl(engine, child, base, values));
}

/** Layout only: visibility and locking come from the schema (x-hidden / x-disabled). */
export function UIElementView({ el }: { el: UIElement }) {
  const { engine } = useSchemaForm();
  const { base } = useBase();
  // A group whose fields are all hidden or inactive disappears with them.
  const visible = useFormSelector((s) => el.type === "Control" || hasActiveControl(engine, el, base, s.values));
  if (!visible) return null;
  if (el.type === "Control") return <ControlView el={el} />;
  const children = el.elements.map((child, i) => <UIElementView key={i} el={child} />);
  if (el.type === "Group")
    return (
      <fieldset className="sf-group">
        {el.label && <legend>{el.label}</legend>}
        {children}
      </fieldset>
    );
  return <div className={el.type === "HorizontalLayout" ? "sf-row" : "sf-col"}>{children}</div>;
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
export function SchemaNode(props: NodeProps) {
  const { engine } = useSchemaForm();
  // Checks ancestors too, so a control placed anywhere in the layout honours x-disabled above it.
  const locked = useFormSelector((s) => engine.disabledAt(props.path, s.values));
  // Always wrapped, so toggling x-disabled doesn't remount the field (and lose focus or local state).
  return (
    <BaseProvider disabled={locked}>
      <ResolvedNode {...props} />
    </BaseProvider>
  );
}

function ResolvedNode({ schema, path, label, options = NO_OPTIONS, required = false }: NodeProps) {
  const { engine } = useSchemaForm();
  const resolved = useFormSelector((s) => engine.resolve(schema, path, s.values));
  const s = resolved.schema;
  const title = label ?? s.title ?? humanize(lastSegment(path));
  const type = primaryType(s);

  const switcher =
    resolved.combinator && !resolved.combinator.discriminator ? (
      <BranchSwitch path={path} resolved={resolved} label={title} />
    ) : null;

  if (type === "object" && !isChoice(s))
    return <ObjectNode resolved={resolved} path={path} label={title} options={options} switcher={switcher} />;

  // An array of choices (multi-select) is a single field; any other array is a list of items.
  const items = type === "array" && s.items !== undefined ? engine.resolve(s.items, joinPath(path, 0), undefined).schema : undefined;
  if (items && !isChoice(items)) return <ArrayNode resolved={resolved} path={path} label={title} options={options} />;

  return (
    <>
      {switcher}
      <FieldNode
        schema={items ? { ...s, items } : s}
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
      <ErrorText errors={errors} />
    </fieldset>
  );
}

/** Picker for oneOf/anyOf branches that have no discriminator property. */
function BranchSwitch({ path, resolved, label }: { path: string; resolved: Resolved; label: string }) {
  const { engine } = useSchemaForm();
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
            // The old branch's values are cleared as stale; the new one's fields apply their defaults.
            onChange={() => engine.select(path, i)}
          />
          <span>{title}</span>
        </label>
      ))}
    </div>
  );
}

function ArrayNode({ resolved, path, label, options }: { resolved: Resolved; path: string; label: string; options: Options }) {
  const { form, engine, provenance } = useSchemaForm();
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
                    <button
                      type="button"
                      className="sf-link"
                      disabled={disabled}
                      onClick={() => {
                        field.removeValue(i);
                        forgetIndex(provenance, path, i);
                      }}
                    >
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
            <ErrorText errors={errors} />
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
  const { form, engine, renderers, provenance } = useSchemaForm();
  const { disabled } = useBase();
  const choiceSchema: Schema = primaryType(schema) === "array" ? schema.items : schema;
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
        <>
          <FieldEffects field={field} schema={schema} choices={choices} choicesState={choicesState} />
          <Component
            id={idFor(path)}
            path={path}
            schema={schema}
            label={label}
            description={schema.description}
            required={required}
            disabled={disabled || schema.readOnly === true}
            value={field.state.value}
            onChange={(v) => {
              // Mark first: the store subscriber runs computes synchronously on the change.
              markManual(provenance, path);
              field.handleChange(v === undefined && nullable ? null : v);
            }}
            onBlur={field.handleBlur}
            errors={field.state.meta.errors ?? NO_ERRORS}
            options={options}
            choices={choices}
            choicesState={choicesState}
          />
          {schema["x-prefill"] && <PrefillView prefill={schema["x-prefill"]} path={path} disabled={disabled} />}
        </>
      )}
    </form.Field>
  );
}

/**
 * Runs a field's `x-prefill`: from a button, or automatically whenever its params change.
 * Only the latest run writes, so a slow response for an old value never lands.
 */
function PrefillView({ prefill, path, disabled }: { prefill: Prefill; path: string; disabled: boolean }) {
  const { engine, form, provenance } = useSchemaForm();
  // The current params as a key, or "" while one is still empty.
  const key = useFormSelector((s) => {
    const params = engine.params(prefill, s.values, path);
    return isIncomplete(params) ? "" : JSON.stringify(params);
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);
  const run = async () => {
    const id = ++latest.current;
    setBusy(true);
    setFailed(false);
    try {
      const patches = await engine.prefill(prefill, form.state.values, path, provenance.state);
      if (id === latest.current) applyPatches({ form, provenance }, patches);
    } catch {
      if (id === latest.current) setFailed(true);
    }
    if (id === latest.current) setBusy(false);
  };

  const auto = prefill.trigger === "change";
  useEffect(() => {
    if (auto && key && !disabled) void run();
    // Re-run only when the params change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, key, disabled]);

  const error = failed && <ErrorText errors={["Couldn't look that up. Check the value and try again."]} />;
  if (auto)
    return busy || failed ? (
      <div className="sf-lookup">
        {busy && <p className="sf-status" role="status">Looking up…</p>}
        {error}
      </div>
    ) : null;
  return (
    <div className="sf-lookup">
      <button
        type="button"
        className="sf-button sf-button--secondary"
        disabled={disabled || !key || busy}
        aria-busy={busy || undefined}
        onClick={run}
      >
        {busy ? "Looking up…" : (prefill.label ?? "Look up")}
      </button>
      {error}
    </div>
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
}: {
  field: any;
  schema: Schema;
  choices?: Option[];
  choicesState?: ControlProps["choicesState"];
}) {
  const value = field.state.value;
  useEffect(() => {
    if (value === undefined && schema.default !== undefined) field.setValue(structuredClone(schema.default));
    // Only on mount / when the schema node changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema]);

  const strict = schema["x-options"]?.strict !== false;
  useEffect(() => {
    if (value === undefined || value === null || !choicesState || !strict) return;
    if (Array.isArray(value) && value.length === 0) return;
    const stale =
      choicesState.status === "idle" ||
      (choicesState.status === "success" &&
        (Array.isArray(value)
          ? value.some((v) => !choices!.some((c) => c.value === v))
          : !choices!.some((c) => c.value === value)));
    if (stale) field.setValue(Array.isArray(value) ? value.filter((v) => choices?.some((c) => c.value === v)) : undefined);
  }, [choicesState, choices, value, field, strict]);

  return null;
}
