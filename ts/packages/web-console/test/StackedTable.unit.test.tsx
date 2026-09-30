// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { StackedTable } from "../src/components/StackedTable.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

function renderTable(): HTMLElement {
  const { container } = render(
    <MantineProvider>
      <StackedTable
        columns={[{ label: "name" }, { label: "actions", headerless: true }]}
        rows={[
          { key: "a", cells: ["Ada", <button key="b">Open</button>] },
          { key: "b", cells: ["Grace", <button key="b">Open</button>] },
        ]}
      />
    </MantineProvider>,
  );
  return container;
}

function rolesOf(container: HTMLElement, selector: string): (string | null)[] {
  return [...container.querySelectorAll(selector)].map((element) =>
    element.getAttribute("role"),
  );
}

describe("StackedTable", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("states every table role explicitly, since the phone layout changes display and Safari then drops the native ones", () => {
    const container = renderTable();

    expect(rolesOf(container, "thead, tbody")).toEqual([
      "rowgroup",
      "rowgroup",
    ]);
    expect(rolesOf(container, "tr")).toEqual(["row", "row", "row"]);
    expect(rolesOf(container, "th")).toEqual(["columnheader", "columnheader"]);
    expect(rolesOf(container, "td")).toEqual(["cell", "cell", "cell", "cell"]);
  });

  it("labels each cell with its column, and gives a headerless column no header text", () => {
    const container = renderTable();

    expect(
      [...container.querySelectorAll("tbody td")].map((cell) =>
        cell.getAttribute("data-label"),
      ),
    ).toEqual(["name", "actions", "name", "actions"]);
    expect(
      [...container.querySelectorAll("th")].map((cell) => cell.textContent),
    ).toEqual(["name", ""]);
  });
});
