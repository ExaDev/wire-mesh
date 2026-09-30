// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { CertificateTrustPanel } from "../src/components/CertificateTrustPanel.js";
import { formatFingerprint } from "../src/certificate-trust.js";
import type {
  NodeCertificateChange,
  TrustPrompt,
} from "../src/hooks/use-certificate-trust.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const HASH_BYTES = 32;
const NODE = "192.0.2.5:4433";
const hashHex = (digit: string): string => digit.repeat(HASH_BYTES * 2);

function renderPanel(
  props: Partial<React.ComponentProps<typeof CertificateTrustPanel>>,
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <CertificateTrustPanel
        prompts={[]}
        changes={[]}
        onDismissChange={() => undefined}
        {...props}
      />
    </MantineProvider>,
  );
}

function prompt(
  assessment: TrustPrompt["assessment"],
  decide: TrustPrompt["decide"] = () => undefined,
): TrustPrompt {
  return { key: "k", assessment, decide };
}

describe("CertificateTrustPanel", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing when there is nothing to decide or report", () => {
    renderPanel({});

    expect(screen.queryByTestId("certificate-trust")).not.toBeInTheDocument();
  });

  it("names the node and shows the certificate fingerprint for a first connection, and reports the decision", () => {
    const decide = vi.fn<(trusted: boolean) => void>();
    renderPanel({
      prompts: [
        prompt(
          { kind: "first-use", node: NODE, presented: [hashHex("a")] },
          decide,
        ),
      ],
    });

    expect(screen.getByText(`First connection to ${NODE}`)).toBeInTheDocument();
    expect(
      screen.getByText(formatFingerprint(hashHex("a"))),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Trust and connect" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(decide.mock.calls).toEqual([[true], [false]]);
  });

  it("warns that an address presents a different certificate, showing both fingerprints", () => {
    renderPanel({
      prompts: [
        prompt({
          kind: "changed",
          node: NODE,
          remembered: [hashHex("a")],
          presented: [hashHex("b")],
        }),
      ],
    });

    expect(
      screen.getByText(`Certificate changed for ${NODE}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(formatFingerprint(hashHex("a"))),
    ).toBeInTheDocument();
    expect(
      screen.getByText(formatFingerprint(hashHex("b"))),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Trust the new certificate" }),
    ).toBeInTheDocument();
  });

  it("reports an announced certificate change and dismisses it", () => {
    const onDismissChange = vi.fn<(key: string) => void>();
    const change: NodeCertificateChange = {
      key: "c1",
      node: NODE,
      remembered: [hashHex("a")],
      presented: [hashHex("b")],
    };
    renderPanel({ changes: [change], onDismissChange });

    expect(
      screen.getByText(`${NODE} announced different certificates`),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onDismissChange).toHaveBeenCalledWith("c1");
  });
});
