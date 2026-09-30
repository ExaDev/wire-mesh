// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { RoomPanel } from "../src/components/RoomPanel.js";
import { usePeerNames } from "../src/hooks/use-peer-names.js";
import { selfNameExtension, shortId } from "../src/peer-names.js";
import type { ConversationView } from "../src/conversations.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";
import { deviceIdFromFillHex } from "./hex.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";

const DEVICE_ID_HEX_LENGTH = 64;

function view(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    participants: ["abcd"],
    roomPath: `${"1".repeat(DEVICE_ID_HEX_LENGTH)}+${"2".repeat(DEVICE_ID_HEX_LENGTH)}`,
    status: "connected",
    via: "direct",
    messages: [],
    notices: [],
    outgoing: [],
    pendingJoinRequest: undefined,
    unread: 0,
    ...overrides,
  };
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof RoomPanel>> = {},
  store = memoryNameStore(),
): ReturnType<typeof render> {
  return render(
    <WithNames store={store}>
      <RoomPanel
        view={view()}
        onSend={async () => Promise.resolve()}
        onPostNotice={async () => Promise.resolve()}
        onRetry={() => undefined}
        onDiscard={() => undefined}
        {...props}
      />
    </WithNames>,
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

  it("calls onPostNotice with the drafted notice text and clears the input on success", async () => {
    const onPostNotice = vi.fn(async (): Promise<void> => Promise.resolve());
    renderPanel({ onPostNotice });
    const input = screen.getByPlaceholderText("Post a durable notice");
    fireEvent.change(input, { target: { value: "durable hello" } });
    fireEvent.click(screen.getByText("Post notice"));
    await waitFor(() => {
      expect(onPostNotice).toHaveBeenCalledWith("durable hello");
    });
    expect(screen.getByPlaceholderText("Post a durable notice")).toHaveValue(
      "",
    );
  });

  it("renders the session's notices through the notices view", () => {
    renderPanel({
      view: view({
        notices: [
          {
            verified: true,
            contentType: "text/plain",
            plaintext: new TextEncoder().encode("a replicated notice"),
          },
        ],
      }),
    });
    expect(screen.getByText("a replicated notice")).toBeInTheDocument();
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

  it("names the peer by the petname held for it, in the header and in a message request", async () => {
    const store = memoryNameStore();
    const peer = "2".repeat(DEVICE_ID_HEX_LENGTH);
    await store.setPetname(peer, "Ada");
    renderPanel(
      {
        view: view({
          participants: [peer],
          pendingJoinRequest: { requesterHex: peer, decide: vi.fn() },
        }),
      },
      store,
    );

    await screen.findAllByText("Ada");
    expect(screen.getByText(/wants to message you/)).toHaveTextContent(
      "Ada wants to message you",
    );
    expect(screen.queryByText(peer)).toBeNull();
  });

  it("shows the requester's short id beside a name it chose for itself, so a stranger cannot pass as someone else", async () => {
    const requester = "ab".repeat(DEVICE_ID_HEX_LENGTH / 2);

    /** Feeds the naming context a directory in which the requester asserts the name "Support", the way a connection panel does. */
    function AssertsName(): null {
      const { observeDirectory } = usePeerNames();
      useEffect(() => {
        observeDirectory([
          {
            device: deviceIdFromFillHex("ab"),
            advert: {
              device: deviceIdFromFillHex("ab"),
              addresses: [],
              "snapshot-seconds": 0,
              ...syntheticAdvertProof(),
              ...selfNameExtension("Support"),
            },
          },
        ]);
      }, [observeDirectory]);
      return null;
    }

    render(
      <WithNames>
        <AssertsName />
        <RoomPanel
          view={view({
            participants: [requester],
            pendingJoinRequest: { requesterHex: requester, decide: vi.fn() },
          })}
          onSend={async () => Promise.resolve()}
          onPostNotice={async () => Promise.resolve()}
          onRetry={() => undefined}
          onDiscard={() => undefined}
        />
      </WithNames>,
    );

    await waitFor(() => {
      expect(screen.getByText(/wants to message you/)).toHaveTextContent(
        `Support (${shortId(requester)}) wants to message you`,
      );
    });
  });
});
