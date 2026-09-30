// Search across every conversation's messages and notices. The conversation state already holds the message history restored from the IndexedDB message store and every message that has arrived since, plus the notices each conversation's board has read, so searching it covers stored and live content alike with no second scan of storage. Pure, so matching and ordering can be tested without a UI.

import type { ConversationView } from "./conversations.js";

/** The most results returned. The list is rendered whole, so an unbounded one would make a one-letter query lay out the entire history. */
export const MAX_SEARCH_RESULTS = 50;

export interface SearchResult {
  /** Unique across results: the room path, the kind and the position within that conversation's list. */
  key: string;
  roomPath: string;
  kind: "message" | "notice";
  /** The text that matched. */
  text: string;
  /** When it was sent or posted, in milliseconds since the epoch. */
  at: number;
  /** For a message, whether this console sent it. A notice has no direction. */
  direction: "sent" | "received" | undefined;
}

/** The lowercase, non-empty whitespace-separated terms of a query. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");
}

function matches(text: string, terms: readonly string[]): boolean {
  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * The messages and readable notices containing every term of `query` (case-insensitively, in any order), newest first, at most MAX_SEARCH_RESULTS. A notice this console cannot decrypt has no text and never matches. A blank query matches nothing.
 */
export function searchConversations(
  conversations: readonly ConversationView[],
  query: string,
): SearchResult[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [];
  }
  const decoder = new TextDecoder();
  const results: SearchResult[] = [];
  for (const conversation of conversations) {
    conversation.messages.forEach((message, index) => {
      if (matches(message.text, terms)) {
        results.push({
          key: `${conversation.roomPath}/message/${String(index)}`,
          roomPath: conversation.roomPath,
          kind: "message",
          text: message.text,
          at: message.sentAt,
          direction: message.direction,
        });
      }
    });
    conversation.notices.forEach((notice, index) => {
      if (notice.plaintext === undefined || notice.claims === undefined) {
        return;
      }
      const text = decoder.decode(notice.plaintext);
      if (matches(text, terms)) {
        results.push({
          key: `${conversation.roomPath}/notice/${String(index)}`,
          roomPath: conversation.roomPath,
          kind: "notice",
          text,
          at: notice.claims["posted-at"],
          direction: undefined,
        });
      }
    });
  }
  return results.sort((a, b) => b.at - a.at).slice(0, MAX_SEARCH_RESULTS);
}
