//! FROST participant identifiers are scalars, distinct from wire-mesh's own
//! 32-byte device-id. Deriving one deterministically from the other means no
//! participant needs an externally agreed ordinal index -- every device in a
//! session independently computes the same identifier for every other device
//! purely from device-ids it already knows (the `participants` list carried
//! on `threshold-keygen-round1`).

use frost_ed25519::Identifier;
use wire_mesh_wire::identity::DeviceId;

/// An error deriving a FROST identifier from a device-id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentifierError {
    /// `Identifier::derive` failed -- astronomically unlikely (it fails only
    /// if the derived scalar happens to be exactly zero) but must still be a
    /// typed, handleable error rather than a panic, since this runs on
    /// attacker-influenced input (a peer's own advertised device-id).
    DerivationFailed(DeviceId),
}

impl core::fmt::Display for IdentifierError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            IdentifierError::DerivationFailed(id) => {
                write!(
                    f,
                    "device-id {id:?} did not derive to a valid FROST identifier"
                )
            }
        }
    }
}

impl std::error::Error for IdentifierError {}

/// Derives this device's FROST participant identifier from its wire-mesh
/// device-id (`identity.cddl`'s `SHA-256(identity-key.public-key)`).
/// Deterministic and collision-resistant: `Identifier::derive` hashes the
/// input to a uniformly random scalar (RFC 9591's `H1`-style domain
/// separation, internal to frost-core), so two distinct device-ids collide
/// only with the same negligible probability as two device-ids themselves
/// colliding.
pub fn identifier_for_device(device_id: &DeviceId) -> Result<Identifier, IdentifierError> {
    Identifier::derive(device_id.as_ref())
        .map_err(|_| IdentifierError::DerivationFailed(*device_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device_id(byte: u8) -> DeviceId {
        DeviceId::from_bytes([byte; 32])
    }

    #[test]
    fn same_device_id_derives_the_same_identifier_every_time() {
        let id = device_id(7);
        let a = identifier_for_device(&id).expect("derives");
        let b = identifier_for_device(&id).expect("derives");
        assert_eq!(a, b);
    }

    #[test]
    fn distinct_device_ids_derive_distinct_identifiers() {
        let a = identifier_for_device(&device_id(1)).expect("derives");
        let b = identifier_for_device(&device_id(2)).expect("derives");
        assert_ne!(a, b);
    }
}
