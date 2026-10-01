// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SelfNameField } from "../src/components/SelfNameField.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

describe("SelfNameField", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps Save disabled for a draft that cleans to the name already saved", async () => {
    const store = memoryNameStore();
    await store.setSelfName("Ada");
    render(
      <WithNames store={store}>
        <SelfNameField />
      </WithNames>,
    );
    const field = await screen.findByDisplayValue("Ada");

    fireEvent.change(field, { target: { value: "Ada‮" } });

    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("keeps Save disabled for a draft of only stripped characters when no name is saved", () => {
    render(
      <WithNames>
        <SelfNameField />
      </WithNames>,
    );

    fireEvent.change(screen.getByLabelText(/^Your display name/), {
      target: { value: "‮⁦" },
    });

    expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled();
  });

  it("enables Save for a draft that cleans to a different name", () => {
    render(
      <WithNames>
        <SelfNameField />
      </WithNames>,
    );

    fireEvent.change(screen.getByLabelText(/^Your display name/), {
      target: { value: "Grace" },
    });

    expect(screen.getByRole("button", { name: "Save name" })).toBeEnabled();
  });
});
