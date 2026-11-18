import { revalidateLogic, useForm } from "@tanstack/react-form";
import type { QueryClient } from "@tanstack/query-core";
import { Store } from "@tanstack/store";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import {
  FormEngine,
  noProvenance,
  pruneProvenance,
  type FormErrors,
  type FormSnapshot,
  type Loaders,
  type Provenance,
  type Schema,
  type UIElement,
} from "../engine";
import {
  applyPatches,
  forgetPath,
  FormContext,
  flattenExternal,
  shallowRecordEqual,
  useFormErrors,
  useFormSelector,
  useSchemaForm,
  type ExternalErrors,
  type SchemaFormApi,
} from "./context";
import { defaultRenderers, type LayoutProps, type RendererEntry } from "./controls";
import { SchemaNode, UIElementView } from "./nodes";

export interface SchemaFormProps<TData = unknown> {
  schema: Schema;
  /** Layout only. Without it, every active property is rendered in schema order. */
  uischema?: UIElement;
  /** API loaders for x-options / x-extend. Keep this object stable (module scope or useMemo). */
  loaders?: Loaders;
  /** Cache for loader results. Pass your app's client to share results between forms. */
  queryClient?: QueryClient;
  /** Extra or replacement renderers; same `name` replaces a default. */
  renderers?: RendererEntry[];
  initialValues?: Record<string, unknown>;
  /** Resume a draft or backup saved from `onStateChange`. Its values win over `initialValues`. */
  initialState?: FormSnapshot;
  /**
   * Called with validated data: inactive branches and hidden fields already removed.
   * Return `{ fields, form }` to show errors the server found; they clear as the user edits.
   */
  onSubmit: (data: TData) => void | FormErrors | Promise<void | FormErrors>;
  /** Form values on every change. Values of fields that disappear are cleared right away. */
  onValuesChange?: (values: unknown) => void;
  /** Everything needed to resume the form, on every change. Save it as a draft or browser backup. */
  onStateChange?: (snapshot: FormSnapshot) => void;
  submitLabel?: string;
  /** Replace the default submit button. */
  renderActions?: (form: SchemaFormApi) => ReactNode;
  /** Pass a pre-built engine to share it with server-side or test code. */
  engine?: FormEngine;
  /**
   * Errors from checks the host runs itself (a remote validation when the user reaches Review),
   * by check name: `{ amc: { fields: { "classification.foRiskSystem": "…" } } }`.
   * Shown inline right away and kept until you replace or remove that check's entry;
   * while any are present, submit is blocked.
   */
  externalErrors?: ExternalErrors;
  /** Custom UI schema layout types (a stepper, tabs) by `type` name. Display only. */
  layouts?: Record<string, ComponentType<LayoutProps>>;
}

const NO_LAYOUTS: Record<string, ComponentType<LayoutProps>> = {};
const NO_EXTERNAL: ExternalErrors = {};

function mergeDefaults(defaults: unknown, initial: unknown): unknown {
  if (initial === undefined) return defaults;
  if (defaults && initial && typeof defaults === "object" && typeof initial === "object" && !Array.isArray(initial)) {
    const out: Record<string, unknown> = { ...(defaults as object) };
    for (const [k, v] of Object.entries(initial)) out[k] = mergeDefaults(out[k], v);
    return out;
  }
  return initial;
}

