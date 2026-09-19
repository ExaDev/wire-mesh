import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CliUsageError,
  DEFAULT_BIND_ADDRESS,
  FLAGS,
  helpText,
  parseCliArguments,
} from "../src/cli-options.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("parseCliArguments", () => {
  it("serves on the default bind address, without TLS, when given no arguments", () => {
    expect(parseCliArguments([])).toEqual({
      kind: "serve",
      bindAddress: DEFAULT_BIND_ADDRESS,
      tls: undefined,
    });
  });

  it("uses the value following --bind", () => {
    expect(parseCliArguments(["--bind", "127.0.0.1:9000"])).toMatchObject({
      kind: "serve",
      bindAddress: "127.0.0.1:9000",
    });
  });

  it("accepts --bind=value as well as --bind value", () => {
    expect(parseCliArguments(["--bind=127.0.0.1:9000"])).toMatchObject({
      kind: "serve",
      bindAddress: "127.0.0.1:9000",
    });
  });

  it("accepts port 0, which asks the OS for a free port", () => {
    expect(parseCliArguments(["--bind", "127.0.0.1:0"])).toMatchObject({
      bindAddress: "127.0.0.1:0",
    });
  });

  it("returns both paths when --tls-cert and --tls-key are both given", () => {
    expect(
      parseCliArguments(["--tls-cert", "cert.pem", "--tls-key", "key.pem"]),
    ).toMatchObject({
      kind: "serve",
      tls: { certPath: "cert.pem", keyPath: "key.pem" },
    });
  });

  it.each([["--help"], ["-h"]])("returns the help command for %s", (flag) => {
    expect(parseCliArguments([flag])).toEqual({ kind: "help" });
  });

  it.each([["--version"], ["-v"]])(
    "returns the version command for %s",
    (flag) => {
      expect(parseCliArguments([flag])).toEqual({ kind: "version" });
    },
  );

  it("prefers help over a valid flag given alongside it", () => {
    expect(parseCliArguments(["--bind", "127.0.0.1:1", "--help"])).toEqual({
      kind: "help",
    });
  });
});

describe("parseCliArguments rejecting bad input", () => {
  function usageErrorOf(argv: readonly string[]): CliUsageError {
    try {
      parseCliArguments(argv);
    } catch (error) {
      if (error instanceof CliUsageError) {
        return error;
      }
      throw error;
    }
    throw new Error(`expected ${JSON.stringify(argv)} to be rejected`);
  }

  it("names an unknown long flag", () => {
    expect(usageErrorOf(["--bogus"]).message).toContain("--bogus");
  });

  it("names an unknown short flag", () => {
    expect(usageErrorOf(["-x"]).message).toContain("-x");
  });

  it("rejects a positional argument, naming it", () => {
    expect(usageErrorOf(["stray"]).message).toContain("stray");
  });

  it.each([["--bind"], ["--tls-cert"], ["--tls-key"]])(
    "names %s when it is the last argument with no value",
    (flag) => {
      expect(usageErrorOf([flag]).message).toContain(flag);
    },
  );

  it("names --bind when the next argument is another flag rather than its value", () => {
    expect(usageErrorOf(["--bind", "--help"]).message).toContain("--bind");
  });

  it("rejects a value given to a flag that takes none", () => {
    expect(usageErrorOf(["--help=yes"]).message).toContain("--help");
  });

  it.each([
    ["no port", "localhost"],
    ["an empty host", ":8787"],
    ["a non-numeric port", "localhost:http"],
    ["a port above 65535", "localhost:65536"],
    ["a negative port", "localhost:-1"],
    ["a fractional port", "localhost:80.5"],
  ])(
    "rejects a --bind value with %s, naming --bind and the value",
    (_, value) => {
      const message = usageErrorOf(["--bind", value]).message;
      expect(message).toContain("--bind");
      expect(message).toContain(value);
    },
  );

  it("rejects --tls-cert without --tls-key", () => {
    expect(usageErrorOf(["--tls-cert", "cert.pem"]).message).toContain(
      "--tls-cert and --tls-key must be given together",
    );
  });

  it("rejects --tls-key without --tls-cert", () => {
    expect(usageErrorOf(["--tls-key", "key.pem"]).message).toContain(
      "--tls-cert and --tls-key must be given together",
    );
  });
});

describe("helpText", () => {
  it("lists every flag in the definition table, long and short forms, with its description", () => {
    const text = helpText();
    for (const [name, definition] of Object.entries(FLAGS)) {
      expect(text).toContain(`--${name}`);
      expect(text).toContain(definition.description);
      if ("short" in definition) {
        expect(text).toContain(`-${definition.short}`);
      }
    }
  });

  it("states the default of every flag that has one", () => {
    expect(helpText()).toContain(`(default: ${DEFAULT_BIND_ADDRESS})`);
  });

  it("is reproduced verbatim in the README, so the documented flags cannot drift from the parser", () => {
    const readme = readFileSync(join(PACKAGE_ROOT, "README.md"), "utf-8");
    expect(readme).toContain(helpText());
  });
});
