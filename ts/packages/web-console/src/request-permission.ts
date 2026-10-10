// Choosing the request permission to present with a capability request (wire-mesh#324): a receiver that gates requests wants a valid manage:request token naming this device, covering the capability and scope being asked for. The console holds whatever it was granted; this picks one that fits, judging validity afresh, and presents nothing when none does, which is exactly what a receiver that does not gate expects.

import type {
  CapabilityScope,
  CapabilityToken,
} from "wire-mesh-core/generated/protocol";
import { MANAGE_REQUEST_CAPABILITY } from "wire-mesh-core/domain/capability-request";
import { CapabilityRequestRefusedError } from "wire-mesh-core/domain/capability-request";
import type { VerifyCapabilityTokenOptions } from "wire-mesh-core/domain/tokens";
import { scopeNarrows } from "wire-mesh-core/domain/token-scope";
import type { GrantStore } from "./grant-store.js";
import { grantStatus } from "./grants.js";

/**
 * The first held manage:request this device can present for `capability` over `scope`, or undefined when it holds none that is valid now and covers the ask. A token naming a different verb, or a scope that does not contain the requested one, is skipped rather than presented to be refused.
 */
export async function heldRequestToken(
  grants: Readonly<Pick<GrantStore, "list">>,
  verification: Readonly<VerifyCapabilityTokenOptions>,
  capability: string,
  scope: Readonly<CapabilityScope>,
): Promise<CapabilityToken | undefined> {
  const candidates = (await grants.list()).filter((record) => {
    const claims = record.claims;
    if (
      record.direction !== "held" ||
      claims.capability !== MANAGE_REQUEST_CAPABILITY
    ) {
      return false;
    }
    const covered = claims["requests-capability"];
    if (covered !== undefined && covered !== capability) return false;

    return scopeNarrows(claims.scope, scope);
  });
  // In order, stopping at the first valid candidate: later ones are never judged.
  const firstValid = async (
    remaining: readonly (typeof candidates)[number][],
  ): Promise<CapabilityToken | undefined> => {
    const [record, ...rest] = remaining;
    if (record === undefined) return undefined;
    const status = await grantStatus(record.token, verification);

    return status.kind === "valid" ? record.token : firstValid(rest);
  };

  return firstValid(candidates);
}

/** What a refusal of a capability request means to the person, telling a receiver's policy (it gates requests and this one did not qualify) apart from a person's no. */
export function describeRequestRefusal(error: unknown): string | undefined {
  if (!(error instanceof CapabilityRequestRefusedError)) return undefined;
  switch (error.code) {
    case "denied":
      return "the other side denied the request";
    case "token_required":
      return "the other side only accepts requests that present a request permission, and this device holds none that covers this one";
    case "capability_mismatch":
      return "the request permission presented does not cover this capability";
    case "scope_mismatch":
      return "the request permission presented does not cover this conversation";
    default:
      return `the request permission presented was refused (${error.code})`;
  }
}
