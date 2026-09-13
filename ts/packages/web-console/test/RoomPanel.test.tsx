// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { RoomPanel } from "../src/components/RoomPanel.js";
import type { RoomSessionView } from "../src/hooks/use-room-messaging.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_HEX_LENGTH = 64;

function view(overrides: Partial<RoomSessionView> = {}): RoomSessionView {
  return {
    peerHex: "abcd",
    roomPath: `${"1".repeat(DEVICE_ID_HEX_LENGTH)}+${"2".repeat(DEVICE_ID_HEX_LENGTH)}`,
    status: "connected",
    messages: [],
    pendingJoinRequest: undefined,
    ...overrides,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof RoomPanel>> = {},
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <RoomPanel
        view={view()}
        onSend={async () => Promise.resolve()}
        {...props}
      />
    </MantineProvider>,
  );
}

describe("RoomPanel", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders every message in the given view", () => {
    renderPanel({
      view: view({
        messages: [
          {
            direction: "sent",
            text: "hi",
            messageId: new Uint8Array([1]),
            sentAt: 1,
          },
          {
            direction: "received",
            text: "hello back",
            messageId: new Uint8Array([2]),
            sentAt: 2,
          },
        ],
      }),
    });

    expect(screen.getByText("hi")).toBeInTheDocument();
    expect(screen.getByText("hello back")).toBeInTheDocument();
  });

  it("calls onSend with the drafted text and clears the input on success", async () => {
    const onSend = vi.fn<(text: string) => Promise<void>>(async () =>
      Promise.resolve(),
    );
    renderPanel({ onSend });

    const input = screen.getByPlaceholderText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await vi.waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("hello");
    });
    await vi.waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("shows the send error and keeps the draft when onSend rejects", async () => {
    const onSend = vi.fn<(text: string) => Promise<void>>(async () =>
      Promise.reject(new Error("send failed: unauthorized")),
    );
    renderPanel({ onSend });

    const input = screen.getByPlaceholderText("Message");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await screen.findByText("send failed: unauthorized");
    expect(input).toHaveValue("hello");
  });

  it("does not call onSend for a blank draft", () => {
    const onSend = vi.fn<(text: string) => Promise<void>>(async () =>
      Promise.resolve(),
    );
    renderPanel({ onSend });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows a pending join request with allow/deny controls, and resolves it on click", () => {
    const decide = vi.fn<
      (decision: Readonly<{ kind: string }>) => Promise<void>
    >(async () => Promise.resolve());
    renderPanel({
      view: view({
        pendingJoinRequest: { requesterHex: "peerhex", decide },
      }),
    });

    expect(
      screen.getByText("peerhex wants to message you"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));

    expect(decide).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "accept" }),
    );
  });

  it("renders no join banner when there is no pending request", () => {
    renderPanel();

    expect(screen.queryByText(/wants to message you/)).toBeNull();
  });
});
