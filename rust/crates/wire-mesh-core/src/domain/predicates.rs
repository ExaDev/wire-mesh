//! Predicate evaluation for `token-claims.conditions` (wire-mesh#128).
//!
//! This is not a port of trilean's general-purpose evaluator. It covers exactly the subset of
//! trilean's `PredicateNode`/`ExpressionNode` grammar this codebase's own TS side ever
//! constructs: `ts/packages/core/src/domain/token-predicates.ts`'s own comment on
//! `conditionsListSchema` states plainly that every predicate this spec mints is built
//! entirely from `compare` + `delegate` + the literal expression kinds `compare` accepts,
//! never `reference`/`lookup`/`fold`/`some`/`every`, and `conditions` itself is always
//! evaluated as a flat, implicit-AND list -- never a nested boolean tree (`and`/`or`/`not`
//! are legal in trilean's own schema but nothing here ever constructs one).
//!
//! Decoding is deliberately infallible below the outer `bstr` layer: a `PredicateNode`/
//! `ExpressionNode` shape this module does not recognise (a legitimate trilean kind with no
//! Rust support yet (`Unsupported`), or data trilean's schema rejects (`Malformed`)), decodes
//! as a node rather than a hard error, and evaluates to indeterminate. The two are told apart
//! because the TypeScript gives them different refusals: a mint through an authoriser whose
//! conditions hold a malformed node is `authorisation_malformed`, and one that holds a node
//! trilean accepts and this module cannot evaluate is `authorisation_conditions_not_satisfied`. This matches the spec's own verifier-obligation
//! convention (an unrecognised value in an open `kind` discriminator must be refused, never
//! acted on without understanding it) and keeps a newer TS-minted token that uses a node kind
//! Rust doesn't yet support decoding cleanly into a token this verifier correctly refuses,
//! rather than an internal decode error. Only a malformed outer array (the `bstr` isn't valid
//! CDE, or isn't an array at all) is a hard decode error, mirroring how `parent`'s own nested
//! `bstr .cbor` is already handled in `tokens.rs`.
//!
//! Two `delegate` systems are registered, both subject-mode (wire-mesh#323): they resolve
//! only when a subject is supplied (an authorised-by walk evaluating the authoriser's
//! conditions against the minted child's claims) and are indeterminate otherwise.
//! `not`/`and`/`or` decode and evaluate under strict Kleene semantics, since the named
//! no-self-grant bars are `not(and(...))` trees; every other boolean connective stays
//! `Unsupported` (fail-closed) until something actually needs it.

use std::collections::BTreeMap;

use crate::domain::room_path::device_id_to_hex;
use minicbor::Decoder;
use wire_mesh_wire::error::DecodeError;
use wire_mesh_wire::identity::DeviceId;
use wire_mesh_wire::value::{CanonicalMap, CborValue};

/// The two subject-mode delegate systems (wire-mesh#323), matching token-predicates.ts.
pub const GRANTEE_IS: &str = "grantee-is";
pub const GRANTED_CAPABILITY_IS: &str = "granted-capability-is";

/// `compare`'s comparison operator (trilean's `ComparisonOperatorSchema`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparisonOperator {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Neq,
}

impl ComparisonOperator {
    fn from_wire(s: &str) -> Option<Self> {
        match s {
            "gt" => Some(Self::Gt),
            "gte" => Some(Self::Gte),
            "lt" => Some(Self::Lt),
            "lte" => Some(Self::Lte),
            "eq" => Some(Self::Eq),
            "neq" => Some(Self::Neq),
            _ => None,
        }
    }
}

/// A `numberLiteral`'s optional dimensional-unit record (`{tstr => number}`). Two numeric
/// operands must carry exactly equal units to be comparable at all (trilean's own
/// `unitsEqual`); an absent unit is the empty map on both sides, so it compares equal to
/// itself with no special-casing needed.
pub type Unit = BTreeMap<String, f64>;

