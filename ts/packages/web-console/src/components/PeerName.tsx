// A peer's name as plain inline text, for sentences and messages where PeerLabel's copy and rename controls would be out of place.

import { usePeerNames } from "../hooks/use-peer-names.js";

export interface PeerNameProps {
  deviceHex: string;
}

export function PeerName({
  deviceHex,
}: Readonly<PeerNameProps>): React.JSX.Element {
  return <>{usePeerNames().labelOf(deviceHex).primary}</>;
}
