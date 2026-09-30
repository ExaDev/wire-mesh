// The trust moments for WebTransport nodes: a first-use confirmation before a node's certificate is pinned, a warning before an address that presents a different certificate than the remembered one is dialled, and a notice when a connected node announces certificates unrelated to the remembered ones. Each confirmation is a promise the dialling code awaits, settled by the user's click.

import { useCallback, useMemo, useState } from "react";
import type { Clock } from "wire-mesh-core/ports/clock";
import type { CertificateMemory } from "../certificate-memory.js";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import {
  assessCertificates,
  observeCertificateChanges,
  presentedCertificates,
} from "../certificate-trust.js";
import type {
  CertificateAssessment,
  CertificateChange,
} from "../certificate-trust.js";

/** A decision waiting on the user: the assessment to show, and the promise the dial is waiting on. */
export interface TrustPrompt {
  key: string;
  assessment: Exclude<CertificateAssessment, { kind: "known" }>;
  decide: (trusted: boolean) => void;
}

export interface NodeCertificateChange extends CertificateChange {
  key: string;
  /** When the change was announced, from the injected clock. */
  at: number;
  /** Whether the user has dismissed the alert. The change stays in the connection's activity. */
  dismissed: boolean;
}

export interface CertificateTrust {
  prompts: readonly TrustPrompt[];
  changes: readonly NodeCertificateChange[];
  /** The memory the dial transport must use, so a change a node announces is reported. */
  memory: CertificateMemory;
  /**
   * Whether the console may dial `address`. An address with no usable certificate pins, or one whose certificates are already remembered, is allowed at once. Otherwise this waits for the user: trusting records the presented certificates as the ones to expect.
   */
  confirmAddress: (address: string) => Promise<boolean>;
  dismissChange: (key: string) => void;
}

export function useCertificateTrust(
  memory: Readonly<CertificateMemory>,
  clock: Readonly<Clock>,
): CertificateTrust {
  const [prompts, setPrompts] = useState<readonly TrustPrompt[]>([]);
  const [changes, setChanges] = useState<readonly NodeCertificateChange[]>([]);

  const observed = useMemo(
    () =>
      observeCertificateChanges(memory, (change) => {
        setChanges((current) => [
          ...current,
          {
            ...change,
            key: crypto.randomUUID(),
            at: clock.now(),
            dismissed: false,
          },
        ]);
      }),
    [memory, clock],
  );

  const confirmAddress = useCallback(
    async (address: string): Promise<boolean> => {
      const presented = presentedCertificates(address);
      if (presented === undefined) {
        return true;
      }
      const assessment = assessCertificates(
        presented.node,
        presented.sha256.map((hash) => bytesToHex(hash)),
        (await memory.recall(presented.node)).map((hash) => bytesToHex(hash)),
      );
      if (assessment.kind === "known") {
        return true;
      }
      const trusted = await new Promise<boolean>((resolve) => {
        const key = crypto.randomUUID();
        setPrompts((current) => [
          ...current,
          {
            key,
            assessment,
            decide: (answer) => {
              setPrompts((pending) =>
                pending.filter((prompt) => prompt.key !== key),
              );
              resolve(answer);
            },
          },
        ]);
      });
      if (trusted) {
        await memory.remember(presented.node, presented.sha256);
      }
      return trusted;
    },
    [memory],
  );

  const dismissChange = useCallback((key: string): void => {
    setChanges((current) =>
      current.map((change) =>
        change.key === key ? { ...change, dismissed: true } : change,
      ),
    );
  }, []);

  return {
    prompts,
    changes,
    memory: observed,
    confirmAddress,
    dismissChange,
  };
}
