// A peer's name as plain inline text (a self-asserted name with its short id beside it), for sentences and messages where PeerLabel's copy and rename controls would be out of place.

import { usePeerNames } from "../hooks/use-peer-names.js";
import { labelText } from "../peer-names.js";

export interface PeerNameProps {
  deviceHex: string;
}

export function PeerName({
  deviceHex,
}: Readonly<PeerNameProps>): React.JSX.Element {
  return <>{labelText(usePeerNames().labelOf(deviceHex))}</>;
}
