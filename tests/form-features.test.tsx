import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createLoaders, schema as demoSchema, uischema as demoUischema } from "../src/demo/schema";
import type { Loaders, Schema, UIElement } from "../src/engine";
import { SchemaForm, type ControlProps, type RendererEntry } from "../src/react";

/** Characterization tests for React behaviour not covered by tests/form.test.tsx. */

function setup(schema: Schema, extra: Partial<Parameters<typeof SchemaForm>[0]> = {}) {
  const onSubmit = vi.fn();
  const onValuesChange = vi.fn();
  const user = userEvent.setup();
  render(<SchemaForm schema={schema} onSubmit={onSubmit} onValuesChange={onValuesChange} {...extra} />);
  const values = () => onValuesChange.mock.calls.at(-1)?.[0];
  return { user, onSubmit, values };
}

describe("<SchemaForm> without a UI schema", () => {
  it("renders every active property in schema order with humanized labels", () => {
    setup({
      type: "object",
      properties: { firstName: { type: "string" }, age_years: { type: "integer" }, nested: { type: "object", properties: { deep: { type: "boolean" } } } },
      required: ["firstName"],
    });
    const labels = [...document.querySelectorAll("label")].map((l) => l.textContent);
    expect(labels).toEqual(["First name *", "Age years", "Deep"]);
    expect(screen.getByRole("group", { name: "Nested" })).toBeTruthy();
    expect(screen.getByLabelText(/^Age years/)).toHaveAttribute("type", "number");
    expect(screen.getByLabelText(/^Deep/)).toHaveAttribute("type", "checkbox");
  });

  it("merges initialValues over defaults and reports value changes", async () => {
    const { user, values } = setup(
      { type: "object", properties: { a: { type: "string", default: "A" }, b: { type: "string", default: "B" } } },
      { initialValues: { b: "init" } },
    );
    expect(screen.getByLabelText("A")).toHaveValue("A");
    expect(screen.getByLabelText("B")).toHaveValue("init");
    await user.type(screen.getByLabelText("A"), "!");
    expect(values()).toEqual({ a: "A!", b: "init" });
    await user.clear(screen.getByLabelText("A"));
    expect(values()).toEqual({ b: "init" });
  });

  it("disables readOnly fields", () => {
    setup({ type: "object", properties: { a: { type: "string", readOnly: true } } });
    expect(screen.getByLabelText("A")).toBeDisabled();
  });

  it("writes null when a nullable field is cleared", async () => {
    const { user, values } = setup({ type: "object", properties: { n: { anyOf: [{ type: "string" }, { type: "null" }] } } });
    await user.type(screen.getByLabelText("N"), "x");
    await user.clear(screen.getByLabelText("N"));
    expect(values()).toEqual({ n: null });
  });

  it("picks renderers by schema: radios, select, multi-checkbox, textarea, date", async () => {
    const { user, values } = setup(
      {
        type: "object",
        properties: {
          size: { oneOf: [{ const: "s", title: "Small" }, { const: "l", title: "Large" }] },
          colour: { enum: ["red", "green", "blue", "pink"] },
          tags: { type: "array", uniqueItems: true, items: { enum: ["a", "b", "c"] } },
          notes: { type: "string" },
          when: { type: "string", format: "date" },
        },
      },
      { uischema: { type: "VerticalLayout", elements: ["size", "colour", "tags", "when"].map((path) => ({ type: "Control", path }) as UIElement).concat({ type: "Control", path: "notes", options: { multi: true } }) } },
    );
    expect(screen.getByLabelText("Small")).toHaveAttribute("type", "radio");
    expect(screen.getByLabelText(/^Colour/).tagName).toBe("SELECT");
    expect(screen.getByLabelText(/^Notes/).tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText(/^When/)).toHaveAttribute("type", "date");
    await user.click(screen.getByLabelText("C"));
    await user.click(screen.getByLabelText("A"));
    await user.click(screen.getByLabelText("C"));
    await user.click(screen.getByLabelText("Large"));
    expect(values()).toMatchObject({ tags: ["a"], size: "l" });
  });
});

