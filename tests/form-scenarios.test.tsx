import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FormErrors, Loaders, Schema, UIElement, ValidationResult } from "../src/engine";
import {
  errorsWithin,
  SchemaForm,
  useFormErrors,
  useSchemaForm,
  type ControlProps,
  type LayoutProps,
  type RendererEntry,
} from "../src/react";

/**
 * The client's acceptance scenarios for USE-CASES 18–21, step by step.
 * The stepper and the table below stand in for the client's own UI components.
 */

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------- 18. Cross-field validation

describe("18. cross-field validation", () => {
  const MSG = "Account Description cannot be the same as Account Mnemonic";
  const schema: Schema = {
    type: "object",
    properties: {
      mnemonic: { type: "string", title: "Account Mnemonic" },
      description: {
        type: "string",
        title: "Account Description",
        "x-validate": [{ logic: { "!=": [{ var: "$self" }, { var: "$parent.mnemonic" }] }, message: MSG }],
      },
    },
  };

  it("shows the error as the user types, clears it when the mnemonic changes, and blocks submit", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SchemaForm schema={schema} initialValues={{ mnemonic: "GOCTEST2" }} onSubmit={onSubmit} />);
    const description = screen.getByLabelText("Account Description");

    await user.type(description, "GOCTEST2");
    expect(screen.getByText(MSG)).toBeInTheDocument();
    expect(description).toHaveAttribute("aria-invalid", "true");

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText("Account Mnemonic"));
    await user.type(screen.getByLabelText("Account Mnemonic"), "GOCTEST3");
    expect(screen.queryByText(MSG)).not.toBeInTheDocument();
    expect(description).toHaveValue("GOCTEST2");

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ mnemonic: "GOCTEST3", description: "GOCTEST2" });
  });
});

// ---------------------------------------------------------------- shared test stepper (21, 19B)

/**
 * A minimal stepper like the client's: one step per section plus Review. Steps never gate
 * anything; badges show once Review has been visited, and Review lists steps with errors.
 */
function TestStepper({ sections, onReview }: LayoutProps & { onReview?: (local: ValidationResult & { data: unknown }) => void }) {
  const { validateLocal } = useSchemaForm();
  const errors = useFormErrors({ all: true });
  const [current, setCurrent] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const review = sections.length;
  const hasErrors = (i: number) => Object.keys(errorsWithin(errors, sections[i]!.fields)).length > 0;
  const go = (i: number) => {
    setCurrent(i);
    if (i === review) {
      setReviewed(true);
      onReview?.(validateLocal());
    }
  };
  return (
    <div>
      <nav aria-label="Steps">
        {sections.map((s, i) => (
          <button type="button" key={s.label} onClick={() => go(i)}>
            {s.label}
            {reviewed && hasErrors(i) && <span className="badge"> (has errors)</span>}
          </button>
        ))}
        <button type="button" onClick={() => go(review)}>
          Review
        </button>
      </nav>
      {current < review ? (
        <section aria-label={sections[current]?.label}>{sections[current]?.render()}</section>
      ) : (
        <section aria-label="Review">
          <ul>
            {sections.map((s, i) =>
              hasErrors(i) ? (
                <li key={s.label}>
                  <button type="button" onClick={() => go(i)}>
                    {s.label}
                  </button>
                </li>
              ) : null,
            )}
          </ul>
        </section>
      )}
    </div>
  );
}

const requestSchema: Schema = {
  type: "object",
  properties: {
    accountName: { type: "string", title: "Account Name" },
    mnemonic: { type: "string", title: "Account Mnemonic" },
    assetClass: { type: "string", title: "Asset Class", enum: ["Equities", "Fixed Income"] },
    foRiskSystem: { type: "string", title: "Primary Front Office Risk System" },
    equityType: {
      type: "string",
      title: "Equity Type",
      "x-hidden": { logic: { "!=": [{ var: "assetClass" }, "Equities"] } },
    },
    affirmations: {
      type: "array",
      title: "Downstream systems",
      items: { type: "string" },
      "x-hidden": { source: "downstream", select: "selectable", logic: { "!": { var: "$data.length" } } },
    },
  },
  required: ["accountName", "mnemonic", "assetClass", "foRiskSystem"],
};