/// The `ExpressionNode` kinds reachable from a `conditions` entry this codebase's own TS side
/// ever constructs. `textLiteral` is deliberately absent: `compare`'s own semantics (trilean's
/// `compareValues`) always refuse a `text` operand ("use textCompare" instead), and `compare`
/// is the only predicate op this module evaluates, so a `textLiteral` operand could never
/// produce anything but indeterminate regardless of whether it decoded.
#[derive(Debug, Clone, PartialEq)]
pub enum ExpressionNode {
    NumberLiteral {
        value: f64,
        unit: Unit,
    },
    BooleanLiteral {
        value: bool,
    },
    InstantLiteral {
        value: String,
    },
    Delegate {
        system: String,
        payload: CborValue,
    },
    /// A legal `ExpressionNode` kind this module has no support for (`reference`,
    /// `arithmetic`, `negate`, `call`, `lookup`, `conditional`, `fold`, `accumulator`,
    /// `treeReference`, `textLiteral`, `durationLiteral`, `complexLiteral`): trilean accepts it
    /// and evaluates it, this module does not. Always evaluates to indeterminate.
    Unsupported,
    /// A value trilean's schema rejects: not a map, no `kind`, an unknown kind, or a kind of
    /// this module's subset whose fields do not match. Always evaluates to indeterminate, and
    /// is told apart from [`ExpressionNode::Unsupported`] so that a caller can give the reason
    /// the TypeScript gives for each.
    Malformed,
}

/// The `PredicateNode` kinds reachable from a `conditions` entry. Only `compare` is
/// implemented -- see the module doc comment for why nothing here ever constructs `and`/`or`/
/// `not`/`allOf`/`anyOf`/`textCompare`/`memberOf`/`exists`/`some`/`every`/`treeReference`.
#[derive(Debug, Clone, PartialEq)]
pub enum PredicateNode {
    Compare {
        op: ComparisonOperator,
        left: ExpressionNode,
        right: ExpressionNode,
    },
    Not {
        operand: Box<PredicateNode>,
    },
    And {
        left: Box<PredicateNode>,
        right: Box<PredicateNode>,
    },
    Or {
        left: Box<PredicateNode>,
        right: Box<PredicateNode>,
    },
    /// A legal `PredicateNode` kind this module has no support for (`allOf`, `anyOf`,
    /// `textCompare`, `memberOf`, `exists`, `some`, `every`, `treeReference`): trilean accepts it and evaluates it, this
    /// module does not. Always evaluates to indeterminate.
    Unsupported,
    /// A value trilean's schema rejects: not a map, no `kind`, an unknown kind, or a kind of
    /// this module's subset whose fields do not match. Always evaluates to indeterminate.
    Malformed,
}

/// The minted child a grant-capability's conditions are evaluated against (wire-mesh#323
/// subject mode): exactly the claims the two registered systems read, nothing more.
pub struct GrantSubject<'a> {
    pub capability: &'a str,
    pub bearer: &'a DeviceId,
}

/// Three-valued (strict Kleene) predicate result: `None` is indeterminate, and an
/// indeterminate anywhere in a tree refuses the whole conditions list, exactly as trilean's
/// own evaluator treats it.
pub type Tri = Option<bool>;

fn field<'a>(map: &'a CanonicalMap<CborValue, CborValue>, key: &str) -> Option<&'a CborValue> {
    map.get(&CborValue::Text(key.to_owned()))
}