describe("custom renderers", () => {
  const Stars = (p: ControlProps) => <output aria-label={p.label}>stars:{String(p.value)}</output>;
  const Loud = (p: ControlProps) => <input aria-label={p.label} value={String(p.value ?? "").toUpperCase()} readOnly />;

  it("replaces a default by name and can be forced with options.widget", () => {
    const renderers: RendererEntry[] = [
      { name: "text", rank: () => 1, component: Loud },
      { name: "stars", rank: () => -1, component: Stars },
    ];
    setup(
      { type: "object", properties: { a: { type: "string" }, rating: { type: "integer" } } },
      {
        renderers,
        initialValues: { a: "hi", rating: 4 },
        uischema: { type: "VerticalLayout", elements: [{ type: "Control", path: "a" }, { type: "Control", path: "rating", options: { widget: "stars" } }] },
      },
    );
    expect(screen.getByLabelText("A")).toHaveValue("HI");
    expect(screen.getByLabelText("Rating").textContent).toBe("stars:4");
  });

  it("re-renders only the edited field and its dependents while typing", async () => {
    const renders: Record<string, number> = {};
    const Counting = (p: ControlProps) => {
      renders[p.path] = (renders[p.path] ?? 0) + 1;
      return <input aria-label={p.label} value={(p.value as string) ?? ""} onChange={(e) => p.onChange(e.target.value)} />;
    };
    const user = userEvent.setup();
    render(
      <SchemaForm
        schema={demoSchema}
        uischema={demoUischema}
        loaders={createLoaders(0)}
        renderers={[{ name: "text", rank: () => 1, component: Counting }]}
        onSubmit={() => {}}
      />,
    );
    await user.click(screen.getByLabelText("An individual"));
    const before = { ...renders };
    await user.type(screen.getByLabelText("First name"), "Ada");
    expect(renders["applicant.firstName"]! - before["applicant.firstName"]!).toBeGreaterThanOrEqual(3);
    expect(renders["applicant.lastName"]).toBe(before["applicant.lastName"]);
    expect(renders["address.line1"]).toBe(before["address.line1"]);
    expect(renders["promoCode"]).toBe(before["promoCode"]);
  });
});

