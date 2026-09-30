// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationList } from "../src/components/ConversationList.js";
import type { ConversationView } from "../src/conversations.js";
import { WithNames, memoryNameStore } from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_HEX_LENGTH = 64;

function conversation(
  peerDigit: string,
  overrides: Partial<ConversationView> = {},
): ConversationView {
  const peer = peerDigit.repeat(DEVICE_ID_HEX_LENGTH);
  return {
    roomPath: `${"1".repeat(DEVICE_ID_HEX_LENGTH)}+${peer}`,
    participants: [peer],
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

function renderList(
  props: Partial<React.ComponentProps<typeof ConversationList>> = {},
  store = memoryNameStore(),
): ReturnType<typeof render> {
  return render(
    <WithNames store={store}>
      <ConversationList
        conversations={[]}
        selected={undefined}
        onSelect={() => undefined}
        {...props}
      />
    </WithNames>,
  );
}

describe("ConversationList", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing when there are no conversations", () => {
    renderList();

    expect(screen.queryByTestId("conversation-list")).not.toBeInTheDocument();
  });

  it("labels each conversation by its peer's leading device-id characters", () => {
    renderList({ conversations: [conversation("2"), conversation("3")] });

    expect(screen.getByText("222222222222")).toBeInTheDocument();
    expect(screen.getByText("333333333333")).toBeInTheDocument();
  });

  it("shows the unread count only for a conversation that has unread messages", () => {
    renderList({
      conversations: [conversation("2", { unread: 3 }), conversation("3")],
    });

    expect(screen.getByLabelText("3 unread")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/unread/)).toHaveLength(1);
  });

  it("marks a conversation waiting on this console's decision", () => {
    renderList({
      conversations: [
        conversation("2", {
          pendingJoinRequest: {
            requesterHex: "2".repeat(DEVICE_ID_HEX_LENGTH),
            decide: async () => Promise.resolve(),
          },
        }),
        conversation("3"),
      ],
    });

    expect(screen.getAllByText("request")).toHaveLength(1);
  });

  it("marks a conversation with no live session as offline", () => {
    renderList({
      conversations: [
        conversation("2", { status: "closed" }),
        conversation("3"),
      ],
    });

    expect(screen.getAllByText("offline")).toHaveLength(1);
  });

  it("reports the clicked conversation's room path", () => {
    const onSelect = vi.fn<(roomPath: string) => void>();
    const second = conversation("3");
    renderList({ conversations: [conversation("2"), second], onSelect });

    fireEvent.click(screen.getByText("333333333333"));

    expect(onSelect).toHaveBeenCalledWith(second.roomPath);
  });
});

describe("ConversationList naming", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("labels a conversation by the petname held for its peer", async () => {
    const store = memoryNameStore();
    await store.setPetname("2".repeat(DEVICE_ID_HEX_LENGTH), "Ada");

    renderList(
      { conversations: [conversation("2"), conversation("3")] },
      store,
    );

    await screen.findByText("Ada");
    expect(screen.getByText("333333333333")).toBeInTheDocument();
    expect(screen.queryByText("222222222222")).toBeNull();
  });
});
