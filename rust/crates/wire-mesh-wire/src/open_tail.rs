//! Helpers shared by every typed shape whose CDDL rule ends in the open tail `* tstr => any` (the typed `$manage-command-params` members and the typed `manage-ok` outcomes): reading a map while keeping the keys the shape does not name, writing it back in CDE order, and the codec impls that follow from a `build` and a `from_map`.

use minicbor::{Decoder, Encode, Encoder};

use crate::error::DecodeError;
use crate::strict;
use crate::value::{CanonicalMap, CborValue, CdeKey, CdeMapBuilder};

/// The open tail of a rule: every key its fields do not name.
pub type Extra = CanonicalMap<String, CborValue>;

/// Encodes `value` into a scratch buffer, for a field a [`CdeMapBuilder`] does not take directly.
pub(crate) fn encoded<T: Encode<()> + ?Sized>(value: &T) -> Vec<u8> {
    let mut buf = Vec::new();
    let mut e = Encoder::new(&mut buf);
    value
        .encode(&mut e, &mut ())
        .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
    buf
}

pub(crate) fn push_extra(builder: &mut CdeMapBuilder, extra: &Extra) {
    for (key, value) in extra.iter() {
        builder.push_raw(key.encoded(), encoded(value));
    }
}

/// Reads one params map: checks the `verb` literal, hands every other key to `field`, which returns whether it named the key, and keeps the keys it did not in the open tail.
pub(crate) fn read_params<'b>(
    d: &mut Decoder<'b>,
    verb: &'static str,
    field: &mut dyn FnMut(&mut Decoder<'b>, &str) -> Result<bool, DecodeError>,
) -> Result<Extra, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut saw_verb = false;
    let mut extra = Extra::new();
    while let Some(key) = map.next_key(d)? {
        if key == "verb" {
            strict::literal(d, verb)?;
            saw_verb = true;
        } else if !field(d, key)? {
            let value = CborValue::decode_strict(d)?;
            extra.insert(key.to_owned(), value)?;
        }
    }
    if !saw_verb {
        return Err(DecodeError::MissingField("verb"));
    }
    Ok(extra)
}

/// Reads one `manage-ok` map: checks the `result` literal and otherwise behaves as [`read_params`].
pub(crate) fn read_ok<'b>(
    d: &mut Decoder<'b>,
    field: &mut dyn FnMut(&mut Decoder<'b>, &str) -> Result<bool, DecodeError>,
) -> Result<Extra, DecodeError> {
    let mut map = strict::MapDecoder::new(d)?;
    let mut saw_result = false;
    let mut extra = Extra::new();
    while let Some(key) = map.next_key(d)? {
        if key == "result" {
            strict::literal(d, "ok")?;
            saw_result = true;
        } else if !field(d, key)? {
            let value = CborValue::decode_strict(d)?;
            extra.insert(key.to_owned(), value)?;
        }
    }
    if !saw_result {
        return Err(DecodeError::MissingField("result"));
    }
    Ok(extra)
}

/// `from_ok` and `into_ok`: the typed shape of a `manage-ok` and back, by re-encoding, so the typed view and the untyped one cannot disagree about what is on the wire.
macro_rules! ok_conversions {
    ($ty:ident) => {
        impl $ty {
            /// The typed form of a successful outcome.
            ///
            /// # Errors
            ///
            /// A [`DecodeError`] when the outcome does not have the shape the rule requires.
            pub fn from_ok(ok: &ManageOk) -> Result<Self, DecodeError> {
                let bytes = minicbor::to_vec(ManageOutcome::Ok(ok.clone()))
                    .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
                let mut d = Decoder::new(&bytes);
                Self::from_map(&mut d)
            }

            /// The outcome this value is, with the same bytes on the wire.
            #[must_use]
            pub fn into_ok(&self) -> ManageOk {
                let bytes = minicbor::to_vec(self)
                    .unwrap_or_else(|_| unreachable!("Vec<u8> writes are infallible"));
                match minicbor::decode::<ManageOutcome>(&bytes) {
                    Ok(ManageOutcome::Ok(ok)) => ok,
                    _ => unreachable!("an encoded typed outcome is a manage-ok"),
                }
            }
        }
    };
}

macro_rules! params_codec {
    ($ty:ident) => {
        impl Encode<()> for $ty {
            fn encode<W: minicbor::encode::Write>(
                &self,
                e: &mut Encoder<W>,
                _ctx: &mut (),
            ) -> Result<(), minicbor::encode::Error<W::Error>> {
                self.build().write(e)
            }
        }

        impl Decode<'_, ()> for $ty {
            fn decode(d: &mut Decoder<'_>, _ctx: &mut ()) -> Result<Self, minicbor::decode::Error> {
                Self::from_map(d).map_err(minicbor::decode::Error::custom)
            }
        }
    };
}

pub(crate) use {ok_conversions, params_codec};