describe("branches, defaults and arrays", () => {
  it("applies defaults when a field appears", async () => {
    const onValuesChange = vi.fn();
    const user = userEvent.setup();
    render(<SchemaForm schema={demoSchema} uischema={demoUischema} loaders={createLoaders(0)} onSubmit={() => {}} onValuesChange={onValuesChange} />);
    await user.click(screen.getByLabelText("A company"));
    await waitFor(() => expect(onValuesChange.mock.calls.at(-1)![0].applicant).toEqual({ kind: "company", vatRegistered: false }));
  });

  it("clears values of the old branch when switching", async () => {
    const user = userEvent.setup();
    render(<SchemaForm schema={demoSchema} uischema={demoUischema} loaders={createLoaders(0)} onSubmit={() => {}} />);
    await user.click(screen.getByLabelText("An individual"));
    await user.type(screen.getByLabelText(/^First name/), "Ada");
    await user.click(screen.getByLabelText("A company"));
    await user.click(screen.getByLabelText("An individual"));
    expect(screen.getByLabelText(/^First name/)).toHaveValue("");
  });

  it("clears values as soon as x-hidden or x-disabled takes their field away", async () => {
    const onValuesChange = vi.fn();
    const user = userEvent.setup();
    render(<SchemaForm schema={demoSchema} uischema={demoUischema} loaders={createLoaders(0)} onSubmit={() => {}} onValuesChange={onValuesChange} />);
    const last = () => onValuesChange.mock.calls.at(-1)![0];
    await user.click(screen.getByLabelText(/^Send me offers/));
    await user.selectOptions(screen.getByLabelText(/^How should we contact you/), "Sms");
    await user.type(screen.getByLabelText(/^Promo code/), "SAVE10");
    expect(last()).toMatchObject({ marketingChannel: "sms", promoCode: "SAVE10" });
    await user.click(screen.getByLabelText(/^Send me offers/));
    await user.click(screen.getByLabelText(/^Any claims/));
    await waitFor(() => expect(last().marketingChannel).toBeUndefined());
    expect(last().promoCode).toBeUndefined();
    await user.click(screen.getByLabelText(/^Any claims/));
    expect(screen.getByLabelText(/^Promo code/)).toHaveValue("");
  });

  it("keeps initial values for fields that are still loading", async () => {
    const onValuesChange = vi.fn();
    render(
      <SchemaForm
        schema={demoSchema}
        uischema={demoUischema}
        loaders={createLoaders(20)}
        initialValues={{ product: "car", details: { make: "vw", model: "Golf" } }}
        onSubmit={() => {}}
        onValuesChange={onValuesChange}
      />,
    );
    expect(await screen.findByLabelText(/^Registration/)).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>(/^Model/).selectedOptions[0]!.textContent).toBe("Golf"));
    expect(onValuesChange.mock.calls.at(-1)![0].details).toEqual({ make: "vw", model: "Golf" });
  });

  it("switches oneOf branches without a discriminator from their defaults", async () => {
    const { user, values } = setup({
      type: "object",
      properties: {
        contact: {
          oneOf: [
            { title: "Email", type: "object", properties: { email: { type: "string" } } },
            { title: "Phone", type: "object", properties: { phone: { type: "string" }, ext: { type: "string", default: "0" } } },
          ],
        },
      },
    });
    const text = (name: string) => screen.queryByLabelText(name, { selector: "input[type=text]" });
    await user.type(text("Email")!, "a@b.c");
    expect(text("Phone")).toBeNull();
    await user.click(screen.getByRole("radio", { name: "Phone" }));
    expect(text("Phone")).toBeTruthy();
    expect(text("Email")).toBeNull();
    expect(values()).toEqual({ contact: { ext: "0" } });
    await user.click(screen.getByRole("radio", { name: "Email" }));
    expect(text("Email")).toHaveValue("");
  });

  it("adds and removes array items, respecting maxItems", async () => {
    const { user, values } = setup({
      type: "object",
      properties: { pets: { type: "array", title: "Pets", maxItems: 2, items: { type: "object", properties: { name: { type: "string", default: "Rex" } } } } },
    });
    expect(screen.getByText("None added yet.")).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add pet" });
    await user.click(add);
    await user.click(add);
    expect(add).toBeDisabled();
    expect(values()).toEqual({ pets: [{ name: "Rex" }, { name: "Rex" }] });
    const item = (i: number) => document.querySelectorAll<HTMLElement>(".sf-array-item")[i]!;
    const second = item(1);
    await user.clear(within(second).getByLabelText("Name"));
    await user.type(within(second).getByLabelText("Name"), "Tom");
    await user.click(within(item(0)).getAllByRole("button", { name: "Remove" })[0]!);
    expect(values()).toEqual({ pets: [{ name: "Tom" }] });
    expect(add).toBeEnabled();
  });

  const lockable: Schema = {
    type: "object",
    properties: {
      lock: { type: "boolean" },
      box: {
        type: "object",
        "x-disabled": { logic: { var: "lock" } },
        properties: { a: { type: "string" }, list: { type: "array", items: { type: "string" } } },
      },
    },
  };

  for (const [name, uischema] of [
    ["without a UI schema", undefined],
    ["with descendants placed directly in a layout", {
      type: "VerticalLayout",
      elements: [{ type: "Control", path: "lock" }, { type: "Group", label: "G", elements: [{ type: "Control", path: "box.a" }, { type: "Control", path: "box.list" }] }],
    }],
  ] as const)
    it(`disables descendants of an x-disabled object, including array controls, ${name}`, async () => {
      const { user } = setup(lockable, { uischema: uischema as UIElement | undefined });
      expect(screen.getByLabelText("A")).toBeEnabled();
      await user.click(screen.getByLabelText("Lock"));
      expect(screen.getByLabelText("A")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add list" })).toBeDisabled();
    });

  it("hides a group once every field in it is hidden", async () => {
    const { user } = setup(
      { type: "object", properties: { off: { type: "boolean" }, a: { type: "string", "x-hidden": { logic: { var: "off" } } } } },
      { uischema: { type: "VerticalLayout", elements: [{ type: "Control", path: "off" }, { type: "Group", label: "Extras", elements: [{ type: "Control", path: "a" }] }] } },
    );
    expect(screen.getByText("Extras")).toBeTruthy();
    await user.click(screen.getByLabelText("Off"));
    expect(screen.queryByText("Extras")).toBeNull();
  });
});

