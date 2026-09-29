// The ICE servers every peer connection this console makes is configured with, in one place so the offering and answering sides cannot disagree. Two peers on the same network connect over host candidates alone; STUN is what lets a direct connection also form across NATs, by telling each device the public address its traffic appears to come from.
//
// Cloudflare runs a public STUN service that its documentation describes as free and unlimited (https://developers.cloudflare.com/realtime/turn/faq/, service address and ports at https://developers.cloudflare.com/realtime/turn/). A STUN server learns the public address of each device that asks it, and nothing about what the connection carries. There is deliberately no TURN server: when no direct path exists the conversation falls back to the hub relay instead of a second relay service.

export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];
