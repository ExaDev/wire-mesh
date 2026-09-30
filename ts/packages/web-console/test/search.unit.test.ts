import { describe, expect, it } from "vitest";
import type { ConversationView } from "../src/conversations.js";
import type { StoredMessage } from "../src/message-store.js";
import { deviceIdFromFillHex } from "./hex.js";
import { syntheticAdvertProof } from "./synthetic-advert.js";
import {
  MAX_SEARCH_RESULTS,
  queryTerms,
  searchConversations,
} from "../src/search.js";

const DEVICE_ID_HEX_LENGTH = 64;
const OLDEST = 10;
const MIDDLE = 20;
const NEWEST = 30;
const THIRD_MESSAGE = 3;

function message(
  text: string,
  sentAt: number,
  direction: StoredMessage["direction"] = "received",
): StoredMessage {
  return { direction, text, messageId: new Uint8Array([sentAt]), sentAt };
}

function conversation(
  digit: string,
  overrides: Partial<ConversationView> = {},
): ConversationView {
  const peer = digit.repeat(DEVICE_ID_HEX_LENGTH);
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

/** A verified notice entry whose claims are well-formed but carry filler for everything the search does not read. */
function notice(
  text: string,
  postedAt: number,
): ConversationView["notices"][number] {
  const content = new TextEncoder().encode(text);
  return {
    verified: true,
    contentType: "text/plain",
    plaintext: content,
    claims: {
      room: conversation("2").roomPath,
      poster: deviceIdFromFillHex("33"),
      "poster-key": syntheticAdvertProof()["identity-key"],
      token: [new Uint8Array(), {}, null, new Uint8Array()],
      "notice-id": new Uint8Array(),
      "posted-at": postedAt,
      "content-type": "text/plain",
      content,
    },
  };
}

describe("queryTerms", () => {
  it("lowercases and splits on whitespace, dropping blanks", () => {
    expect(queryTerms("  Hello   WORLD ")).toEqual(["hello", "world"]);
    expect(queryTerms("   ")).toEqual([]);
  });
});

describe("searchConversations", () => {
  it("finds messages containing every term, in any case and order", () => {
    const results = searchConversations(
      [
        conversation("2", {
          messages: [
            message("Lunch at the harbour", 1),
            message("harbour closed", 2),
            message("nothing here", THIRD_MESSAGE),
          ],
        }),
      ],
      "HARBOUR lunch",
    );

    expect(results.map((result) => result.text)).toEqual([
      "Lunch at the harbour",
    ]);
  });

  it("searches messages and readable notices together, newest first, and says which is which", () => {
    const first = conversation("2", {
      messages: [message("deploy notes", OLDEST)],
      notices: [notice("deploy window agreed", NEWEST)],
    });
    const second = conversation("3", {
      messages: [message("deploy done", MIDDLE)],
    });

    const results = searchConversations([first, second], "deploy");

    expect(
      results.map((result) => [result.kind, result.text, result.roomPath]),
    ).toEqual([
      ["notice", "deploy window agreed", first.roomPath],
      ["message", "deploy done", second.roomPath],
      ["message", "deploy notes", first.roomPath],
    ]);
  });

  it("reports whether a matching message was sent or received", () => {
    const [sent] = searchConversations(
      [conversation("2", { messages: [message("ping", 1, "sent")] })],
      "ping",
    );

    expect(sent?.direction).toBe("sent");
  });

  it("never matches a notice this console cannot decrypt, nor a blank query", () => {
    const unreadable: ConversationView["notices"][number] = { verified: true };
    const conversations = [
      conversation("2", {
        messages: [message("hello", 1)],
        notices: [unreadable],
      }),
    ];

    expect(searchConversations(conversations, "hello")).toHaveLength(1);
    expect(searchConversations(conversations, "   ")).toEqual([]);
  });

  it("gives each result a distinct key and caps how many it returns", () => {
    const messages = Array.from(
      { length: MAX_SEARCH_RESULTS + 1 },
      (_, index) => message("match", index),
    );

    const results = searchConversations(
      [conversation("2", { messages })],
      "match",
    );

    expect(results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(new Set(results.map((result) => result.key)).size).toBe(
      MAX_SEARCH_RESULTS,
    );
  });
});