describe("async UI states", () => {
  it("shows a loader error with a retry that reloads options", async () => {
    let fail = true;
    const loaders: Loaders = {
      colours: async () => {
        if (fail) throw new Error("down");
        return [{ value: "r", label: "Red" }];
      },
    };
    const { user } = setup({ type: "object", properties: { c: { type: "string", "x-options": { source: "colours" } } } }, { loaders });
    expect(await screen.findByRole("option", { name: "Couldn't load options" })).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("option", { name: "Red" })).toBeTruthy();
    expect(screen.getByLabelText("C")).toBeEnabled();
  });

  it("shows loading and error states for fetched fragments, then their fields", async () => {
    let fail = true;
    let release!: () => void;
    const loaders: Loaders = {
      frag: () =>
        new Promise((resolve, reject) => {
          release = () => (fail ? reject(new Error("x")) : resolve({ properties: { extra: { type: "string" } } }));
        }),
    };
    const { user } = setup({ type: "object", properties: { d: { type: "object", title: "Details", "x-extend": { source: "frag" } } } }, { loaders });
    expect(screen.getByText("Loading fields…")).toBeTruthy();
    release();
    expect(await screen.findByText(/Couldn't load these fields/)).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    release();
    expect(await screen.findByLabelText("Extra")).toBeTruthy();
  });

  it("revalidates after a submit attempt when async data arrives", async () => {
    let release!: () => void;
    const loaders: Loaders = {
      frag: () => new Promise((resolve) => (release = () => resolve({ properties: { extra: { type: "string" } }, required: ["extra"] }))),
    };
    const { user, onSubmit } = setup({ type: "object", properties: { d: { type: "object", "x-extend": { source: "frag" } } } }, { loaders });
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Some fields are still loading…")).toBeTruthy();
    release();
    expect(await screen.findByText("This field is required")).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("one response feeding several selects", () => {
  it("fills both selects from one call and clears both when the parent changes", async () => {
    const loader = vi.fn(async (p: Record<string, unknown>) =>
      p.country === "FR"
        ? { cities: [{ value: "Paris", label: "Paris" }], zones: [{ value: "z1", label: "Zone 1" }] }
        : { cities: [{ value: "Berlin", label: "Berlin" }], zones: [{ value: "z9", label: "Zone 9" }] },
    );
    const ref = (select: string) => ({ source: "region", params: { country: { var: "country" } }, select });
    const { user, values } = setup(
      {
        type: "object",
        properties: {
          country: { enum: ["FR", "DE", "IT", "ES"] },
          city: { type: "string", "x-options": ref("cities") },
          zone: { type: "string", "x-options": ref("zones") },
        },
      },
      { loaders: { region: loader } },
    );
    await user.selectOptions(screen.getByLabelText("Country"), "Fr");
    await user.selectOptions(await screen.findByLabelText("City"), (await screen.findByRole("option", { name: "Paris" })) as HTMLOptionElement);
    await user.selectOptions(screen.getByLabelText("Zone"), screen.getByRole("option", { name: "Zone 1" }) as HTMLOptionElement);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(values()).toMatchObject({ country: "FR", city: "Paris", zone: "z1" });

    await user.selectOptions(screen.getByLabelText("Country"), "De");
    expect(await screen.findByRole("option", { name: "Zone 9" })).toBeTruthy();
    await waitFor(() => expect(values()).toEqual({ country: "DE" }));
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("x-prefill button", () => {
  it("fills the mapped fields from the demo company prefill, and reports failures", async () => {
    const onValuesChange = vi.fn();
    const user = userEvent.setup();
    render(<SchemaForm schema={demoSchema} uischema={demoUischema} loaders={createLoaders(0)} onSubmit={() => {}} onValuesChange={onValuesChange} />);
    await user.click(screen.getByLabelText("A company"));
    const button = screen.getByRole("button", { name: "Find company" });
    expect(button).toBeDisabled();

    await user.type(screen.getByLabelText("Company number"), "999");
    await user.click(button);
    expect(await screen.findByText(/Couldn't look that up/)).toBeTruthy();

    await user.clear(screen.getByLabelText("Company number"));
    await user.type(screen.getByLabelText("Company number"), "12345678");
    await user.click(button);
    await waitFor(() => expect(screen.getByLabelText(/^Company name/)).toHaveValue("Acme Widgets Ltd"));
    expect(screen.queryByText(/Couldn't look that up/)).toBeNull();
    expect(screen.getByLabelText(/^VAT number/)).toHaveValue("GB123456789");
    expect(screen.getByLabelText(/^VAT number/)).toBeEnabled();
    expect(screen.getByLabelText(/^Address line 1/)).toHaveValue("1 Factory Lane");
    expect(onValuesChange.mock.calls.at(-1)![0].applicant).toMatchObject({ vatRegistered: true });
  });
});

describe("x-prefill order", () => {
  it("writes all fills before clearing, so a field enabled by another fill keeps its value", async () => {
    const user = userEvent.setup();
    const { values } = setup(
      {
        type: "object",
        // `code` is filled before `on`, and is disabled until `on` is true.
        properties: {
          id: { type: "string", "x-prefill": { source: "find", params: { id: { var: "id" } }, fill: { code: "code", on: "on" } } },
          on: { type: "boolean" },
          code: { type: "string", "x-disabled": { logic: { "!": { var: "on" } } } },
        },
      },
      { loaders: { find: async () => ({ code: "C1", on: true }) } },
    );
    await user.type(screen.getByLabelText("Id"), "1");
    await user.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() => expect(values()).toMatchObject({ id: "1", on: true, code: "C1" }));
  });
});

describe("form chrome", () => {
  it("uses submitLabel and renderActions", () => {
    const { unmount } = render(<SchemaForm schema={{ properties: {} }} onSubmit={() => {}} submitLabel="Go" />);
    expect(screen.getByRole("button", { name: "Go" })).toBeTruthy();
    unmount();
    render(<SchemaForm schema={{ properties: {} }} onSubmit={() => {}} renderActions={(form) => <button type="button" onClick={() => form.reset()}>Custom</button>} />);
    expect(screen.getByRole("button", { name: "Custom" })).toBeTruthy();
  });

  it("marks invalid fields, counts them and focuses the first one", async () => {
    const { user } = setup({ type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] });
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Please fix 2 fields above.")).toBeTruthy();
    expect(screen.getByLabelText(/^A/)).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(screen.getByLabelText(/^A/)).toHaveFocus());
    await user.type(screen.getByLabelText(/^A/), "x");
    expect(await screen.findByText("Please fix 1 field above.")).toBeTruthy();
  });
});

describe("computed fields", () => {
  const schema: Schema = {
    type: "object",
    properties: {
      qty: { type: "integer" },
      price: { type: "number" },
      total: { type: "number", readOnly: true, "x-compute": { logic: { "*": [{ var: "qty" }, { var: "price" }] } } },
      budget: { type: "number", "x-compute": { logic: { "*": [{ var: "total" }, 2] } } },
    },
  };

  it("fills derived fields as the user types, and lets the user override editable ones", async () => {
    const onStateChange = vi.fn();
    const { user, values } = setup(schema, { onStateChange });
    await user.type(screen.getByLabelText("Qty"), "2");
    await user.type(screen.getByLabelText("Price"), "5");
    expect(screen.getByLabelText("Total")).toBeDisabled();
    expect(screen.getByLabelText("Total")).toHaveValue(10);
    expect(screen.getByLabelText("Budget")).toHaveValue(20);
    expect(onStateChange.mock.calls.at(-1)![0]).toEqual({
      values: { qty: 2, price: 5, total: 10, budget: 20 },
      provenance: { qty: "user", price: "user", total: "compute", budget: "compute" },
      selections: {},
    });

    await user.clear(screen.getByLabelText("Budget"));
    await user.type(screen.getByLabelText("Budget"), "7");
    await user.type(screen.getByLabelText("Qty"), "0"); // qty = 20
    expect(values()).toEqual({ qty: 20, price: 5, total: 100, budget: 7 });
    expect(onStateChange.mock.calls.at(-1)![0].provenance).toEqual({ qty: "user", price: "user", total: "compute", budget: "user" });
    // Clearing is an edit too: the field stays empty instead of refilling.
    await user.clear(screen.getByLabelText("Budget"));
    expect(values()).toEqual({ qty: 20, price: 5, total: 100 });
  });

  it("resumes from a snapshot, keeping ownership of computed fields and branch picks", async () => {
    const withBranch: Schema = {
      ...schema,
      properties: {
        ...schema.properties,
        contact: { type: "object", oneOf: [{ title: "Email", properties: { email: { type: "string" } } }, { title: "Phone", properties: { phone: { type: "string" } } }] },
      },
    };
    const onStateChange = vi.fn();
    const { user, values } = setup(withBranch, {
      onStateChange,
      initialState: { values: { qty: 2, price: 5, total: 10, budget: 20, contact: {} }, provenance: { budget: "compute", stale: "x" }, selections: { contact: 1 } },
    });
    expect(screen.getByRole("radio", { name: "Phone" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Phone" })).toBeTruthy();
    // Entries for values the draft no longer holds are dropped.
    expect(onStateChange.mock.calls.at(-1)![0]).toMatchObject({ provenance: { budget: "compute" }, selections: { contact: 1 } });
    await user.type(screen.getByLabelText("Qty"), "0");
    expect(values()).toMatchObject({ total: 100, budget: 200 });
  });

  it("forgets the source of a removed array item and re-indexes the ones after it", async () => {
    const onStateChange = vi.fn();
    const { user } = setup(
      {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: { type: "object", properties: { n: { type: "integer" }, d: { type: "integer", readOnly: true, "x-compute": { logic: { "*": [{ var: "$item.n" }, 2] } } } } },
          },
        },
      },
      { initialValues: { rows: [{ n: 1 }, { n: 2 }, { n: 3 }] }, onStateChange },
    );
    expect(onStateChange.mock.calls.at(-1)![0].provenance).toEqual({ "rows[0].d": "compute", "rows[1].d": "compute", "rows[2].d": "compute" });
    await user.click(screen.getAllByRole("button", { name: "Remove" })[1]!);
    expect(onStateChange.mock.calls.at(-1)![0]).toMatchObject({
      values: { rows: [{ n: 1, d: 2 }, { n: 3, d: 6 }] },
      provenance: { "rows[0].d": "compute", "rows[1].d": "compute" },
    });
  });
});

describe("x-prefill on change", () => {
  it("fills automatically as the value changes, keeping what the user typed", async () => {
    const loader = vi.fn(async (p: Record<string, unknown>) => ({ street: `St ${p.pc}`, town: `Town ${p.pc}` }));
    const { user, values } = setup(
      {
        type: "object",
        properties: {
          pc: { type: "string", title: "Postcode", "x-prefill": { source: "addr", params: { pc: { var: "$self" } }, fill: { street: "street", town: "town" }, trigger: "change" } },
          street: { type: "string" },
          town: { type: "string" },
        },
      },
      { loaders: { addr: loader } },
    );
    expect(screen.queryByRole("button", { name: "Look up" })).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Postcode"), "AB1");
    await waitFor(() => expect(values()).toEqual({ pc: "AB1", street: "St AB1", town: "Town AB1" }));
    await user.type(screen.getByLabelText("Street"), "!");
    await user.type(screen.getByLabelText("Postcode"), "2");
    await waitFor(() => expect(values()).toEqual({ pc: "AB12", street: "St AB1!", town: "Town AB12" }));
  });
});

describe("x-prefill provenance", () => {
  it("clears fields it filled earlier when a new response lacks them, and keeps what the user typed", async () => {
    const responses: Record<string, object> = { "1": { name: "One", city: "Leeds" }, "2": { name: "Two" } };
    const onStateChange = vi.fn();
    const { user, values } = setup(
      {
        type: "object",
        properties: {
          id: { type: "string", "x-prefill": { source: "find", params: { id: { var: "id" } }, fill: { name: "name", city: "city", note: "note" } } },
          name: { type: "string" },
          city: { type: "string" },
          note: { type: "string" },
        },
      },
      { loaders: { find: async (p) => responses[p.id as string]! }, onStateChange },
    );
    await user.type(screen.getByLabelText("Note"), "mine");
    await user.type(screen.getByLabelText("Id"), "1");
    await user.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() => expect(values()).toEqual({ id: "1", name: "One", city: "Leeds", note: "mine" }));
    expect(onStateChange.mock.calls.at(-1)![0].provenance).toEqual({ note: "user", id: "user", name: "find", city: "find" });

    await user.clear(screen.getByLabelText("Id"));
    await user.type(screen.getByLabelText("Id"), "2");
    await user.click(screen.getByRole("button", { name: "Look up" }));
    await waitFor(() => expect(values()).toEqual({ id: "2", name: "Two", note: "mine" }));
    expect(onStateChange.mock.calls.at(-1)![0].provenance).toEqual({ note: "user", id: "user", name: "find" });
  });
});

describe("x-prefill edge cases", () => {
  const addrSchema = (extra: object = {}): Schema => ({
    type: "object",
    properties: {
      pc: {
        type: "string",
        title: "Postcode",
        "x-prefill": { source: "addr", params: { pc: { var: "$self" } }, fill: { street: "street", town: "town" }, trigger: "change", ...extra },
      },
      street: { type: "string" },
      town: { type: "string" },
    },
  });

  it("on change, only the latest run writes, even when an older response arrives last", async () => {
    const pending: Record<string, (v: object) => void> = {};
    const loader = vi.fn((p: Record<string, unknown>) => new Promise<object>((r) => (pending[p.pc as string] = r)));
    const { user, values } = setup(addrSchema(), { loaders: { addr: loader } });
    await user.type(screen.getByLabelText("Postcode"), "12");
    await waitFor(() => expect(Object.keys(pending).sort()).toEqual(["1", "12"]));
    pending["12"]!({ street: "St 12", town: "Town 12" });
    await waitFor(() => expect(values()).toEqual({ pc: "12", street: "St 12", town: "Town 12" }));
    pending["1"]!({ street: "St 1", town: "Town 1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(values()).toEqual({ pc: "12", street: "St 12", town: "Town 12" });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("on change, runs when a draft opens with its params filled, keeping loaded values", async () => {
    const loader = vi.fn(async () => ({ street: "St", town: "Town" }));
    const { values } = setup(addrSchema(), { loaders: { addr: loader }, initialValues: { pc: "AB1", street: "Mine" } });
    await waitFor(() => expect(values()).toEqual({ pc: "AB1", street: "Mine", town: "Town" }));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("on change, shows progress and then an error when the lookup fails", async () => {
    let fail!: (e: Error) => void;
    const loader = () => new Promise<object>((_, reject) => (fail = reject));
    const { user } = setup(addrSchema(), { loaders: { addr: loader } });
    await user.type(screen.getByLabelText("Postcode"), "X");
    expect(await screen.findByRole("status")).toHaveTextContent("Looking up…");
    fail(new Error("nope"));
    expect(await screen.findByText(/Couldn't look that up/)).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  const lockedSchema = (trigger?: "change"): Schema => ({
    type: "object",
    properties: {
      lock: { type: "boolean" },
      ref: { type: "string" },
      code: {
        type: "string",
        "x-disabled": { logic: { var: "lock" } },
        "x-prefill": { source: "find", params: { ref: { var: "ref" } }, fill: { name: "name" }, ...(trigger && { trigger }) },
      },
      name: { type: "string" },
    },
  });

  it("on change, doesn't run while its field is disabled, and runs once it is enabled", async () => {
    const loader = vi.fn(async () => ({ name: "Found" }));
    const { user, values } = setup(lockedSchema("change"), { loaders: { find: loader }, initialValues: { lock: true, ref: "R" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(loader).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("Lock"));
    await waitFor(() => expect(values()).toEqual({ lock: false, ref: "R", name: "Found" }));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("disables the button while its field is disabled or a param is empty", async () => {
    const { user, values } = setup(lockedSchema(), { loaders: { find: async () => ({ name: "Found" }) }, initialValues: { lock: true } });
    // Same element throughout: toggling x-disabled must not remount the field.
    const button = screen.getByRole("button", { name: "Look up" });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Ref"), "R");
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText("Lock"));
    expect(button).toBeEnabled();
    await user.click(button);
    await waitFor(() => expect(values()).toEqual({ lock: false, ref: "R", name: "Found" }));
  });
});

describe("non-strict options", () => {
  it("keeps a value outside the loaded list and shows it in the select", async () => {
    const { user, values } = setup(
      {
        type: "object",
        properties: {
          strict: { type: "string", "x-options": { source: "list" } },
          loose: { type: "string", "x-options": { source: "list", strict: false } },
        },
      },
      { loaders: { list: async () => [{ value: "a", label: "A" }] }, initialValues: { strict: "zz", loose: "zz" } },
    );
    await waitFor(() => expect(screen.getByLabelText("Strict")).toBeEnabled());
    expect(values()).toEqual({ loose: "zz" });
    expect(screen.getByLabelText("Loose")).toHaveDisplayValue("zz");
    await user.selectOptions(screen.getByLabelText("Loose"), "A");
    expect(values()).toEqual({ loose: "a" });
  });
});

describe("server errors", () => {
  it("shows errors returned by onSubmit inline and clears them as the user edits", async () => {
    const onSubmit = vi.fn(async () => ({ form: "Could not save", fields: { email: "Already registered" } }));
    const user = userEvent.setup();
    render(<SchemaForm schema={{ type: "object", properties: { email: { type: "string" }, name: { type: "string" } } }} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText("Email"), "a@b.c");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText("Already registered")).toBeTruthy();
    expect(screen.getByText("Could not save")).toBeTruthy();
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");

    await user.type(screen.getByLabelText("Email"), "d");
    await waitFor(() => expect(screen.queryByText("Already registered")).toBeNull());
    expect(screen.queryByText("Could not save")).toBeNull();
  });
});