export function SchemaForm<TData = unknown>(props: SchemaFormProps<TData>) {
  const { schema, uischema, loaders, queryClient, initialState } = props;
  const engine = useMemo(
    () => {
      const e = props.engine ?? new FormEngine({ schema, loaders, queryClient });
      if (initialState?.selections) e.restoreSelections(initialState.selections);
      return e;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.engine, schema, loaders, queryClient],
  );
  const renderers = useMemo(() => {
    const custom = props.renderers ?? [];
    return [...custom, ...defaultRenderers.filter((d) => !custom.some((c) => c.name === d.name))];
  }, [props.renderers]);

  const external = useMemo(() => new Store<ExternalErrors>(props.externalErrors ?? NO_EXTERNAL), []);
  useLayoutEffect(() => {
    external.setState(() => props.externalErrors ?? NO_EXTERNAL);
  }, [external, props.externalErrors]);

  const onSubmitRef = useRef(props.onSubmit);
  onSubmitRef.current = props.onSubmit;
  const domRef = useRef<HTMLFormElement>(null);

  const defaultValues = useMemo(
    () => mergeDefaults(engine.defaults(), initialState?.values ?? props.initialValues) as Record<string, unknown>,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine],
  );
  const provenance = useMemo(
    () => new Store<Provenance>(pruneProvenance(initialState?.provenance ?? noProvenance(), defaultValues)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine],
  );

  const form = useForm({
    defaultValues,
    // Validate on submit, then on every change once the user has tried to submit.
    validationLogic: revalidateLogic(),
    validators: {
      // Errors from host-run checks count like any other: they make the form invalid until cleared.
      onDynamic: ({ value }) => {
        const r = engine.validate(value);
        const ext = flattenExternal(external.state);
        if (r.valid && !ext.form && !Object.keys(ext.fields).length) return undefined;
        return { form: ext.form ?? r.form, fields: { ...r.fields, ...ext.fields } };
      },
    },
    onSubmit: async ({ value, formApi }) => {
      const result = await onSubmitRef.current(engine.validate(value).data as TData);
      if (result && (result.form || Object.keys(result.fields ?? {}).length)) {
        // Server errors live under TanStack's `onServer` key and clear on the next validation of that field.
        formApi.setErrorMap({ onServer: { form: result.form, fields: result.fields ?? {} } } as any);
        focusFirstInvalid();
      }
    },
    onSubmitInvalid: focusFirstInvalid,
  });

  // Wait a frame so error states are rendered, then focus the first invalid control.
  function focusFirstInvalid() {
    requestAnimationFrame(() =>
      domRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], .sf-field--invalid input')?.focus(),
    );
  }

  useEffect(() => {
    const ctx = { form, provenance };
    // Keep the values consistent with the schema after every change:
    // 1. write computed fields (settled, so chains land in one batch)
    // 2. clear values whose field disappeared (inactive branch, unmet `if`, x-hidden or x-disabled)
    // Skipped when neither the values nor the loaded data changed (blur, meta and submit-state updates).
    let last: { values: unknown; version: number } | undefined;
    const sync = () => {
      const version = engine.notifier.get();
      if (last && last.values === form.state.values && last.version === version) return;
      last = { values: form.state.values, version };
      applyPatches(ctx, engine.applyComputed(form.state.values, provenance.state).patches);
      for (const path of engine.staleValues(form.state.values)) {
        form.setFieldValue(path, undefined, { dontUpdateMeta: true });
        forgetPath(provenance, path);
      }
    };
    sync();
    const a = form.store.subscribe(sync);
    // When async data lands (options, schema fragments) after a submit attempt, re-validate so
    // "still loading" errors clear and newly loaded fields are checked.
    const revalidate = () => {
      if (form.state.submissionAttempts > 0) void form.validate("change");
    };
    const b = engine.notifier.subscribe(() => {
      sync();
      revalidate();
    });
    // New or cleared external errors after a submit attempt update the form's validity too.
    const c = external.subscribe(revalidate);
    return () => {
      a.unsubscribe();
      b.unsubscribe();
      c.unsubscribe();
    };
  }, [engine, form, provenance, external]);

  const layouts = props.layouts ?? NO_LAYOUTS;
  const ctx = useMemo(
    () => ({
      form,
      engine,
      renderers,
      provenance,
      external,
      layouts,
      validateLocal: () => engine.validate(form.state.values),
    }),
    [form, engine, renderers, provenance, external, layouts],
  );

  return (
    <FormContext.Provider value={ctx}>
      <form
        ref={domRef}
        className="sf-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        {uischema ? <UIElementView el={uischema} /> : <SchemaNode schema={engine.root} path="" />}
        <StateListener onValuesChange={props.onValuesChange} onStateChange={props.onStateChange} />
        <FormFooter label={props.submitLabel ?? "Submit"} renderActions={props.renderActions} />
      </form>
    </FormContext.Provider>
  );
}

function StateListener({
  onValuesChange,
  onStateChange,
}: {
  onValuesChange?: (values: unknown) => void;
  onStateChange?: (snapshot: FormSnapshot) => void;
}) {
  const { engine, provenance } = useSchemaForm();
  // Re-runs when values change, when a branch is picked (notifier) and when provenance changes.
  const values = useFormSelector((s) => s.values);
  const selections = useFormSelector(() => engine.getSelections(), shallowRecordEqual);
  const prov = useSyncExternalStore(
    (fn) => provenance.subscribe(fn).unsubscribe,
    () => provenance.state,
  );
  useEffect(() => onValuesChange?.(values), [values, onValuesChange]);
  useEffect(() => {
    onStateChange?.({ values, provenance: prov, selections });
  }, [values, prov, selections, onStateChange]);
  return null;
}

function FormFooter({ label, renderActions }: { label: string; renderActions?: (form: SchemaFormApi) => ReactNode }) {
  const submitting = useFormSelector((s) => s.isSubmitting as boolean);
  const attempted = useFormSelector((s) => (s.submissionAttempts as number) > 0);
  const { form } = useSchemaForm();

  return (
    <div className="sf-footer">
      {attempted && <ErrorSummary />}
      {renderActions ? (
        renderActions(form)
      ) : (
        <button type="submit" className="sf-button" disabled={submitting}>
          {submitting ? "Submitting…" : label}
        </button>
      )}
    </div>
  );
}

/** Shown after a submit attempt only, so the merged error stream isn't built before then. */
function ErrorSummary() {
  const errors = useFormErrors();
  const formError = errors[""];
  const count = Object.keys(errors).filter(Boolean).length;
  if (!formError && !count) return null;
  return (
    <p className="sf-error sf-summary" role="alert">
      {formError ?? `Please fix ${count} ${count === 1 ? "field" : "fields"} above.`}
    </p>
  );
}

