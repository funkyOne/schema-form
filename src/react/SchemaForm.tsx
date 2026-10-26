import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { FormEngine, type Loaders, type Schema, type UIElement } from "../engine";
import { FormProvider, useFormSelector, useSchemaForm, type SchemaFormApi } from "./context";
import { defaultRenderers, type RendererEntry } from "./controls";
import { SchemaNode, UIElementView } from "./nodes";

export interface SchemaFormProps<TData = unknown> {
  schema: Schema;
  /** Layout + rules. Without it, every active property is rendered in schema order. */
  uischema?: UIElement;
  /** API loaders for x-options / x-extend. Keep this object stable (module scope or useMemo). */
  loaders?: Loaders;
  /** Extra or replacement renderers; same `name` replaces a default. */
  renderers?: RendererEntry[];
  initialValues?: Record<string, unknown>;
  /** Called with validated data: inactive branches and hidden fields already removed. */
  onSubmit: (data: TData) => void | Promise<void>;
  /** Raw form values on every change (including hidden/inactive values). */
  onValuesChange?: (values: unknown) => void;
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
  const { schema, uischema, loaders } = props;
  const engine = useMemo(
    () => props.engine ?? new FormEngine({ schema, uischema, loaders }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.engine, schema, uischema, loaders],
  );
  const renderers = useMemo(() => {
    const custom = props.renderers ?? [];
    return [...custom, ...defaultRenderers.filter((d) => !custom.some((c) => c.name === d.name))];
  }, [props.renderers]);

  const onSubmitRef = useRef(props.onSubmit);
  onSubmitRef.current = props.onSubmit;
  const domRef = useRef<HTMLFormElement>(null);

  const form = useForm({
    defaultValues: useMemo(
      () => mergeDefaults(engine.defaults(), props.initialValues) as Record<string, unknown>,
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [engine],
    ),
    // Validate on submit, then on every change once the user has tried to submit.
    validationLogic: revalidateLogic(),
    validators: {
      onDynamic: ({ value }) => {
        const r = engine.validate(value);
        return r.valid ? undefined : { form: r.form, fields: r.fields };
      },
    },
    onSubmit: async ({ value }) => {
      await onSubmitRef.current(engine.validate(value).data as TData);
    },
    onSubmitInvalid: () => {
      // Wait a frame so error states are rendered, then focus the first invalid control.
      requestAnimationFrame(() =>
        domRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], .sf-field--invalid input')?.focus(),
      );
    },
  });

  // When async data lands (options, schema fragments) after a submit attempt, re-validate so
  // "still loading" errors clear and newly loaded fields are checked.
  useEffect(() => {
    const sub = engine.notifier.subscribe(() => {
      if (form.state.submissionAttempts > 0) void form.validate("change");
    });
    return () => void sub.unsubscribe();
  }, [engine, form]);

  const ctx = useMemo(() => ({ form, engine, renderers }), [form, engine, renderers]);

  return (
    <FormProvider value={ctx}>
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
        <ValuesListener onChange={props.onValuesChange} />
        <FormFooter label={props.submitLabel ?? "Submit"} renderActions={props.renderActions} />
      </form>
    </FormProvider>
  );
}

function ValuesListener({ onChange }: { onChange?: (values: unknown) => void }) {
  const values = useFormSelector((s) => s.values);
  useEffect(() => onChange?.(values), [values, onChange]);
  return null;
}

function FormFooter({ label, renderActions }: { label: string; renderActions?: (form: SchemaFormApi) => ReactNode }) {
  const formError = useFormSelector((s) => s.errorMap?.onDynamic as string | undefined);
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