fn text_field<'a>(map: &'a CanonicalMap<CborValue, CborValue>, key: &str) -> Option<&'a str> {
    match field(map, key) {
        Some(CborValue::Text(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// `CborValue` has no float variant (see its own doc comment: floats are rejected on decode
/// everywhere in this wire layer), so only the two integer kinds are ever reachable here. A
/// non-integer `numberLiteral`/unit-exponent value therefore decodes as `Unsupported` rather
/// than being silently truncated -- a real, documented limitation, acceptable because nothing
/// in this codebase constructs a `numberLiteral` node today.
fn cbor_number(v: &CborValue) -> Option<f64> {
    match v {
        CborValue::Int(i) => Some(*i as f64),
        CborValue::UInt(u) => Some(*u as f64),
        _ => None,
    }
}

fn cbor_unit(v: &CborValue) -> Option<Unit> {
    let CborValue::Map(map) = v else {
        return None;
    };
    let mut unit = Unit::new();
    for (k, value) in map.iter() {
        let CborValue::Text(key) = k else {
            return None;
        };
        unit.insert(key.clone(), cbor_number(value)?);
    }
    Some(unit)
}

/// The expression kinds trilean's schema accepts that this module does not evaluate, with the
/// fields each requires. A node of one of these kinds that has every required field is
/// [`ExpressionNode::Unsupported`]; one that lacks a field is [`ExpressionNode::Malformed`].
/// Only the presence of a required field is checked, not its type or anything nested in it, so
/// a node with the right fields of the wrong type is read as unsupported where the TypeScript
/// rejects it.
const UNSUPPORTED_EXPRESSION_KINDS: &[(&str, &[&str])] = &[
    ("textLiteral", &["value"]),
    ("durationLiteral", &["unit", "value"]),
    ("reference", &["key"]),
    ("arithmetic", &["left", "op", "right"]),
    ("negate", &["operand"]),
    ("call", &["args", "fn"]),
    ("lookup", &["keys", "table"]),
    ("conditional", &["cases", "fallback"]),
    ("fold", &["collection", "combiner"]),
    ("accumulator", &[]),
    ("treeReference", &["key"]),
];

/// The predicate kinds trilean's schema accepts that this module does not evaluate, with the
/// fields each requires, read as [`UNSUPPORTED_EXPRESSION_KINDS`] is.
const UNSUPPORTED_PREDICATE_KINDS: &[(&str, &[&str])] = &[
    ("allOf", &["operands"]),
    ("anyOf", &["operands"]),
    ("textCompare", &["left", "op", "right"]),
    ("memberOf", &["candidates", "op", "operand"]),
    ("exists", &["operand"]),
    ("some", &["collection", "item"]),
    ("every", &["collection", "item"]),
    ("treeReference", &["key"]),
];

/// The comparison operators of trilean's schema.
const COMPARISON_OPERATORS: &[&str] = &["gt", "gte", "lt", "lte", "eq", "neq"];

/// Whether `map` holds `kind` and exactly the keys in `required`: the two complex-literal schemas are strict, so a key beyond them is a rejection. Every other node schema of trilean strips a key it does not name, and is read by [`has_fields`] alone.
fn has_exactly(map: &CanonicalMap<CborValue, CborValue>, required: &[&str]) -> bool {
    let mut keys = Vec::new();
    for (key, _) in map.iter() {
        let CborValue::Text(key) = key else {
            return false;
        };
        keys.push(key.as_str());
    }
    required.iter().all(|key| keys.contains(key))
        && keys
            .iter()
            .all(|key| *key == "kind" || required.contains(key))
}

/// Whether `map` has every field `required` names, as the shallow check of an unsupported kind.
fn has_fields(map: &CanonicalMap<CborValue, CborValue>, required: &[&str]) -> bool {
    required.iter().all(|name| field(map, name).is_some())
}

impl ExpressionNode {
    fn from_cbor(v: &CborValue) -> Self {
        let CborValue::Map(map) = v else {
            return ExpressionNode::Malformed;
        };
        let Some(kind) = text_field(map, "kind") else {
            return ExpressionNode::Malformed;
        };
        match kind {
            "numberLiteral" => {
                if !has_fields(map, &["value"]) {
                    return ExpressionNode::Malformed;
                }
                let Some(value) = field(map, "value").and_then(cbor_number) else {
                    return ExpressionNode::Malformed;
                };
                let unit = match field(map, "unit") {
                    Some(u) => match cbor_unit(u) {
                        Some(unit) => unit,
                        None => return ExpressionNode::Malformed,
                    },
                    None => Unit::new(),
                };
                ExpressionNode::NumberLiteral { value, unit }
            }
            "booleanLiteral" => match field(map, "value") {
                Some(CborValue::Bool(value)) => ExpressionNode::BooleanLiteral { value: *value },
                _ => ExpressionNode::Malformed,
            },
            "instantLiteral" => match field(map, "value") {
                Some(CborValue::Text(value)) => ExpressionNode::InstantLiteral {
                    value: value.clone(),
                },
                _ => ExpressionNode::Malformed,
            },
            "delegate" => {
                let (Some(system), Some(payload)) =
                    (text_field(map, "system"), field(map, "payload"))
                else {
                    return ExpressionNode::Malformed;
                };
                ExpressionNode::Delegate {
                    system: system.to_owned(),
                    payload: payload.clone(),
                }
            }
            "complexLiteral" => {
                if has_exactly(map, &["re", "im"]) || has_exactly(map, &["magnitude", "phase"]) {
                    ExpressionNode::Unsupported
                } else {
                    ExpressionNode::Malformed
                }
            }
            other => match UNSUPPORTED_EXPRESSION_KINDS
                .iter()
                .find(|(name, _)| *name == other)
            {
                Some((_, required)) if has_fields(map, required) => ExpressionNode::Unsupported,
                _ => ExpressionNode::Malformed,
            },
        }
    }
}

impl ExpressionNode {
    /// Whether this expression is one trilean's schema rejects.
    fn is_malformed(&self) -> bool {
        matches!(self, ExpressionNode::Malformed)
    }
}

impl PredicateNode {
    /// Whether this node, or any below it, is one trilean's schema rejects: a node the TypeScript calls malformed, as opposed to one it reads and finds unmet or cannot evaluate (a kind this module does not support is [`PredicateNode::Unsupported`], which evaluates to indeterminate). A caller that wants the TypeScript's reason for a list it cannot read asks this first.
    pub fn contains_malformed(&self) -> bool {
        match self {
            PredicateNode::Compare { left, right, .. } => {
                left.is_malformed() || right.is_malformed()
            }
            PredicateNode::Not { operand } => operand.contains_malformed(),
            PredicateNode::And { left, right } | PredicateNode::Or { left, right } => {
                left.contains_malformed() || right.contains_malformed()
            }
            PredicateNode::Malformed => true,
            PredicateNode::Unsupported => false,
        }
    }

    fn from_cbor(v: &CborValue) -> Self {
        let CborValue::Map(map) = v else {
            return PredicateNode::Malformed;
        };
        let Some(kind) = text_field(map, "kind") else {
            return PredicateNode::Malformed;
        };
        match kind {
            "compare" => {
                if !has_fields(map, &["op", "left", "right"]) {
                    return PredicateNode::Malformed;
                }
                let (Some(op), Some(left), Some(right)) = (
                    text_field(map, "op"),
                    field(map, "left").map(ExpressionNode::from_cbor),
                    field(map, "right").map(ExpressionNode::from_cbor),
                ) else {
                    return PredicateNode::Malformed;
                };
                if !COMPARISON_OPERATORS.contains(&op) {
                    return PredicateNode::Malformed;
                }
                match ComparisonOperator::from_wire(op) {
                    Some(op) => PredicateNode::Compare { op, left, right },
                    // Every operator of the schema has a wire form, so this is the schema's own list drifting from the decoder's.
                    None => PredicateNode::Malformed,
                }
            }
            "not" => match field(map, "operand").map(PredicateNode::from_cbor) {
                Some(operand) => PredicateNode::Not {
                    operand: Box::new(operand),
                },
                _ => PredicateNode::Malformed,
            },
            "and" | "or" => {
                let (Some(left), Some(right)) = (
                    field(map, "left").map(PredicateNode::from_cbor),
                    field(map, "right").map(PredicateNode::from_cbor),
                ) else {
                    return PredicateNode::Malformed;
                };
                let left = Box::new(left);
                let right = Box::new(right);
                if kind == "and" {
                    PredicateNode::And { left, right }
                } else {
                    PredicateNode::Or { left, right }
                }
            }
            other => match UNSUPPORTED_PREDICATE_KINDS
                .iter()
                .find(|(name, _)| *name == other)
            {
                Some((_, required)) if has_fields(map, required) => PredicateNode::Unsupported,
                _ => PredicateNode::Malformed,
            },
        }
    }
}

/// Decodes `token-claims.conditions`' raw bytes (a `bstr .cbor [* PredicateNode]`, the same
/// nested-CBOR idiom `parent` already uses) into a list of predicate nodes. Only the outer
/// array itself must be well-formed CDE; a malformed *element* decodes as
/// [`PredicateNode::Unsupported`] rather than failing the whole list (see the module doc
/// comment).
pub fn decode_conditions(bytes: &[u8]) -> Result<Vec<PredicateNode>, DecodeError> {
    let mut d = Decoder::new(bytes);
    let root = CborValue::decode_strict(&mut d)?;
    match root {
        CborValue::Array(items) => Ok(items.iter().map(PredicateNode::from_cbor).collect()),
        other => Err(DecodeError::UnexpectedType {
            expected: "a conditions array",
            found: format!("{other:?}"),
        }),
    }
}

enum ComputedValue {
    Number { value: f64, unit: Unit },
    Boolean(bool),
    Instant(String),
}

fn evaluate_expression(
    node: &ExpressionNode,
    subject: Option<&GrantSubject<'_>>,
) -> Option<ComputedValue> {
    match node {
        ExpressionNode::NumberLiteral { value, unit } => Some(ComputedValue::Number {
            value: *value,
            unit: unit.clone(),
        }),
        ExpressionNode::BooleanLiteral { value } => Some(ComputedValue::Boolean(*value)),
        ExpressionNode::InstantLiteral { value } => Some(ComputedValue::Instant(value.clone())),
        ExpressionNode::Delegate { system, payload } => {
            let subject = subject?;
            let holds = match (system.as_str(), payload) {
                (GRANTEE_IS, CborValue::Text(expected)) => {
                    device_id_to_hex(subject.bearer) == *expected
                }
                (GRANTED_CAPABILITY_IS, CborValue::Text(expected)) => {
                    subject.capability == expected
                }
                _ => return None,
            };
            Some(ComputedValue::Boolean(holds))
        }
        ExpressionNode::Unsupported | ExpressionNode::Malformed => None,
    }
}

#[allow(clippy::float_cmp)]
fn apply_number_op(op: ComparisonOperator, left: f64, right: f64) -> bool {
    match op {
        ComparisonOperator::Gt => left > right,
        ComparisonOperator::Gte => left >= right,
        ComparisonOperator::Lt => left < right,
        ComparisonOperator::Lte => left <= right,
        ComparisonOperator::Eq => left == right,
        ComparisonOperator::Neq => left != right,
    }
}

/// Mirrors trilean's `compareValues` exactly for the three computed-value kinds reachable
/// here (`number`, `boolean`, `instant`) -- `text` and `complex` never appear, since nothing
/// upstream of this function ever produces them. A kind mismatch, an incompatible unit on a
/// numeric pair, an ordering operator applied to booleans, or an unparseable instant are all
/// `wrong-type` in trilean's own terms, i.e. indeterminate here.
fn compare_values(op: ComparisonOperator, left: &ComputedValue, right: &ComputedValue) -> bool {
    match (left, right) {
        (
            ComputedValue::Number { value: l, unit: lu },
            ComputedValue::Number { value: r, unit: ru },
        ) => {
            if lu != ru {
                return false;
            }
            apply_number_op(op, *l, *r)
        }
        (ComputedValue::Boolean(l), ComputedValue::Boolean(r)) => match op {
            ComparisonOperator::Eq => l == r,
            ComparisonOperator::Neq => l != r,
            _ => false,
        },
        (ComputedValue::Instant(l), ComputedValue::Instant(r)) => {
            match (parse_instant_epoch_millis(l), parse_instant_epoch_millis(r)) {
                (Some(le), Some(re)) => apply_number_op(op, le as f64, re as f64),
                _ => false,
            }
        }
        _ => false,
    }
}

/// Parses exactly the profile `Date.prototype.toISOString()` always produces --
/// `YYYY-MM-DDTHH:MM:SS.sssZ`, UTC, millisecond precision -- since that is the only shape any
/// wire-mesh-minted `instantLiteral` would ever actually contain. Any other profile (a
/// timezone offset, no fractional seconds, a different separator) is indeterminate rather than
/// misparsed.
fn parse_instant_epoch_millis(s: &str) -> Option<i64> {
    let bytes = s.as_bytes();
    if bytes.len() != 24 || bytes[10] != b'T' || bytes[19] != b'.' || bytes[23] != b'Z' {
        return None;
    }
    if bytes[4] != b'-' || bytes[7] != b'-' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let minute: i64 = s.get(14..16)?.parse().ok()?;
    let second: i64 = s.get(17..19)?.parse().ok()?;
    let millis: i64 = s.get(20..23)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour >= 24
        || minute >= 60
        || second >= 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + second * 1_000 + millis)
}

/// Howard Hinnant's `days_from_civil`: days since the Unix epoch for a proleptic-Gregorian
/// civil date, correct across the full year range with no calendar-library dependency.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let m = i64::from(m);
    let d = i64::from(d);
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Strict Kleene connectives: an indeterminate operand propagates through `not` (stays
/// indeterminate, never true), short-circuits `and`/`or` only when the other leg is already
/// decisive, and refuses the whole tree otherwise.
fn not(operand: Tri) -> Tri {
    operand.map(|value| !value)
}

fn and(left: Tri, right: Tri) -> Tri {
    match (left, right) {
        (Some(false), _) | (_, Some(false)) => Some(false),
        (Some(true), Some(true)) => Some(true),
        _ => None,
    }
}

fn or(left: Tri, right: Tri) -> Tri {
    match (left, right) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), Some(false)) => Some(false),
        _ => None,
    }
}

