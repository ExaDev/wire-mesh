function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Anchors every `.regexp` pattern in a parsed spec, in place. The CDDL `.regexp` control matches the whole string, and a generated `RegExp` test matches a substring unless anchored, so each string-literal operand becomes `^(?:...)$`: the schema accepts exactly the language the spec states. The non-capturing group keeps a top-level alternation inside both anchors. Throws on an operand that is not a string literal, since it cannot be anchored.
 */
export function anchorRegexpOperators(node: unknown): void {
  if (Array.isArray(node)) {
    for (const element of node) {
      anchorRegexpOperators(element);
    }

    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const operator = node.Operator;
  if (isRecord(operator) && operator.Type === "regexp") {
    const operand = operator.Value;
    if (
      !isRecord(operand) ||
      operand.Type !== "literal" ||
      typeof operand.Value !== "string"
    ) {
      throw new Error(
        "a .regexp operand that is not a string literal cannot be anchored",
      );
    }
    operand.Value = `^(?:${operand.Value})$`;
  }
  for (const value of Object.values(node)) {
    anchorRegexpOperators(value);
  }
}
