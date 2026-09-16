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
//! `ExpressionNode` shape this module does not recognise -- a legitimate trilean kind with no
//! Rust support yet, or genuinely malformed data -- decodes as `Unsupported` rather than a
//! hard error, and evaluates to indeterminate. This matches the spec's own verifier-obligation
//! convention (an unrecognised value in an open `kind` discriminator must be refused, never
//! acted on without understanding it) and keeps a newer TS-minted token that uses a node kind
//! Rust doesn't yet support decoding cleanly into a token this verifier correctly refuses,
//! rather than an internal decode error. Only a malformed outer array (the `bstr` isn't valid
//! CDE, or isn't an array at all) is a hard decode error, mirroring how `parent`'s own nested
//! `bstr .cbor` is already handled in `tokens.rs`.
//!
//! No `delegate` system is registered yet (mirroring `token-predicates.ts`'s own
//! `extraHandlers: {} ` default), so every `delegate` node currently resolves to
//! indeterminate -- correct, fail-closed behaviour, not a placeholder to fill in later.

use std::collections::BTreeMap;

use minicbor::Decoder;
use wire_mesh_wire::error::DecodeError;
use wire_mesh_wire::value::{CanonicalMap, CborValue};

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
    /// `treeReference`, `textLiteral`, `durationLiteral`, `complexLiteral`), or a value that
    /// does not match one of the shapes above. Always evaluates to indeterminate.
    Unsupported,
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
    /// A legal `PredicateNode` kind this module has no support for, or a value that does not
    /// match the `compare` shape above. Always evaluates to indeterminate.
    Unsupported,
}

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

impl ExpressionNode {
    fn from_cbor(v: &CborValue) -> Self {
        let CborValue::Map(map) = v else {
            return ExpressionNode::Unsupported;
        };
        match text_field(map, "kind") {
            Some("numberLiteral") => {
                let Some(value) = field(map, "value").and_then(cbor_number) else {
                    return ExpressionNode::Unsupported;
                };
                let unit = match field(map, "unit") {
                    Some(u) => match cbor_unit(u) {
                        Some(unit) => unit,
                        None => return ExpressionNode::Unsupported,
                    },
                    None => Unit::new(),
                };
                ExpressionNode::NumberLiteral { value, unit }
            }
            Some("booleanLiteral") => match field(map, "value") {
                Some(CborValue::Bool(value)) => ExpressionNode::BooleanLiteral { value: *value },
                _ => ExpressionNode::Unsupported,
            },
            Some("instantLiteral") => match field(map, "value") {
                Some(CborValue::Text(value)) => ExpressionNode::InstantLiteral {
                    value: value.clone(),
                },
                _ => ExpressionNode::Unsupported,
            },
            Some("delegate") => {
                let (Some(system), Some(payload)) =
                    (text_field(map, "system"), field(map, "payload"))
                else {
                    return ExpressionNode::Unsupported;
                };
                ExpressionNode::Delegate {
                    system: system.to_owned(),
                    payload: payload.clone(),
                }
            }
            _ => ExpressionNode::Unsupported,
        }
    }
}

impl PredicateNode {
    fn from_cbor(v: &CborValue) -> Self {
        let CborValue::Map(map) = v else {
            return PredicateNode::Unsupported;
        };
        match text_field(map, "kind") {
            Some("compare") => {
                let (Some(op), Some(left), Some(right)) = (
                    text_field(map, "op").and_then(ComparisonOperator::from_wire),
                    field(map, "left").map(ExpressionNode::from_cbor),
                    field(map, "right").map(ExpressionNode::from_cbor),
                ) else {
                    return PredicateNode::Unsupported;
                };
                PredicateNode::Compare { op, left, right }
            }
            _ => PredicateNode::Unsupported,
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

fn evaluate_expression(node: &ExpressionNode) -> Option<ComputedValue> {
    match node {
        ExpressionNode::NumberLiteral { value, unit } => Some(ComputedValue::Number {
            value: *value,
            unit: unit.clone(),
        }),
        ExpressionNode::BooleanLiteral { value } => Some(ComputedValue::Boolean(*value)),
        ExpressionNode::InstantLiteral { value } => Some(ComputedValue::Instant(value.clone())),
        // No delegate system is registered (see the module doc comment): every delegate
        // resolves to indeterminate, matching `token-predicates.ts`'s own empty
        // `extraHandlers` default exactly.
        ExpressionNode::Delegate { .. } | ExpressionNode::Unsupported => None,
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

fn evaluate_predicate(node: &PredicateNode) -> bool {
    match node {
        PredicateNode::Compare { op, left, right } => {
            let (Some(l), Some(r)) = (evaluate_expression(left), evaluate_expression(right)) else {
                return false;
            };
            compare_values(*op, &l, &r)
        }
        PredicateNode::Unsupported => false,
    }
}

/// Evaluates a `conditions` list as an implicit AND: every entry must hold. An empty list
/// (no `conditions` field, or one that decoded to zero entries) is trivially satisfied,
/// matching `token-predicates.ts`'s own `evaluateConditions` exactly.
pub fn evaluate_conditions(nodes: &[PredicateNode]) -> bool {
    nodes.iter().all(evaluate_predicate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compare(op: ComparisonOperator, left: ExpressionNode, right: ExpressionNode) -> bool {
        evaluate_predicate(&PredicateNode::Compare { op, left, right })
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
        // No system is registered (see the module doc comment): a compare against a delegate
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
    fn decode_conditions_treats_an_unrecognised_kind_as_unsupported_not_a_decode_error() {
        let mut buf = Vec::new();
        {
            let mut e = minicbor::Encoder::new(&mut buf);
            e.array(1).unwrap();
            e.map(1).unwrap();
            e.str("kind").unwrap().str("frobnicate").unwrap();
        }
        let nodes = decode_conditions(&buf).expect("a well-formed array must still decode");
        assert_eq!(nodes, vec![PredicateNode::Unsupported]);
        assert!(!evaluate_conditions(&nodes));
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
        // No system is registered, so this still fails closed even though it decoded cleanly.
        assert!(!evaluate_conditions(&nodes));
    }

    #[test]
    fn empty_conditions_list_is_trivially_satisfied() {
        assert!(evaluate_conditions(&[]));
    }
}
