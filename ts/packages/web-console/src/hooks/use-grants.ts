// The grants panel's state and actions: every recorded grant with its current status, refreshed whenever a grant or revocation is recorded and on an interval so expiry shows; and minting, importing and revoking, each through core's own domain modules.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { RevocationEntry } from "wire-mesh-core/generated/protocol";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { IdentityPort } from "wire-mesh-core/ports/identity";
import type { GrantRecord, GrantStore } from "../grant-store.js";
import {
  decodeGrantCode,
  describeGrantStatus,
  encodeGrantCode,
  grantStatus,
} from "../grants.js";
import type { GrantStatus } from "../grants.js";
import { mintGrant } from "../mint-grant.js";
import type { MintGrantInput } from "../mint-grant.js";
import type { RevocationStore } from "../revocation-store.js";

/** How often every grant's status is judged again, so a grant that has expired since the last change stops reading as valid. */
const STATUS_REFRESH_MS = 30_000;

export interface GrantRow extends GrantRecord {
  status: GrantStatus;
}

/** The outcome of a form action: nothing to report on success beyond what it adds, or the reason it was refused. */
export type GrantActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: string };

/** How many connected nodes a revocation was sent to, out of how many connections were open. */
export interface AnnounceResult {
  attempted: number;
  reached: number;
}

export interface GrantsApi {
  rows: readonly GrantRow[];
  /** Why the recorded grants could not be read, for the person to see; the rows are then the last ones that loaded. */
  loadError: string | undefined;
  /** Mints a grant, records it as issued, and returns its grant code. */
  mint: (
    input: Readonly<MintGrantInput>,
  ) => Promise<GrantActionResult<{ code: string }>>;
  /** Records a pasted grant code as held, if it names this device and still holds. */
  importCode: (code: string) => Promise<GrantActionResult>;
  /** Revokes a grant this device issued and announces the revocation, reporting how many nodes were told. A failure to record the revocation is reported as a refusal; one to announce it is not, since it is recorded here either way. */
  revoke: (
    row: Readonly<GrantRow>,
  ) => Promise<GrantActionResult<{ announced: AnnounceResult }>>;
}

export interface UseGrantsOptions {
  identity: IdentityPort;
  clock: Clock;
  grants: GrantStore;
  revocations: RevocationStore;
  /** Tells every connected node about a revocation this device just made. */
  announce: (entry: RevocationEntry) => Promise<AnnounceResult>;
}

export function useGrants(options: Readonly<UseGrantsOptions>): GrantsApi {
  const { identity, clock, grants, revocations, announce } = options;
  const [rows, setRows] = useState<readonly GrantRow[]>([]);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const lifecycle = { cancelled: false, latestLoad: 0 };
    const load = async (): Promise<void> => {
      // Loads overlap (store events and the interval), and an older one can settle after a newer one. Only the most recently started may set the rows, or a just-revoked grant could be shown as valid again.
      lifecycle.latestLoad += 1;
      const thisLoad = lifecycle.latestLoad;
      const records = await grants.list();
      const judged = await Promise.all(
        records.map(async (record) => ({
          ...record,
          status: await grantStatus(record.token, {
            identity,
            clock,
            revocation: revocations.view,
            // A held grant is only good for this device. After an identity restore, grants held by the old device read as naming another bearer.
            ...(record.direction === "held"
              ? { expectedBearer: identity.deviceId }
              : {}),
          }),
        })),
      );
      if (!lifecycle.cancelled && thisLoad === lifecycle.latestLoad) {
        setRows(judged);
        setLoadError(undefined);
      }
    };
    const reload = (): void => {
      load().catch((error: unknown) => {
        if (!lifecycle.cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    };
    reload();
    const stops = [grants.subscribe(reload), revocations.subscribe(reload)];
    const timer = setInterval(reload, STATUS_REFRESH_MS);

    return () => {
      lifecycle.cancelled = true;
      clearInterval(timer);
      for (const stop of stops) stop();
    };
  }, [identity, clock, grants, revocations]);

  const mint = useCallback(
    async (input: Readonly<MintGrantInput>) => {
      const minted = await mintGrant(input, { identity, clock });
      if (!minted.ok) {
        return minted;
      }
      await grants.record("issued", minted.token, clock.now());

      return { ok: true as const, code: encodeGrantCode(minted.token) };
    },
    [identity, clock, grants],
  );

  const importCode = useCallback(
    async (code: string): Promise<GrantActionResult> => {
      let token;
      try {
        token = decodeGrantCode(code);
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const status = await grantStatus(token, {
        identity,
        clock,
        revocation: revocations.view,
        expectedBearer: identity.deviceId,
      });
      if (status.kind === "invalid") {
        return {
          ok: false,
          error: `this device cannot hold that grant: ${describeGrantStatus(status)}`,
        };
      }
      await grants.record("held", token, clock.now());

      return { ok: true };
    },
    [identity, clock, grants, revocations],
  );

  const revoke = useCallback(
    async (
      row: Readonly<GrantRow>,
    ): Promise<GrantActionResult<{ announced: AnnounceResult }>> => {
      try {
        const entry = await revocations.revoke(row.claims["token-id"]);

        return { ok: true, announced: await announce(entry) };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [revocations, announce],
  );

  return useMemo(
    () => ({ rows, loadError, mint, importCode, revoke }),
    [rows, loadError, mint, importCode, revoke],
  );
}
