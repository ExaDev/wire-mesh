import { describe, expect, it } from "vitest";
import { anchorRegexpOperators } from "../scripts/anchor-regexp-operators.ts";

function ruleWithPattern(pattern: unknown): Record<string, unknown> {
  return {
    Type: "variable",
    Properties: {
      Value: {
        Type: "tstr",
        Operator: {
          Type: "regexp",
          Value: { Type: "literal", Value: pattern },
        },
      },
    },
  };
}

const NOT_A_STRING = 42;

describe("anchorRegexpOperators", () => {
  it("wraps each string-literal .regexp operand, wherever it sits in the tree, as a whole-string match", () => {
    const tree = [
      ruleWithPattern("a|b"),
      { nested: [ruleWithPattern("[0-9]+")] },
    ];

    anchorRegexpOperators(tree);

    expect(JSON.stringify(tree)).toContain('"Value":"^(?:a|b)$"');
    expect(JSON.stringify(tree)).toContain('"Value":"^(?:[0-9]+)$"');
  });

  it("makes the alternation a whole-string alternation", () => {
    const tree = ruleWithPattern("a|b");
    anchorRegexpOperators(tree);
    const operand =
      /"Value":"(\^\(\?:a\|b\)\$)"/.exec(JSON.stringify(tree))?.[1] ?? "";
    const regex = new RegExp(operand);

    expect(regex.test("a")).toBe(true);
    expect(regex.test("ab")).toBe(false);
    expect(regex.test("xb")).toBe(false);
  });

  it("leaves a control that is not .regexp alone", () => {
    const SIZE = 4;
    const tree = {
      Operator: { Type: "size", Value: { Type: "literal", Value: SIZE } },
    };

    anchorRegexpOperators(tree);

    expect(tree.Operator.Value.Value).toBe(SIZE);
  });

  it("refuses a .regexp operand that is not a string literal, since it cannot be anchored", () => {
    expect(() => {
      anchorRegexpOperators(ruleWithPattern(NOT_A_STRING));
    }).toThrow(/cannot be anchored/);
    expect(() => {
      anchorRegexpOperators({
        Operator: {
          Type: "regexp",
          Value: { Type: "group", Value: "other-rule" },
        },
      });
    }).toThrow(/cannot be anchored/);
  });
});