const steps: UIElement = {
  type: "Stepper",
  elements: [
    { type: "Group", label: "Firm Account Details", elements: [{ type: "Control", path: "accountName" }, { type: "Control", path: "mnemonic" }] },
    { type: "Group", label: "Classification", elements: [{ type: "Control", path: "assetClass" }, { type: "Control", path: "foRiskSystem" }] },
    { type: "Group", label: "Equities", elements: [{ type: "Control", path: "equityType" }] },
    { type: "Group", label: "Downstream Systems", elements: [{ type: "Control", path: "affirmations" }] },
  ],
};

const noDownstream: Loaders = { downstream: async () => ({ selectable: [], automated: [] }) };

const stepButton = (name: string) =>
  within(screen.getByRole("navigation", { name: "Steps" })).getByRole("button", { name: new RegExp(`^${name}`) });

// ---------------------------------------------------------------- 19. Remote checks

describe("19A. invalid GOC from a search", () => {
  const MSG = "Invalid GOC. Please enter a valid GOC";
  const loaders: Loaders = {
    gocSearch: async ({ q }) => (q === "GOC123" ? [{ code: "GOC123" }] : []),
    gocDetails: async ({ code }) => (code === "GOC123" ? { region: "EMEA", desk: "Rates" } : {}),
  };
  const schema: Schema = {
    type: "object",
    properties: {
      goc: {
        type: "string",
        title: "GOC",
        "x-validate": [{ source: "gocSearch", params: { q: { var: "$self" } }, logic: { "!!": { var: "$data.length" } }, message: MSG }],
        "x-prefill": { source: "gocDetails", params: { code: { var: "$self" } }, trigger: "change", fill: { region: "region", desk: "desk" } },
      },
      region: { type: "string", title: "Region", readOnly: true },
      desk: { type: "string", title: "Desk", readOnly: true },
    },
  };

  it("marks a GOC with no search results right away, and clears it when a valid GOC is picked", async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={schema} loaders={loaders} onSubmit={vi.fn()} />);
    const goc = screen.getByLabelText("GOC");

    await user.type(goc, "BADGOC");
    expect(await screen.findByText(MSG)).toBeInTheDocument();

    // A typeahead pick sets the whole value at once.
    await user.clear(goc);
    await user.click(goc);
    await user.paste("GOC123");
    await waitFor(() => expect(screen.getByLabelText("Region")).toHaveValue("EMEA"));
    expect(screen.getByLabelText("Desk")).toHaveValue("Rates");
    expect(screen.queryByText(MSG)).not.toBeInTheDocument();
  });
});

