// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { MessageList } from "../src/components/MessageList.js";
import type { PendingOutgoing } from "../src/conversations.js";
import type { StoredMessage } from "../src/message-store.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const SECOND_MS = 1000;
const SCROLL_HEIGHT_PX = 480;
const PEER_LABEL = "peer-label";

function message(
  id: number,
  overrides: Partial<StoredMessage> = {},
): StoredMessage {
  return {
    direction: "received",
    text: `message ${String(id)}`,
    messageId: new Uint8Array([id]),
    sentAt: id * SECOND_MS,
    ...overrides,
  };
}

function renderList(
  props: Partial<React.ComponentProps<typeof MessageList>> = {},
): ReturnType<typeof render> {
  return render(
    <MantineProvider>
      <MessageList
        messages={[]}
        outgoing={[]}
        peerLabel={PEER_LABEL}
        onRetry={() => undefined}
        onDiscard={() => undefined}
        {...props}
      />
    </MantineProvider>,
  );
}

describe("MessageList", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders two messages with identical text and timestamp as two entries", () => {
    renderList({
      messages: [
        message(1, { text: "same", sentAt: SECOND_MS }),
        message(2, { text: "same", sentAt: SECOND_MS }),
      ],
    });

    expect(screen.getAllByText("same")).toHaveLength(2);
  });

  it("stamps each message with its send time", () => {
    const sentAtIso = "2026-01-02T03:04:05.000Z";
    const { container } = renderList({
      messages: [message(1, { sentAt: Date.parse(sentAtIso) })],
    });

    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      sentAtIso,
    );
  });

  it("labels the start of each run from one side once, naming the peer and the user differently", () => {
    const directions = [
      "received",
      "received",
      "sent",
      "sent",
      "received",
    ] as const;
    renderList({
      messages: directions.map((direction, index) =>
        message(index + 1, { direction }),
      ),
    });

    expect(screen.getAllByText(PEER_LABEL)).toHaveLength(2);
    expect(screen.getAllByText("You")).toHaveLength(1);
  });

  it("shows an unsent message as sending, without retry actions", () => {
    const pending: PendingOutgoing = {
      localId: "a",
      text: "on its way",
      status: "sending",
    };
    renderList({ outgoing: [pending] });

    expect(screen.getByText("on its way")).toBeInTheDocument();
    expect(screen.getByText("Sending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("shows a failed message with its reason and reports retry and dismiss for that message", () => {
    const onRetry = vi.fn<(localId: string) => void>();
    const onDiscard = vi.fn<(localId: string) => void>();
    const pending: PendingOutgoing = {
      localId: "a",
      text: "refused",
      status: "failed",
      error: "send failed: denied",
    };
    renderList({ outgoing: [pending], onRetry, onDiscard });

    expect(
      screen.getByText("Not sent: send failed: denied"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(onRetry).toHaveBeenCalledWith("a");
    expect(onDiscard).toHaveBeenCalledWith("a");
  });

  it("scrolls to the newest entry when a message arrives", () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      SCROLL_HEIGHT_PX,
    );
    const { container, rerender } = renderList({ messages: [message(1)] });

    rerender(
      <MantineProvider>
        <MessageList
          messages={[message(1), message(2)]}
          outgoing={[]}
          peerLabel={PEER_LABEL}
          onRetry={() => undefined}
          onDiscard={() => undefined}
        />
      </MantineProvider>,
    );

    const viewportElement = container.querySelector(
      "[data-scrollarea-viewport], .mantine-ScrollArea-viewport",
    );
    expect(viewportElement?.scrollTop).toBe(SCROLL_HEIGHT_PX);
  });
});
