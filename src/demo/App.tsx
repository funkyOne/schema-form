import { useCallback, useMemo, useState } from "react";
import type { FormSnapshot } from "../engine";
import { SchemaForm } from "../react";
import { createLoaders, schema, uischema } from "./schema";

/** The form is backed up to localStorage on every change and resumed from it on load. */
const BACKUP_KEY = "schema-form-demo";
const readBackup = (): FormSnapshot | undefined => {
  try {
    const raw = localStorage.getItem(BACKUP_KEY);
    return raw ? (JSON.parse(raw) as FormSnapshot) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Usage example. Everything form-specific lives in ./schema.ts:
 * the JSON Schema, the UI schema (layout only) and the loaders (your API).
 * This component only wires them into <SchemaForm> and shows what comes out.
 */
type Tab = "values" | "submitted" | "api" | "schema";

export function App() {
  const [snapshot, setSnapshot] = useState<FormSnapshot>({ values: {} });
  const [submitted, setSubmitted] = useState<unknown>(null);
  const [initialState] = useState(readBackup);
  const [formKey, setFormKey] = useState(0);
  const [calls, setCalls] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("values");

  // Loaders must be stable: a new object would rebuild the engine.
  const loaders = useMemo(
    () => createLoaders(450, (msg) => setCalls((c) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...c].slice(0, 40))),
    [],
  );

  // Everything needed to resume: values, who filled what, and branch picks.
  const onStateChange = useCallback((s: FormSnapshot) => {
    setSnapshot(s);
    try {
      localStorage.setItem(BACKUP_KEY, JSON.stringify(s));
    } catch {
      /* private mode, quota: the backup is best-effort */
    }
  }, []);
  const startOver = () => {
    localStorage.removeItem(BACKUP_KEY);
    setFormKey((k) => k + 1);
  };

  // Receives validated data with hidden fields and inactive branches already removed.
  const onSubmit = useCallback(async (data: unknown) => {
    await new Promise((r) => setTimeout(r, 300));
    setSubmitted(data);
    setTab("submitted");
  }, []);

  const panel =
    tab === "values"
      ? snapshot
      : tab === "submitted"
        ? (submitted ?? "Submit the form to see the cleaned payload.")
        : tab === "schema"
          ? { schema, uischema }
          : null;

  return (
    <div className="demo">
      <header className="demo-head">
        <p className="demo-eyebrow">JSON Schema + TanStack Form</p>
        <h1>Insurance quote</h1>
        <p className="demo-lede">
          One JSON Schema and a small UI schema drive this whole form. Switch applicant type, pick a country, choose a
          product, add a claim: fields appear, hide, disable and load their options from a (simulated) API.
        </p>
      </header>

      <div className="demo-grid">
        <main className="demo-form">
          <SchemaForm
            key={formKey}
            schema={schema}
            uischema={uischema}
            loaders={loaders}
            initialState={formKey === 0 ? initialState : undefined}
            onSubmit={onSubmit}
            onStateChange={onStateChange}
            submitLabel="Get quote"
          />
          <p className="demo-note">
            Your progress is backed up in this browser.{" "}
            <button type="button" className="sf-link" onClick={startOver}>
              Start over
            </button>
          </p>
        </main>

        <aside className="demo-side" aria-label="Inspector">
          <div className="demo-tabs" role="tablist">
            {(
              [
                ["values", "Form state"],
                ["submitted", "Submitted"],
                ["api", `API calls (${calls.length})`],
                ["schema", "Schema"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                id={`tab-${id}`}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "is-active" : ""}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="demo-note">
            {tab === "values" &&
              "The snapshot saved as a draft: values, provenance (who filled each field) and branch picks. Values of fields that disappear are cleared right away."}
            {tab === "submitted" && "What onSubmit receives: hidden fields and inactive branches removed, then validated."}
            {tab === "api" && "Requests made by x-options and x-extend. Each result is cached by its parameters."}
            {tab === "schema" && "The JSON Schema and UI schema behind this form."}
          </p>
          <pre className="demo-pre">
            {tab === "api" ? (calls.length ? calls.join("\n") : "No requests yet.") : JSON.stringify(panel, null, 2)}
          </pre>
        </aside>
      </div>
    </div>
  );
}
