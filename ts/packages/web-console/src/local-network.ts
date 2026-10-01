const LOCAL_NETWORK_PERMISSION = "local-network-access";
const IPV4_OCTETS = 4;
const OCTET_MAX = 255;
const BITS_PER_OCTET = 8;
const IPV4_BITS = 32;

/** The IPv4 ranges a browser treats as the local network: private, loopback, link-local and shared (carrier-grade NAT, which Tailscale uses). */
const LOCAL_IPV4_RANGES: readonly string[] = [
  "10.0.0.0/8",
  "127.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
];

function ipv4ToNumber(host: string): number | undefined {
  const parts = host.split(".");
  if (parts.length !== IPV4_OCTETS) {
    return undefined;
  }
  let value = 0;
  for (const part of parts) {
    const octet = /^\d{1,3}$/.test(part) ? Number(part) : NaN;
    if (!(octet <= OCTET_MAX)) {
      return undefined;
    }
    value = value * 2 ** BITS_PER_OCTET + octet;
  }
  return value;
}

function inRange(address: number, range: string): boolean {
  const [base, prefix] = range.split("/");
  const start = ipv4ToNumber(base ?? "");
  const length = Number(prefix);
  if (start === undefined) {
    return false;
  }
  const size = 2 ** (IPV4_BITS - length);
  return Math.floor(address / size) === Math.floor(start / size);
}

/**
 * Whether a browser treats `host` as part of the local network rather than the public internet: the IPv4 ranges above, IPv6 loopback, unique-local and link-local, and names that only resolve locally (`.local` and single-label names).
 */
export function isLocalNetworkHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").toLowerCase();
  const address = ipv4ToNumber(name);
  if (address !== undefined) {
    return LOCAL_IPV4_RANGES.some((range) => inRange(address, range));
  }
  if (name.includes(":")) {
    return name === "::1" || /^f[cd]/.test(name) || /^fe[89ab]/.test(name);
  }
  return name === "localhost" || name.endsWith(".local") || !name.includes(".");
}

/** The host of a dialled address, whatever scheme it carries or lacks. */
function hostOf(address: string): string | undefined {
  try {
    return new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? address : `ws://${address}`,
    ).hostname;
  } catch {
    return undefined;
  }
}

/** The part of `navigator.permissions` this module uses. */
export interface PermissionQuerier {
  query: (
    descriptor: Readonly<{
      name: typeof LOCAL_NETWORK_PERMISSION;
    }>,
  ) => Promise<{ state: string }>;
}

/** Whether `value` is something `Permissions.query` accepts: an object with a string `name`. The browser, not TypeScript's list of permission names, decides whether it knows the permission, and a browser that does not rejects the query. */
function isPermissionDescriptor(value: unknown): value is PermissionDescriptor {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

/** The running browser's permissions, or undefined in one that has none to ask. */
export function browserPermissions(): PermissionQuerier | undefined {
  if (!("permissions" in navigator)) {
    return undefined;
  }
  return {
    query: async (descriptor) => {
      if (!isPermissionDescriptor(descriptor)) {
        throw new TypeError("not a permission descriptor");
      }
      return navigator.permissions.query(descriptor);
    },
  };
}

/**
 * Why a connection to `address` may have failed because the browser blocked it from reaching the local network, or undefined when that is not the explanation.
 *
 * A page served from the public internet that dials a device on the local network needs the user's permission in Chrome, and when the user has said no the connection fails with nothing in JavaScript to say why. The permission itself can be read, so the explanation is only given when the page is on a public host, the address is local, and the browser reports the permission as denied. A browser that does not know the permission throws, and that is treated as no explanation.
 */
export async function explainLocalNetworkBlock(
  address: string,
  pageHost: string,
  permissions: PermissionQuerier | undefined,
): Promise<string | undefined> {
  const target = hostOf(address);
  if (
    target === undefined ||
    !isLocalNetworkHost(target) ||
    isLocalNetworkHost(pageHost) ||
    permissions === undefined
  ) {
    return undefined;
  }
  try {
    const { state } = await permissions.query({
      name: LOCAL_NETWORK_PERMISSION,
    });
    return state === "denied"
      ? `Your browser blocked this page from reaching ${target}, a device on your local network. Allow "Local network access" for this site in the browser's site settings (the icon left of the address), then connect again.`
      : undefined;
  } catch {
    return undefined;
  }
}
