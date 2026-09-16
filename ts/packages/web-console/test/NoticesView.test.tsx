// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NoticesView } from "../src/components/NoticesView.js";
import type { NoticeBoardEntry } from "wire-mesh-core/domain/notice-board";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

function renderView(
  notices: readonly NoticeBoardEntry[],
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <NoticesView notices={notices} />
    </MantineProvider>,
  );
}

describe("NoticesView", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders nothing for an empty notice list", () => {
    // Mantine injects its own <style> element into the container;
    // testing-library's queryByText ignores style/script by default, so this
    // asserts no visible text without tripping over injected styles.
    renderView([]);
    expect(screen.queryByText(/./)).toBeNull();
  });

  it("renders decrypted notice text", () => {
    renderView([
      {
        verified: true,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode("durable and readable"),
      },
    ]);
    expect(screen.getByText("durable and readable")).toBeInTheDocument();
  });

  it("renders an explicit placeholder, not a blank row, for a verified notice this side cannot decrypt", () => {
    renderView([
      {
        verified: true,
        contentType: "text/plain",
      },
    ]);
    expect(
      screen.getByText(/encrypted notice -- no key held/i),
    ).toBeInTheDocument();
  });

  it("renders several notices in order with a total count", () => {
    renderView([
      {
        verified: true,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode("first"),
      },
      {
        verified: true,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode("second"),
      },
    ]);
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.getByText("2 notices")).toBeInTheDocument();
  });

  it("singularises the count badge for exactly one notice", () => {
    renderView([
      {
        verified: true,
        contentType: "text/plain",
        plaintext: new TextEncoder().encode("only"),
      },
    ]);
    expect(screen.getByText("1 notice")).toBeInTheDocument();
  });
});
