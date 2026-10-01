// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SearchPanel } from "../src/components/SearchPanel.js";
import type { ConversationView } from "../src/conversations.js";
import { shortId } from "../src/peer-names.js";
import {
  AssertsSelfName,
  WithNames,
  memoryNameStore,
} from "./names-harness.js";
import { stubMantineJsdomGlobals } from "./jsdom-mantine-polyfills.js";

const DEVICE_ID_HEX_LENGTH = 64;
const PEER = "2".repeat(DEVICE_ID_HEX_LENGTH);

function conversation(text: string): ConversationView {
  return {
    roomPath: `${"1".repeat(DEVICE_ID_HEX_LENGTH)}+${PEER}`,
    participants: [PEER],
    status: "connected",
    via: "direct",
    messages: [
      {
        direction: "received",
        text,
        messageId: new Uint8Array([1]),
        sentAt: 1,
      },
    ],
    notices: [],
    outgoing: [],
    pendingJoinRequest: undefined,
    unread: 0,
  };
}

function renderSearch(
  conversations: readonly ConversationView[],
  onSelect: (roomPath: string) => void = () => undefined,
  store = memoryNameStore(),
): void {
  render(
    <WithNames store={store}>
      <SearchPanel conversations={conversations} onSelect={onSelect} />
    </WithNames>,
  );
}

function search(query: string): void {
  fireEvent.change(screen.getByLabelText("Search conversations and notices"), {
    target: { value: query },
  });
}

describe("SearchPanel", () => {
  beforeEach(() => {
    stubMantineJsdomGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders nothing while there are no conversations to search", () => {
    renderSearch([]);

    expect(screen.queryByTestId("search-panel")).not.toBeInTheDocument();
  });

  it("lists no results for a blank query", () => {
    renderSearch([conversation("lunch at the harbour")]);

    expect(screen.queryByText(/lunch/)).toBeNull();
    expect(screen.queryByText("Nothing matches.")).toBeNull();
  });

  it("shows a matching message with its kind and the peer's petname, and opens its conversation on click", async () => {
    const store = memoryNameStore();
    await store.setPetname(PEER, "Ada");
    const onSelect = vi.fn<(roomPath: string) => void>();
    const view = conversation("lunch at the harbour");
    renderSearch([view], onSelect, store);

    search("harbour");

    const result = await screen.findByText("harbour", { selector: "mark" });
    expect(screen.getByText("message")).toBeInTheDocument();
    expect(screen.getByText(/^Ada/)).toBeInTheDocument();

    fireEvent.click(result);

    expect(onSelect).toHaveBeenCalledWith(view.roomPath);
  });

  it("shows the short id beside a name the peer chose for itself, so a stranger cannot pass as someone else", async () => {
    render(
      <WithNames>
        <AssertsSelfName deviceHex={PEER} selfName="Support" />
        <SearchPanel
          conversations={[conversation("lunch at the harbour")]}
          onSelect={() => undefined}
        />
      </WithNames>,
    );

    search("harbour");

    expect(
      await screen.findByText(`Support (${shortId(PEER)})`, { exact: false }),
    ).toBeInTheDocument();
  });

  it("says when nothing matches", () => {
    renderSearch([conversation("lunch at the harbour")]);

    search("zebra");

    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });
});
