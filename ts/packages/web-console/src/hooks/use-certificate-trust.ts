// The trust moments for WebTransport nodes: a first-use confirmation before a node's certificate is pinned, a warning before an address that presents a different certificate than the remembered one is dialled, and a notice when a connected node announces certificates unrelated to the remembered ones. Each confirmation is a promise the dialling code awaits, settled by the user's click.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CertificateMemory } from "../certificate-memory.js";
import { bytesToHex } from "wire-mesh-core/domain/device-id";
import { withPinnedHashes } from "wire-mesh-core/domain/pinned-address";
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
}

export interface CertificateTrust {
  prompts: readonly TrustPrompt[];
  changes: readonly NodeCertificateChange[];
  /** The memory the dial transport must use, so a change a node announces is reported. */
  memory: CertificateMemory;
  /**
   * The address the console may dial in place of `address`, or undefined when the user refused it. An address with no usable certificate pins is dialled as it is. One that presents a remembered certificate is dialled with only the presented certificates that are remembered, so an address cannot add a pin of its own beside one the console already trusts. Otherwise this waits for the user: trusting records the presented certificates as the ones to expect. A second request presenting the same certificates for a node whose decision is already pending shares that decision instead of asking again, and every pending decision is refused when the console closes.
   */
  confirmAddress: (address: string) => Promise<string | undefined>;
  dismissChange: (key: string) => void;
}

export function useCertificateTrust(
  memory: Readonly<CertificateMemory>,
): CertificateTrust {
  const [prompts, setPrompts] = useState<readonly TrustPrompt[]>([]);
  const [changes, setChanges] = useState<readonly NodeCertificateChange[]>([]);

  const observed = useMemo(
    () =>
      observeCertificateChanges(memory, (change) => {
        setChanges((current) => [
          ...current,
          { ...change, key: crypto.randomUUID() },
        ]);
      }),
    [memory],
  );

  // One pending decision per node and presented certificate set, shared by every request for exactly that until the user answers. A request presenting other certificates for the node is a different question and gets its own prompt.
  const pending = useRef(
    new Map<string, { promptKey: string; decision: Promise<boolean> }>(),
  );
  const refusals = useRef(
    new Map<string, { promptKey: string; refuse: () => void }>(),
  );
  useEffect(() => {
    const open = refusals.current;
    return () => {
      for (const { refuse } of [...open.values()]) {
        refuse();
      }
    };
  }, []);

  const askUser = useCallback(
    async (
      assessment: Exclude<CertificateAssessment, { kind: "known" }>,
    ): Promise<boolean> => {
      const question = `${assessment.node} ${[...assessment.presented].sort().join(",")}`;
      const existing = pending.current.get(question);
      if (existing !== undefined) {
        return existing.decision;
      }
      const key = crypto.randomUUID();
      const decision = new Promise<boolean>((resolve) => {
        let settled = false;
        // A later prompt for the same question owns the map entries by then, so a settled one must leave them alone and answer only once.
        const decide = (answer: boolean): void => {
          if (settled) return;
          settled = true;
          if (refusals.current.get(question)?.promptKey === key) {
            refusals.current.delete(question);
          }
          if (pending.current.get(question)?.promptKey === key) {
            pending.current.delete(question);
          }
          setPrompts((current) =>
            current.filter((prompt) => prompt.key !== key),
          );
          resolve(answer);
        };
        refusals.current.set(question, {
          promptKey: key,
          refuse: () => {
            decide(false);
          },
        });
        setPrompts((current) => [...current, { key, assessment, decide }]);
      });
      pending.current.set(question, { promptKey: key, decision });
      return decision;
    },
    [],
  );

  const confirmAddress = useCallback(
    async (address: string): Promise<string | undefined> => {
      const presented = presentedCertificates(address);
      if (presented === undefined) {
        return address;
      }
      const assessment = assessCertificates(
        presented.node,
        presented.sha256.map((hash) => bytesToHex(hash)),
        (await memory.recall(presented.node)).map((hash) => bytesToHex(hash)),
      );
      if (assessment.kind === "known") {
        return withPinnedHashes(
          address,
          presented.sha256.filter((hash) =>
            assessment.trusted.includes(bytesToHex(hash)),
          ),
        );
      }
      if (!(await askUser(assessment))) {
        return undefined;
      }
      await memory.remember(presented.node, presented.sha256);
      return address;
    },
    [memory, askUser],
  );

  const dismissChange = useCallback((key: string): void => {
    setChanges((current) => current.filter((change) => change.key !== key));
  }, []);

  return {
    prompts,
    changes,
    memory: observed,
    confirmAddress,
    dismissChange,
  };
}
