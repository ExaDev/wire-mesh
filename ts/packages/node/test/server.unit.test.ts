import { describe, expect, it } from "vitest";
import { bindAddressFromArgs, tlsFromArgs } from "../src/server.js";

describe("bindAddressFromArgs", () => {
  it("falls back to 0.0.0.0:8787 when no --bind flag is given", () => {
    expect(bindAddressFromArgs([])).toBe("0.0.0.0:8787");
  });

  it("uses the value following --bind when given", () => {
    expect(bindAddressFromArgs(["--bind", "127.0.0.1:9000"])).toBe(
      "127.0.0.1:9000",
    );
  });

  it("falls back to the default when --bind is the last argument with no value", () => {
    expect(bindAddressFromArgs(["--bind"])).toBe("0.0.0.0:8787");
  });
});

describe("tlsFromArgs", () => {
  it("returns undefined when neither --tls-cert nor --tls-key is given", () => {
    expect(tlsFromArgs([])).toBeUndefined();
  });

  it("returns both paths when --tls-cert and --tls-key are both given", () => {
    expect(
      tlsFromArgs(["--tls-cert", "cert.pem", "--tls-key", "key.pem"]),
    ).toEqual({ certPath: "cert.pem", keyPath: "key.pem" });
  });

  it("throws when only --tls-cert is given", () => {
    expect(() => tlsFromArgs(["--tls-cert", "cert.pem"])).toThrow(
      "--tls-cert and --tls-key must be given together",
    );
  });

  it("throws when only --tls-key is given", () => {
    expect(() => tlsFromArgs(["--tls-key", "key.pem"])).toThrow(
      "--tls-cert and --tls-key must be given together",
    );
  });
});
