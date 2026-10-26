import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createLoaders, schema, uischema } from "../src/demo/schema";
import { SchemaForm } from "../src/react";

const loaders = createLoaders(0);

function setup() {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<SchemaForm schema={schema} uischema={uischema} loaders={loaders} onSubmit={onSubmit} />);
  return { user, onSubmit };
}

const select = async (user: ReturnType<typeof userEvent.setup>, label: string, option: string) => {
  const el = await screen.findByLabelText(new RegExp(`^${label}`));
  await waitFor(() => expect(el).toBeEnabled());
  await waitFor(() => expect(within(el).getByRole("option", { name: option })).toBeTruthy());
  await user.selectOptions(el, within(el).getByRole("option", { name: option }));
};

describe("<SchemaForm>", () => {
  it("switches discriminated branches", async () => {
    const { user } = setup();
    expect(screen.queryByLabelText(/^First name/)).toBeNull();
    await user.click(screen.getByLabelText("An individual"));
    expect(screen.getByLabelText(/^First name/)).toBeTruthy();
    await user.click(screen.getByLabelText("A company"));
    expect(screen.queryByLabelText(/^First name/)).toBeNull();
    expect(screen.getByLabelText(/^Company name/)).toBeTruthy();
  });

  it("disables and hides fields from UI rules", async () => {
    const { user } = setup();
    await user.click(screen.getByLabelText("A company"));
    expect(screen.getByLabelText(/^VAT number/)).toBeDisabled();
    await user.click(screen.getByLabelText(/^VAT registered/));
    expect(screen.getByLabelText(/^VAT number/)).toBeEnabled();

    expect(screen.queryByText(/How should we contact you/)).toBeNull();
    await user.click(screen.getByLabelText(/^Send me offers/));
    expect(screen.getByText(/How should we contact you/)).toBeTruthy();

    expect(screen.getByLabelText(/^Promo code/)).toBeEnabled();
    await user.click(screen.getByLabelText(/^Any claims/));
    expect(screen.getByLabelText(/^Promo code/)).toBeDisabled();
  });

  it("loads dependent options and clears the child when the parent changes", async () => {
    const { user } = setup();
    expect(screen.getByLabelText(/^City/)).toBeDisabled();
    await select(user, "Country", "Germany");
    await select(user, "City", "Munich");
    expect(screen.getByLabelText<HTMLSelectElement>(/^City/).selectedOptions[0]!.textContent).toBe("Munich");
    await select(user, "Country", "France");
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLSelectElement>(/^City/).selectedOptions[0]!.textContent).toBe("Select…"),
    );
    expect(within(screen.getByLabelText(/^City/)).getByRole("option", { name: "Paris" })).toBeTruthy();
  });

  it("extends the form with fields fetched for the chosen product", async () => {
    const { user } = setup();
    expect(screen.getByText(/Complete the fields above/)).toBeTruthy();
    await user.click(screen.getByLabelText("Car insurance"));
    await select(user, "Make", "Volkswagen");
    await select(user, "Model", "Golf");
    expect(screen.getByLabelText(/^Registration/)).toBeTruthy();
    await user.click(screen.getByLabelText("Home insurance"));
    expect(await screen.findByLabelText(/^Rebuild cost/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Registration/)).toBeNull();
  });

  it("shows errors on submit, then submits clean data", async () => {
    const { user, onSubmit } = setup();
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(await screen.findByText(/Please fix/)).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getAllByText("This field is required").length).toBeGreaterThan(2);

    await user.click(screen.getByLabelText("An individual"));
    await user.type(screen.getByLabelText(/^First name/), "Ada");
    await user.type(screen.getByLabelText(/^Last name/), "Lovelace");
    await user.type(screen.getByLabelText(/^Date of birth/), "1990-12-10");
    await user.type(screen.getByLabelText(/^Address line 1/), "1 High St");
    await select(user, "Country", "United Kingdom");
    await select(user, "City", "Bury");
    await user.type(screen.getByLabelText(/^Postcode/), "nope");
    expect(await screen.findByText(/Enter a valid UK postcode/)).toBeTruthy(); // live after first submit
    await user.clear(screen.getByLabelText(/^Postcode/));
    await user.type(screen.getByLabelText(/^Postcode/), "BL9 0AA");

    await user.click(screen.getByLabelText("Home insurance"));
    await select(user, "Property type", "Flat");
    await user.type(screen.getByLabelText(/^Rebuild cost/), "180000");

    await user.click(screen.getByLabelText("Phone"));
    await user.type(screen.getByLabelText(/^Phone/, { selector: "input[type=text]" }), "0161 555 0100");

    await user.click(screen.getByLabelText(/^Any claims/));
    await user.click(screen.getByRole("button", { name: "Add claim" }));
    await user.type(screen.getByLabelText(/^Year/), "2021");
    await select(user, "Type", "Other");
    await user.type(screen.getByLabelText(/^Amount/), "1200");
    await user.type(screen.getByLabelText(/^What happened/), "Hail");

    await user.click(screen.getByRole("button", { name: "Submit" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]![0]).toEqual({
      applicant: { kind: "individual", firstName: "Ada", lastName: "Lovelace", dateOfBirth: "1990-12-10" },
      address: { line1: "1 High St", country: "GB", city: "Bury", postcode: "BL9 0AA" },
      product: "home",
      details: { propertyType: "flat", rebuildCost: 180000, listed: false },
      contact: { phone: "0161 555 0100" },
      hasPreviousClaims: true,
      claims: [{ year: 2021, type: "other", amount: 1200, description: "Hail" }],
      marketingConsent: false,
    });
  });
});
