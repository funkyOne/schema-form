import { revalidateLogic, useForm } from "@tanstack/react-form";
import type { QueryClient } from "@tanstack/query-core";
import { Store } from "@tanstack/store";
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
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
import { applyPatches, forgetPath, FormContext, useFormSelector, useSchemaForm, type SchemaFormApi } from "./context";
import { defaultRenderers, type RendererEntry } from "./controls";
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
}

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
      onDynamic: ({ value }) => {
        const r = engine.validate(value);
        return r.valid ? undefined : { form: r.form, fields: r.fields };
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
    const sync = () => {
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
    const b = engine.notifier.subscribe(() => {
      sync();
      if (form.state.submissionAttempts > 0) void form.validate("change");
    });
    return () => {
      a.unsubscribe();
      b.unsubscribe();
    };
  }, [engine, form, provenance]);

  const ctx = useMemo(() => ({ form, engine, renderers, provenance }), [form, engine, renderers, provenance]);

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

const shallowRecordEqual = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

function FormFooter({ label, renderActions }: { label: string; renderActions?: (form: SchemaFormApi) => ReactNode }) {
  const formError = useFormSelector((s) => (s.errorMap?.onDynamic ?? s.errorMap?.onServer) as string | undefined);
  const errorCount = useFormSelector(
    (s) => Object.values(s.fieldMeta ?? {}).filter((m: any) => m?.errors?.length).length,
  );
  const submitting = useFormSelector((s) => s.isSubmitting as boolean);
  const attempted = useFormSelector((s) => (s.submissionAttempts as number) > 0);
  const { form } = useSchemaForm();

  return (
    <div className="sf-footer">
      {attempted && (formError || errorCount > 0) && (
        <p className="sf-error sf-summary" role="alert">
          {formError ?? `Please fix ${errorCount} ${errorCount === 1 ? "field" : "fields"} above.`}
        </p>
      )}
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

