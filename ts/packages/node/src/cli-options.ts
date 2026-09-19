// The CLI's command-line surface, defined once: FLAGS drives the parser, the --help text, and (through a test that requires the README to reproduce helpText() verbatim) the README's flag documentation, so none of the three can drift from the others.

import { parseArgs } from "node:util";

/** The address the server binds when --bind is not given. */
export const DEFAULT_BIND_ADDRESS = "0.0.0.0:8787";

const MAX_PORT = 65_535;

interface FlagDefinition {
  readonly type: "boolean" | "string";
  readonly short?: string;
  /** How the flag's value is named in usage output; present exactly for `type: "string"` flags. */
  readonly valueName?: string;
  readonly default?: string;
  readonly description: string;
}

/** Every flag the CLI accepts, keyed by its long name (without the leading dashes). */
export const FLAGS = {
  bind: {
    type: "string",
    valueName: "host:port",
    default: DEFAULT_BIND_ADDRESS,
    description:
      "Address to listen on. Port 0 asks the OS for a free port. Use 127.0.0.1:8787 to accept local connections only.",
  },
  "tls-cert": {
    type: "string",
    valueName: "path",
    description:
      "PEM certificate file, to serve wss:// and https://. Requires --tls-key.",
  },
  "tls-key": {
    type: "string",
    valueName: "path",
    description: "PEM private key file for --tls-cert. Requires --tls-cert.",
  },
  help: {
    type: "boolean",
    short: "h",
    description: "Print this help and exit.",
  },
  version: {
    type: "boolean",
    short: "v",
    description: "Print the version and exit.",
  },
} as const satisfies Record<string, FlagDefinition>;

export interface TlsFilePaths {
  certPath: string;
  keyPath: string;
}

/** What the arguments ask the CLI to do. */
export type CliCommand =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "serve"; bindAddress: string; tls: TlsFilePaths | undefined };

/** Thrown for arguments the CLI cannot act on; the message names the offending flag and is fit to print as-is. */
export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
}

function usageLabelOf(name: string, definition: FlagDefinition): string {
  const long = `--${name}${definition.valueName === undefined ? "" : ` <${definition.valueName}>`}`;
  return definition.short === undefined
    ? `    ${long}`
    : `-${definition.short}, ${long}`;
}

/** The usage text printed for --help, generated from FLAGS. */
export function helpText(): string {
  const rows = Object.entries<FlagDefinition>(FLAGS).map(
    ([name, definition]) => ({
      label: usageLabelOf(name, definition),
      description:
        definition.default === undefined
          ? definition.description
          : `${definition.description} (default: ${definition.default})`,
    }),
  );
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  return [
    "Usage: wire-mesh [options]",
    "",
    "Options:",
    ...rows.map(
      (row) => `  ${row.label.padEnd(labelWidth)}  ${row.description}`,
    ),
  ].join("\n");
}

function validatedBindAddress(address: string): string {
  const separator = address.lastIndexOf(":");
  const host = address.slice(0, separator);
  const port = address.slice(separator + 1);
  if (
    separator === -1 ||
    host === "" ||
    !/^\d+$/.test(port) ||
    Number(port) > MAX_PORT
  ) {
    throw new CliUsageError(
      `--bind expects host:port with a port from 0 to ${String(MAX_PORT)}, got "${address}"`,
    );
  }
  return address;
}

/** Parses the process arguments (without the node and script entries) into the command they ask for. Throws CliUsageError for an unknown flag, a stray positional argument, a flag missing or given an unwanted value, a malformed --bind address, or --tls-cert without --tls-key (or the reverse). */
export function parseCliArguments(argv: readonly string[]): CliCommand {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: FLAGS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    if (error instanceof Error) {
      throw new CliUsageError(error.message, { cause: error });
    }
    throw error;
  }

  if (values.help === true) {
    return { kind: "help" };
  }
  if (values.version === true) {
    return { kind: "version" };
  }

  const certPath = values["tls-cert"];
  const keyPath = values["tls-key"];
  if ((certPath === undefined) !== (keyPath === undefined)) {
    throw new CliUsageError("--tls-cert and --tls-key must be given together");
  }
  return {
    kind: "serve",
    bindAddress: validatedBindAddress(values.bind),
    tls:
      certPath === undefined || keyPath === undefined
        ? undefined
        : { certPath, keyPath },
  };
}
