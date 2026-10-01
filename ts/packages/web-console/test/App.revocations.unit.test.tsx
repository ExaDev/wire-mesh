// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import {
  decodeMessage,
  messageFromFrame,
} from "wire-mesh-core/adapters/frame-codec";
import { deviceIdToHex } from "wire-mesh-core/domain/device-id";
import { mintRevocationEntry } from "wire-mesh-core/domain/tokens";
import {
  WEBRTC_SIGNAL_SCOPE,
  buildOfferCommand,
} from "wire-mesh-core/domain/webrtc-signaling";
import { createWebCryptoIdentity } from "../src/adapters/web-crypto-identity.js";
import { decodeGrantClaims } from "../src/grants.js";
import { mintGrant } from "../src/mint-grant.js";
import type { RevocationStore } from "../src/revocation-store.js";
import { mintOfferToken } from "../src/webrtc-negotiation.js";
import {
  appIdentity,
  arrayBuffer,
  connectRoot,
  currentCapabilities,
  fixedClock,
  installAppHarness,
  renderApp,
} from "./app-harness.js";
import type { TestCapabilities } from "./capability-services.js";

const REVOCATION_TOKEN_ID_BYTES = 16;
const OFFER_REQUEST_ID = 7;

installAppHarness();

describe("App revocations", () => {
  it("refuses an incoming offer made under a token this console has revoked", async () => {
    const token = await mintOfferToken(appIdentity(), fixedClock);
    const claims = decodeGrantClaims(token);
    if (claims === undefined) throw new Error("expected readable token claims");
    await currentCapabilities().revocations.ingest(
      await mintRevocationEntry({
        identity: appIdentity(),
        tokenId: claims["token-id"],
        revokedAt: 0,
      }),
    );
    renderApp();
    const rootSocket = await connectRoot();
    const sentBefore = rootSocket.sent.length;

    rootSocket.emitMessage(
      arrayBuffer(
        messageFromFrame({
          type: "manage-request",
          "request-id": OFFER_REQUEST_ID,
          command: buildOfferCommand(1, "v=0"),
          scope: WEBRTC_SIGNAL_SCOPE,
          token,
        }),
      ),
    );

    await vi.waitFor(() => {
      const responses = rootSocket.sent.slice(sentBefore).flatMap((data) => {
        const frame = decodeMessage(data);
        return frame.type === "manage-response" ? [frame] : [];
      });
      expect(responses).toEqual([
        {
          type: "manage-response",
          "request-id": OFFER_REQUEST_ID,
          outcome: { result: "error", code: "unauthorized" },
        },
      ]);
    });
  });

  it("shows a held grant as revoked once its issuer's revocation is announced on a connection", async () => {
    const issuer = await createWebCryptoIdentity();
    const minted = await mintGrant(
      {
        bearerHex: deviceIdToHex(appIdentity().deviceId),
        capability: "room:member",
        scopeKind: "room",
        scopePath: "a-room",
        lifetimeHours: 1,
        delegationsRemaining: undefined,
        parent: undefined,
      },
      { identity: issuer, clock: fixedClock },
    );
    if (!minted.ok) throw new Error(minted.error);
    const claims = decodeGrantClaims(minted.token);
    if (claims === undefined) throw new Error("expected readable token claims");
    await currentCapabilities().grants.record("held", minted.token, 0);
    renderApp();
    const rootSocket = await connectRoot();
    fireEvent.click(screen.getByRole("button", { name: "Grants" }));
    const held = await screen.findByTestId("grants-held");
    await within(held).findByText("valid");

    rootSocket.emitMessage(
      arrayBuffer(
        messageFromFrame({
          type: "revocation-announce",
          entries: [
            await mintRevocationEntry({
              identity: issuer,
              tokenId: claims["token-id"],
              revokedAt: 0,
            }),
          ],
        }),
      ),
    );

    await within(held).findByText("revoked");
  });

  it("reports a revocation a node announced that could not be stored, and still reads the ones after it", async () => {
    const STORAGE_FAILURE = "the origin's storage quota is exhausted";
    const ingest = vi
      .fn<RevocationStore["ingest"]>()
      .mockRejectedValueOnce(new Error(STORAGE_FAILURE))
      .mockResolvedValue({ ok: false, reason: "bad_signature" });
    const capabilities: TestCapabilities = {
      ...currentCapabilities(),
      revocations: { ...currentCapabilities().revocations, ingest },
    };
    renderApp({ capabilities });
    const rootSocket = await connectRoot();
    const entry = await mintRevocationEntry({
      identity: appIdentity(),
      tokenId: new Uint8Array(REVOCATION_TOKEN_ID_BYTES),
      revokedAt: 0,
    });
    const announce = (): void => {
      rootSocket.emitMessage(
        arrayBuffer(
          messageFromFrame({ type: "revocation-announce", entries: [entry] }),
        ),
      );
    };

    announce();
    expect(await screen.findByText(STORAGE_FAILURE)).toBeInTheDocument();
    announce();

    await vi.waitFor(() => {
      expect(ingest).toHaveBeenCalledTimes(2);
    });
  });
});