describe("19B. AMC errors on Review", () => {
  const AMC_MSG = "FO risk system is not valid for this account";

  function Host({ amc, onSubmit }: { amc: (data: any) => Promise<FormErrors | undefined>; onSubmit: () => void }) {
    const [amcErrors, setAmcErrors] = useState<FormErrors>();
    const layouts = useMemo(
      () => ({
        Stepper: (p: LayoutProps) => (
          <TestStepper
            {...p}
            onReview={async (local) => {
              if (!local.valid) return setAmcErrors(undefined);
              const result = await amc(local.data);
              // Map AMC's entity names to field paths (the host's job).
              setAmcErrors(result);
            }}
          />
        ),
      }),
      [amc],
    );
    return (
      <SchemaForm
        schema={requestSchema}
        uischema={steps}
        layouts={layouts}
        loaders={noDownstream}
        externalErrors={amcErrors ? { amc: amcErrors } : undefined}
        initialValues={{ accountName: "Acme", mnemonic: "ACME1", assetClass: "Fixed Income", foRiskSystem: "BAD" }}
        onSubmit={onSubmit}
      />
    );
  }

  it("calls AMC once per Review visit, shows its errors inline until it runs again, and skips it on local errors", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const amc = vi.fn(async (data: any) =>
      data.foRiskSystem === "BAD" ? { fields: { foRiskSystem: AMC_MSG } } : undefined,
    );
    render(<Host amc={amc} onSubmit={onSubmit} />);
    await flush();

    await user.click(stepButton("Review"));
    await waitFor(() => expect(amc).toHaveBeenCalledTimes(1));
    expect(within(screen.getByRole("region", { name: "Review" })).getByRole("button", { name: "Classification" })).toBeInTheDocument();

    await user.click(stepButton("Classification"));
    const fo = screen.getByLabelText(/Primary Front Office Risk System/);
    expect(screen.getByText(AMC_MSG)).toBeInTheDocument();

    // Blocked while AMC errors are present.
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).not.toHaveBeenCalled();

    // Fixing the field doesn't clear AMC's error; the next run does.
    await user.clear(fo);
    await user.type(fo, "GOOD");
    expect(screen.getByText(AMC_MSG)).toBeInTheDocument();
    await user.click(stepButton("Review"));
    await waitFor(() => expect(amc).toHaveBeenCalledTimes(2));
    await user.click(stepButton("Classification"));
    expect(screen.queryByText(AMC_MSG)).not.toBeInTheDocument();

    // Bring the AMC error back, then add a local error: AMC isn't called and its errors go.
    await user.clear(screen.getByLabelText(/Primary Front Office Risk System/));
    await user.type(screen.getByLabelText(/Primary Front Office Risk System/), "BAD");
    await user.click(stepButton("Review"));
    await waitFor(() => expect(amc).toHaveBeenCalledTimes(3));
    await user.click(stepButton("Firm Account Details"));
    await user.clear(screen.getByLabelText(/Account Name/));
    await user.click(stepButton("Review"));
    await user.click(stepButton("Classification"));
    expect(amc).toHaveBeenCalledTimes(3);
    expect(screen.queryByText(AMC_MSG)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- 20. Custom control for an array of objects

type Row = { systemName: string; csiId: string; emailDl: string };

function DownstreamTable({ value, onChange, data, label }: ControlProps) {
  const list = (Array.isArray(value) ? value : []) as { systemName: string; csiId: string }[];
  const rows = (data.selectable?.status === "success" ? data.selectable.data : []) as Row[];
  const automated = (data.automated?.status === "success" ? data.automated.data : []) as Row[];
  const picked = (r: Row) => list.some((v) => v.csiId === r.csiId);
  const toggle = (row: Row, on: boolean) => {
    // Rows in service order, then entries the service doesn't list (e.g. from an older draft).
    const others = list.filter((v) => !rows.some((r) => r.csiId === v.csiId));
    const next = rows.filter((r) => (r === row ? on : picked(r))).map(({ systemName, csiId }) => ({ systemName, csiId }));
    onChange([...next, ...others]);
  };
  const table = (name: string, items: Row[], selectable: boolean) => (
    <table aria-label={name}>
      <tbody>
        {items.map((r) => (
          <tr key={r.csiId}>
            {selectable && (
              <td>
                <input type="checkbox" aria-label={r.systemName} checked={picked(r)} onChange={(e) => toggle(r, e.target.checked)} />
              </td>
            )}
            <td>{r.csiId}</td>
            <td>{r.systemName}</td>
            <td>{r.emailDl}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <fieldset>
      <legend>{label}</legend>
      {table("Selectable systems", rows, true)}
      {table("Automated systems", automated, false)}
    </fieldset>
  );
}

describe("20. downstream systems table", () => {
  const renderers: RendererEntry[] = [{ name: "downstreamTable", rank: () => -1, component: DownstreamTable }];
  const loaders: Loaders = {
    downstream: async () => ({
      selectable: [
        { systemName: "Risk Engine", csiId: "CSI001", emailDl: "risk@bank" },
        { systemName: "GMI", csiId: "CSI002", emailDl: "gmi@bank" },
      ],
      automated: [{ systemName: "Total Touch", csiId: "171908", emailDl: "tt@bank" }],
    }),
  };
  const schema: Schema = {
    type: "object",
    properties: {
      affirmations: {
        type: "array",
        title: "Downstream systems",
        "x-widget": "downstreamTable",
        "x-data": {
          selectable: { source: "downstream", select: "selectable" },
          automated: { source: "downstream", select: "automated" },
        },
        items: {
          type: "object",
          properties: { systemName: { type: "string" }, csiId: { type: "string" } },
          required: ["systemName", "csiId"],
        },
      },
    },
  };
  const GMI = { systemName: "GMI", csiId: "CSI002" };
  const LEGACY = { systemName: "Legacy Draft System", csiId: "LEGACY-001" };
  const RISK = { systemName: "Risk Engine", csiId: "CSI001" };

  it("renders selectable rows as checkboxes, keeps automated and draft-only entries apart", async () => {
    const user = userEvent.setup();
    const onValuesChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <SchemaForm
        schema={schema}
        renderers={renderers}
        loaders={loaders}
        initialValues={{ affirmations: [GMI, LEGACY] }}
        onValuesChange={onValuesChange}
        onSubmit={onSubmit}
      />,
    );
    const values = () => onValuesChange.mock.calls.at(-1)?.[0];

    const selectable = await screen.findByRole("table", { name: "Selectable systems" });
    expect(within(selectable).getAllByRole("checkbox")).toHaveLength(2);
    expect(within(selectable).getByText("CSI001")).toBeInTheDocument();
    expect(within(selectable).getByText("risk@bank")).toBeInTheDocument();
    expect(screen.getByLabelText("GMI")).toBeChecked();
    expect(screen.getByLabelText("Risk Engine")).not.toBeChecked();
    const automated = screen.getByRole("table", { name: "Automated systems" });
    expect(within(automated).getByText("Total Touch")).toBeInTheDocument();
    expect(within(automated).queryByRole("checkbox")).not.toBeInTheDocument();

    await user.click(screen.getByLabelText("Risk Engine"));
    expect(values()).toEqual({ affirmations: [RISK, GMI, LEGACY] });

    await user.click(screen.getByLabelText("GMI"));
    expect(values()).toEqual({ affirmations: [RISK, LEGACY] });

    expect(screen.queryByRole("button", { name: /add/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(onSubmit).toHaveBeenCalledWith({ affirmations: [RISK, LEGACY] });
  });
});

// ---------------------------------------------------------------- 21. Multi-step form with a Review step

describe("21. stepper with a Review step", () => {
  it("shows step error badges only after Review, lists steps with errors, and skips hidden steps", async () => {
    const user = userEvent.setup();
    render(
      <SchemaForm schema={requestSchema} uischema={steps} layouts={{ Stepper: TestStepper }} loaders={noDownstream} onSubmit={vi.fn()} />,
    );
    await flush();

    const nav = screen.getByRole("navigation", { name: "Steps" });
    expect(within(nav).getAllByRole("button").map((b) => b.textContent)).toEqual(["Firm Account Details", "Classification", "Review"]);

    await user.click(stepButton("Classification"));
    await user.click(stepButton("Firm Account Details"));
    expect(nav.querySelectorAll(".badge")).toHaveLength(0);

    await user.click(stepButton("Review"));
    const review = screen.getByRole("region", { name: "Review" });
    expect(within(review).getAllByRole("button").map((b) => b.textContent)).toEqual(["Firm Account Details", "Classification"]);
    expect(stepButton("Firm Account Details")).toHaveTextContent("(has errors)");
    expect(stepButton("Classification")).toHaveTextContent("(has errors)");

    // The Review entry links to its step.
    await user.click(within(review).getByRole("button", { name: "Classification" }));
    expect(screen.getByRole("region", { name: "Classification" })).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/Asset Class/), "Fixed income");
    expect(stepButton("Classification")).toHaveTextContent("(has errors)");
    await user.type(screen.getByLabelText(/Primary Front Office Risk System/), "Murex");
    expect(stepButton("Classification")).not.toHaveTextContent("(has errors)");
    expect(stepButton("Firm Account Details")).toHaveTextContent("(has errors)");

    // Equities appears only for Equities; Downstream Systems stays out while the service returns none.
    expect(within(nav).queryByRole("button", { name: /Equities/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Asset Class/), "Equities");
    expect(within(nav).getByRole("button", { name: /Equities/ })).toBeInTheDocument();
    expect(within(nav).queryByRole("button", { name: /Downstream/ })).not.toBeInTheDocument();
  });
});