fn evaluate_predicate(node: &PredicateNode, subject: Option<&GrantSubject<'_>>) -> Tri {
    match node {
        PredicateNode::Compare { op, left, right } => {
            let (Some(l), Some(r)) = (
                evaluate_expression(left, subject),
                evaluate_expression(right, subject),
            ) else {
                return None;
            };
            Some(compare_values(*op, &l, &r))
        }
        PredicateNode::Not { operand } => not(evaluate_predicate(operand, subject)),
        PredicateNode::And { left, right } => and(
            evaluate_predicate(left, subject),
            evaluate_predicate(right, subject),
        ),
        PredicateNode::Or { left, right } => or(
            evaluate_predicate(left, subject),
            evaluate_predicate(right, subject),
        ),
        PredicateNode::Unsupported | PredicateNode::Malformed => None,
    }
}

/// Evaluates a `conditions` list as an implicit AND: every entry must hold definitely. An
/// empty list (no `conditions` field, or one that decoded to zero entries) is trivially
/// satisfied, matching `token-predicates.ts`'s own `evaluateConditions` exactly. `subject`
/// is the minted child in subject mode (wire-mesh#323), and `None` evaluates against the
/// carrying token's own claims, where the two subject systems are indeterminate.
pub fn evaluate_conditions(nodes: &[PredicateNode], subject: Option<&GrantSubject<'_>>) -> bool {
    nodes
        .iter()
        .all(|node| evaluate_predicate(node, subject) == Some(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compare(op: ComparisonOperator, left: ExpressionNode, right: ExpressionNode) -> bool {
        evaluate_predicate(&PredicateNode::Compare { op, left, right }, None) == Some(true)
    }

    fn number(value: f64) -> ExpressionNode {
        ExpressionNode::NumberLiteral {
            value,
            unit: Unit::new(),
        }
    }

    #[test]
    fn numeric_compare_with_matching_empty_units_evaluates_correctly() {
        assert!(compare(ComparisonOperator::Gt, number(5.0), number(3.0)));
        assert!(!compare(ComparisonOperator::Gt, number(3.0), number(5.0)));
        assert!(compare(ComparisonOperator::Eq, number(5.0), number(5.0)));
    }

    #[test]
    fn numeric_compare_with_mismatched_units_is_indeterminate() {
        let mut metres = Unit::new();
        metres.insert("m".to_owned(), 1.0);
        let with_unit = ExpressionNode::NumberLiteral {
            value: 5.0,
            unit: metres,
        };
        // Same numeric value, but one side carries a unit the other doesn't: `unitsEqual`
        // fails, so even `eq` is indeterminate -- never silently treated as equal.
        assert!(!compare(ComparisonOperator::Eq, with_unit, number(5.0)));
    }

    #[test]
    fn boolean_compare_only_supports_eq_and_neq() {
        let t = || ExpressionNode::BooleanLiteral { value: true };
        assert!(compare(ComparisonOperator::Eq, t(), t()));
        assert!(!compare(ComparisonOperator::Neq, t(), t()));
        // Booleans have no natural ordering: an ordering operator is indeterminate, not an
        // arbitrary true/false-by-convention answer.
        assert!(!compare(ComparisonOperator::Gt, t(), t()));
    }

    #[test]
    fn instant_compare_orders_by_parsed_epoch() {
        let earlier = || ExpressionNode::InstantLiteral {
            value: "2024-01-01T00:00:00.000Z".to_owned(),
        };
        let later = || ExpressionNode::InstantLiteral {
            value: "2024-06-01T00:00:00.000Z".to_owned(),
        };
        assert!(compare(ComparisonOperator::Lt, earlier(), later()));
        assert!(!compare(ComparisonOperator::Gt, earlier(), later()));
        assert!(compare(ComparisonOperator::Eq, earlier(), earlier()));
    }

    #[test]
    fn instant_literal_outside_the_supported_profile_is_indeterminate() {
        // No fractional-seconds/`Z` suffix -- a real ISO-8601 instant, just not the one profile
        // this module parses (see its own doc comment on why that's an acceptable, documented
        // limitation rather than a general RFC 3339 parser).
        let bare_date = || ExpressionNode::InstantLiteral {
            value: "2024-01-01".to_owned(),
        };
        assert!(!compare(ComparisonOperator::Eq, bare_date(), bare_date()));
    }

    #[test]
    fn a_delegate_operand_is_always_indeterminate() {
        // No subject is supplied (see the module doc comment): a compare against a delegate
        // operand can never resolve, regardless of the other operand.
        let delegate = ExpressionNode::Delegate {
            system: "anything".to_owned(),
            payload: CborValue::Null,
        };
        assert!(!compare(
            ComparisonOperator::Eq,
            delegate,
            ExpressionNode::BooleanLiteral { value: true }
        ));
    }

    #[test]
    fn decode_conditions_rejects_a_non_array_root() {
        let mut buf = Vec::new();
        minicbor::Encoder::new(&mut buf).map(0).unwrap();
        assert!(decode_conditions(&buf).is_err());
    }

    #[test]
    fn decode_conditions_treats_an_unrecognised_kind_as_malformed_not_a_decode_error() {
        let mut buf = Vec::new();
        {
            let mut e = minicbor::Encoder::new(&mut buf);
            e.array(1).unwrap();
            e.map(1).unwrap();
            e.str("kind").unwrap().str("frobnicate").unwrap();
        }
        let nodes = decode_conditions(&buf).expect("a well-formed array must still decode");
        assert_eq!(nodes, vec![PredicateNode::Malformed]);
        assert!(!evaluate_conditions(&nodes, None));
    }

    #[test]
    fn decode_conditions_round_trips_a_delegate_payload() {
        let mut buf = Vec::new();
        {
            let mut e = minicbor::Encoder::new(&mut buf);
            e.array(1).unwrap();
            e.map(4).unwrap();
            e.str("op").unwrap().str("eq").unwrap();
            e.str("kind").unwrap().str("compare").unwrap();
            e.str("left").unwrap();
            e.map(3).unwrap();
            e.str("kind").unwrap().str("delegate").unwrap();
            e.str("system").unwrap().str("some-system").unwrap();
            e.str("payload").unwrap().u32(42).unwrap();
            e.str("right").unwrap();
            e.map(2).unwrap();
            e.str("kind").unwrap().str("booleanLiteral").unwrap();
            e.str("value").unwrap().bool(true).unwrap();
        }
        let nodes = decode_conditions(&buf).expect("a well-formed array must still decode");
        assert_eq!(
            nodes,
            vec![PredicateNode::Compare {
                op: ComparisonOperator::Eq,
                left: ExpressionNode::Delegate {
                    system: "some-system".to_owned(),
                    payload: CborValue::UInt(42),
                },
                right: ExpressionNode::BooleanLiteral { value: true },
            }]
        );
        // No subject is supplied, so the delegate stays indeterminate and fails closed even
        // though it decoded cleanly.
        assert!(!evaluate_conditions(&nodes, None));
    }

    #[test]
    fn empty_conditions_list_is_trivially_satisfied() {
        assert!(evaluate_conditions(&[], None));
    }

    #[test]
    fn not_and_or_follow_strict_kleene_semantics() {
        let t = || PredicateNode::Compare {
            op: ComparisonOperator::Eq,
            left: ExpressionNode::BooleanLiteral { value: true },
            right: ExpressionNode::BooleanLiteral { value: true },
        };
        let f = || PredicateNode::Compare {
            op: ComparisonOperator::Eq,
            left: ExpressionNode::BooleanLiteral { value: false },
            right: ExpressionNode::BooleanLiteral { value: true },
        };
        let indet = || PredicateNode::Malformed;
        let eval = |node: &PredicateNode| evaluate_predicate(node, None);
        assert_eq!(eval(&t()), Some(true));
        assert_eq!(not(eval(&f())), Some(true));
        assert_eq!(not(eval(&indet())), None);
        assert_eq!(and(eval(&f()), eval(&indet())), Some(false));
        assert_eq!(and(eval(&t()), eval(&indet())), None);
        assert_eq!(or(eval(&t()), eval(&indet())), Some(true));
        assert_eq!(or(eval(&f()), eval(&indet())), None);
    }

    #[test]
    fn subject_systems_read_the_subject_and_fail_closed_without_one() {
        let bearer = DeviceId([0xAB; 32]);
        let subject = GrantSubject {
            capability: "exec:pty",
            bearer: &bearer,
        };
        let node = |system: &str, payload: CborValue| PredicateNode::Compare {
            op: ComparisonOperator::Eq,
            left: ExpressionNode::Delegate {
                system: system.to_owned(),
                payload,
            },
            right: ExpressionNode::BooleanLiteral { value: true },
        };
        let bearer_hex = device_id_to_hex(&bearer);
        assert!(
            evaluate_predicate(
                &node(GRANTEE_IS, CborValue::Text(bearer_hex.clone())),
                Some(&subject)
            ) == Some(true)
        );
        assert!(
            evaluate_predicate(
                &node(GRANTEE_IS, CborValue::Text("00".to_owned())),
                Some(&subject)
            ) == Some(false)
        );
        assert!(
            evaluate_predicate(
                &node(
                    GRANTED_CAPABILITY_IS,
                    CborValue::Text("exec:pty".to_owned())
                ),
                Some(&subject)
            ) == Some(true)
        );
        // No subject, a non-text payload, or an unregistered system: indeterminate, fail closed.
        assert!(evaluate_predicate(&node(GRANTEE_IS, CborValue::Text(bearer_hex)), None).is_none());
        assert!(
            evaluate_predicate(&node(GRANTEE_IS, CborValue::UInt(7)), Some(&subject)).is_none()
        );
        assert!(evaluate_predicate(
            &node("other-system", CborValue::Text("x".to_owned())),
            Some(&subject)
        )
        .is_none());
    }
}
