//! WASM bindings for `wire-mesh-threshold`, so a TypeScript participant can
//! hold a real FROST(Ed25519, SHA-512) key share and run the DKG/signing/
//! reshare protocols without a from-scratch reimplementation of the
//! cryptography -- wire-mesh#29's own chosen TS implementation route.
//!
//! Every function here is a thin, byte-oriented wrapper around
//! `wire_mesh_threshold`'s own typed API: this crate performs NO domain
//! logic of its own, only (de)serialization at the JS/wasm boundary and
//! translating between a FROST `Identifier` and wire-mesh's own 32-byte
//! `device-id` (never the reverse -- nothing here leaks a raw FROST
//! identifier encoding into TypeScript, since the wire protocol itself only
//! ever carries `device-id`). A caller supplies participant lists as
//! parallel `id`/`value` arrays rather than a JS `Map`, since `wasm-bindgen`
//! has no built-in `Map<Uint8Array, Uint8Array>` marshalling.
//!
//! Nonce persistence is deliberately NOT this crate's concern: `signing_
//! round1_commit` returns the raw nonce bytes to the caller, whose own
//! durable storage adapter (a `KeyValueStorage`-backed implementation of
//! the equivalent contract `wire_mesh_threshold::nonce_store::NonceStore`
//! defines on the Rust side) is responsible for persisting them before the
//! round-1 response leaves the device -- exactly the same storage-boundary
//! separation the Rust side keeps.

use std::collections::BTreeMap;

use frost_ed25519::keys::dkg::{round1 as dkg_round1_types, round2 as dkg_round2_types};
use frost_ed25519::keys::{
    KeyPackage, PublicKeyPackage, SecretShare, SigningShare, VerifiableSecretSharingCommitment,
};
use frost_ed25519::round1::{SigningCommitments, SigningNonces};
use frost_ed25519::round2::SignatureShare;
use frost_ed25519::{Identifier, SigningPackage, VerifyingKey};
use js_sys::{Array, Uint8Array};
use wasm_bindgen::prelude::*;
use wire_mesh_threshold::identifiers::identifier_for_device;
use wire_mesh_wire::identity::DeviceId;

fn js_err(e: impl core::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn device_id_from_bytes(bytes: &[u8]) -> Result<DeviceId, JsValue> {
    let arr: [u8; 32] = bytes.try_into().map_err(|_| {
        js_err(format!(
            "device-id must be exactly 32 bytes, got {}",
            bytes.len()
        ))
    })?;
    Ok(DeviceId::from_bytes(arr))
}

fn identifier_from_device_id_bytes(bytes: &[u8]) -> Result<Identifier, JsValue> {
    let device_id = device_id_from_bytes(bytes)?;
    identifier_for_device(&device_id).map_err(js_err)
}

/// Unpacks a JS `Array` of `Uint8Array`s into `Vec<Vec<u8>>`.
fn array_to_bytes_vec(arr: &Array) -> Result<Vec<Vec<u8>>, JsValue> {
    let mut out = Vec::with_capacity(arr.length() as usize);
    for value in arr.iter() {
        let u8a: Uint8Array = value
            .dyn_into()
            .map_err(|_| js_err("expected an array of Uint8Array"))?;
        out.push(u8a.to_vec());
    }
    Ok(out)
}

/// Unpacks parallel `ids`/`values` JS arrays (device-id bytes, opaque
/// bytes) into a `BTreeMap<Identifier, T>`, decoding each value with `decode`.
fn parallel_arrays_to_map<T>(
    ids: &Array,
    values: &Array,
    decode: impl Fn(&[u8]) -> Result<T, JsValue>,
) -> Result<BTreeMap<Identifier, T>, JsValue> {
    if ids.length() != values.length() {
        return Err(js_err("ids and values arrays must be the same length"));
    }
    let id_bytes = array_to_bytes_vec(ids)?;
    let value_bytes = array_to_bytes_vec(values)?;
    let mut map = BTreeMap::new();
    for (id, value) in id_bytes.iter().zip(value_bytes.iter()) {
        let identifier = identifier_from_device_id_bytes(id)?;
        map.insert(identifier, decode(value)?);
    }
    Ok(map)
}

/// Builds an `Identifier -> original device-id bytes` lookup from a JS
/// array of device-id bytes -- the general inverse `map_to_parallel_arrays`
/// itself cannot provide (deriving an `Identifier` is one-way), needed
/// anywhere a function returns a map keyed by an identifier that was
/// DERIVED from a caller-supplied device-id list, so the caller gets real
/// device-id bytes back, not an opaque internal identifier encoding.
fn identifier_to_device_id_lookup(ids: &Array) -> Result<BTreeMap<Identifier, Vec<u8>>, JsValue> {
    let id_bytes = array_to_bytes_vec(ids)?;
    id_bytes
        .into_iter()
        .map(|bytes| {
            let identifier = identifier_from_device_id_bytes(&bytes)?;
            Ok((identifier, bytes))
        })
        .collect()
}

fn map_to_parallel_arrays<T>(
    map: &BTreeMap<Identifier, T>,
    device_id_of: impl Fn(Identifier) -> Result<Vec<u8>, JsValue>,
    encode: impl Fn(&T) -> Result<Vec<u8>, JsValue>,
) -> Result<(Array, Array), JsValue> {
    let ids = Array::new();
    let values = Array::new();
    for (identifier, value) in map {
        ids.push(&Uint8Array::from(device_id_of(*identifier)?.as_slice()));
        values.push(&Uint8Array::from(encode(value)?.as_slice()));
    }
    Ok((ids, values))
}

// --- DKG -------------------------------------------------------------

#[wasm_bindgen]
pub struct DkgRound1Output {
    secret_package: Vec<u8>,
    package: Vec<u8>,
}

#[wasm_bindgen]
impl DkgRound1Output {
    #[wasm_bindgen(getter, js_name = secretPackage)]
    pub fn secret_package(&self) -> Vec<u8> {
        self.secret_package.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn package(&self) -> Vec<u8> {
        self.package.clone()
    }
}

#[wasm_bindgen]
pub fn dkg_round1(
    own_device_id: Vec<u8>,
    max_signers: u16,
    min_signers: u16,
) -> Result<DkgRound1Output, JsValue> {
    let own_id = identifier_from_device_id_bytes(&own_device_id)?;
    let (secret, package) =
        wire_mesh_threshold::dkg::round1(own_id, max_signers, min_signers).map_err(js_err)?;
    Ok(DkgRound1Output {
        secret_package: secret.serialize().map_err(js_err)?,
        package: package.serialize().map_err(js_err)?,
    })
}

#[wasm_bindgen]
pub struct DkgRound2Output {
    secret_package: Vec<u8>,
    recipient_ids: Array,
    packages: Array,
}

#[wasm_bindgen]
impl DkgRound2Output {
    #[wasm_bindgen(getter, js_name = secretPackage)]
    pub fn secret_package(&self) -> Vec<u8> {
        self.secret_package.clone()
    }

    #[wasm_bindgen(getter, js_name = recipientIds)]
    pub fn recipient_ids(&self) -> Array {
        self.recipient_ids.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn packages(&self) -> Array {
        self.packages.clone()
    }
}

#[wasm_bindgen]
pub fn dkg_round2(
    own_secret_package: Vec<u8>,
    round1_ids: Array,
    round1_packages: Array,
) -> Result<DkgRound2Output, JsValue> {
    let secret_package =
        dkg_round1_types::SecretPackage::deserialize(&own_secret_package).map_err(js_err)?;
    let packages = parallel_arrays_to_map(&round1_ids, &round1_packages, |bytes| {
        dkg_round1_types::Package::deserialize(bytes).map_err(js_err)
    })?;

    let device_ids = identifier_to_device_id_lookup(&round1_ids)?;
    let (secret2, outgoing) =
        wire_mesh_threshold::dkg::round2(secret_package, &packages).map_err(js_err)?;
    let (recipient_ids, packages_out) = map_to_parallel_arrays(
        &outgoing,
        |identifier| {
            device_ids.get(&identifier).cloned().ok_or_else(|| {
                js_err("internal error: round2 recipient identifier not in round1_ids")
            })
        },
        |p| p.serialize().map_err(js_err),
    )?;

    Ok(DkgRound2Output {
        secret_package: secret2.serialize().map_err(js_err)?,
        recipient_ids,
        packages: packages_out,
    })
}

#[wasm_bindgen]
pub struct DkgRound3Output {
    key_package: Vec<u8>,
    public_key_package: Vec<u8>,
    group_verifying_key: Vec<u8>,
}

#[wasm_bindgen]
impl DkgRound3Output {
    #[wasm_bindgen(getter, js_name = keyPackage)]
    pub fn key_package(&self) -> Vec<u8> {
        self.key_package.clone()
    }

    #[wasm_bindgen(getter, js_name = publicKeyPackage)]
    pub fn public_key_package(&self) -> Vec<u8> {
        self.public_key_package.clone()
    }

    #[wasm_bindgen(getter, js_name = groupVerifyingKey)]
    pub fn group_verifying_key(&self) -> Vec<u8> {
        self.group_verifying_key.clone()
    }
}

#[wasm_bindgen]
pub fn dkg_round3(
    own_secret_package: Vec<u8>,
    round1_ids: Array,
    round1_packages: Array,
    round2_ids: Array,
    round2_packages: Array,
) -> Result<DkgRound3Output, JsValue> {
    let secret2 =
        dkg_round2_types::SecretPackage::deserialize(&own_secret_package).map_err(js_err)?;
    let packages1 = parallel_arrays_to_map(&round1_ids, &round1_packages, |bytes| {
        dkg_round1_types::Package::deserialize(bytes).map_err(js_err)
    })?;
    let packages2 = parallel_arrays_to_map(&round2_ids, &round2_packages, |bytes| {
        dkg_round2_types::Package::deserialize(bytes).map_err(js_err)
    })?;

    let (key_package, public_key_package) =
        wire_mesh_threshold::dkg::round3(&secret2, &packages1, &packages2).map_err(js_err)?;

    Ok(DkgRound3Output {
        key_package: key_package.serialize().map_err(js_err)?,
        public_key_package: public_key_package.serialize().map_err(js_err)?,
        group_verifying_key: public_key_package
            .verifying_key()
            .serialize()
            .map_err(js_err)?,
    })
}

#[wasm_bindgen]
pub struct SplitRound1PackageOutput {
    commitment: Array,
    proof_of_knowledge: Vec<u8>,
}

#[wasm_bindgen]
impl SplitRound1PackageOutput {
    #[wasm_bindgen(getter)]
    pub fn commitment(&self) -> Array {
        self.commitment.clone()
    }

    #[wasm_bindgen(getter, js_name = proofOfKnowledge)]
    pub fn proof_of_knowledge(&self) -> Vec<u8> {
        self.proof_of_knowledge.clone()
    }
}

/// Splits a serialized DKG round-1 `Package` (`dkg_round1`'s own `package`
/// output) into `threshold-keygen-round1`'s own wire shape: the Feldman
/// commitment as an array of independently-serialized coefficients
/// (`commitment: [* bstr]`) and the Schnorr proof of knowledge as a
/// separate byte string -- unlike frost-core's own combined-blob
/// serialization. The inverse of [`combine_round1_package`].
#[wasm_bindgen]
pub fn split_round1_package(package: Vec<u8>) -> Result<SplitRound1PackageOutput, JsValue> {
    let package = dkg_round1_types::Package::deserialize(&package).map_err(js_err)?;
    let (commitment, proof_of_knowledge) =
        wire_mesh_threshold::dkg::split_round1_package(&package).map_err(js_err)?;
    let commitment_array = Array::new();
    for coefficient in &commitment {
        commitment_array.push(&Uint8Array::from(coefficient.as_slice()));
    }
    Ok(SplitRound1PackageOutput {
        commitment: commitment_array,
        proof_of_knowledge,
    })
}

/// Reconstructs a serialized DKG round-1 `Package` (the same combined-blob
/// shape `dkg_round2`/`dkg_round3`/`dkg_transcript_digest` expect) from the
/// two independently-serialized wire fields `threshold-keygen-round1`
/// carries. The inverse of [`split_round1_package`].
#[wasm_bindgen]
pub fn combine_round1_package(
    commitment: Array,
    proof_of_knowledge: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    let commitment_bytes = array_to_bytes_vec(&commitment)?;
    let package =
        wire_mesh_threshold::dkg::combine_round1_package(&commitment_bytes, &proof_of_knowledge)
            .map_err(js_err)?;
    package.serialize().map_err(js_err)
}

#[wasm_bindgen]
pub fn dkg_transcript_digest(
    all_round1_ids: Array,
    all_round1_packages: Array,
    group_verifying_key: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    let packages = parallel_arrays_to_map(&all_round1_ids, &all_round1_packages, |bytes| {
        dkg_round1_types::Package::deserialize(bytes).map_err(js_err)
    })?;
    let group_key = VerifyingKey::deserialize(&group_verifying_key).map_err(js_err)?;
    let digest =
        wire_mesh_threshold::dkg::transcript_digest(&packages, &group_key).map_err(js_err)?;
    Ok(digest.to_vec())
}

#[wasm_bindgen]
pub fn dkg_confirm_matches(
    own_digest: Vec<u8>,
    own_group_key: Vec<u8>,
    peer_digest: Vec<u8>,
    peer_group_key: Vec<u8>,
) -> Result<bool, JsValue> {
    let own_digest_arr: [u8; 32] = own_digest
        .as_slice()
        .try_into()
        .map_err(|_| js_err("own_digest must be exactly 32 bytes"))?;
    let group_key = VerifyingKey::deserialize(&own_group_key).map_err(js_err)?;
    Ok(wire_mesh_threshold::dkg::confirm_matches(
        &own_digest_arr,
        &group_key,
        &peer_digest,
        &peer_group_key,
    )
    .is_ok())
}

// --- Signing -----------------------------------------------------------

#[wasm_bindgen]
pub struct SigningRound1Output {
    nonces: Vec<u8>,
    commitments: Vec<u8>,
}

#[wasm_bindgen]
impl SigningRound1Output {
    #[wasm_bindgen(getter)]
    pub fn nonces(&self) -> Vec<u8> {
        self.nonces.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn commitments(&self) -> Vec<u8> {
        self.commitments.clone()
    }
}

/// The pure-crypto half of round 1: generates a fresh nonce pair and its
/// commitments. Persisting `nonces` durably before the caller's own
/// round-1 response leaves the device is the CALLER's own obligation (see
/// this module's own doc comment) -- this function has no storage
/// dependency and cannot enforce it.
#[wasm_bindgen]
pub fn signing_round1_commit(own_key_package: Vec<u8>) -> Result<SigningRound1Output, JsValue> {
    let key_package = KeyPackage::deserialize(&own_key_package).map_err(js_err)?;
    let (nonces, commitments) =
        frost_ed25519::round1::commit(key_package.signing_share(), &mut rand::rngs::OsRng);
    Ok(SigningRound1Output {
        nonces: nonces.serialize().map_err(js_err)?,
        commitments: commitments.serialize().map_err(js_err)?,
    })
}

#[wasm_bindgen]
pub struct SplitCommitmentsOutput {
    hiding: Vec<u8>,
    binding: Vec<u8>,
}

#[wasm_bindgen]
impl SplitCommitmentsOutput {
    #[wasm_bindgen(getter)]
    pub fn hiding(&self) -> Vec<u8> {
        self.hiding.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn binding(&self) -> Vec<u8> {
        self.binding.clone()
    }
}

/// Splits a serialized `SigningCommitments` (`signing_round1_commit`'s own
/// `commitments` output) into the two independently-serialized halves
/// `threshold-commitment`'s wire shape carries (`hiding: bstr, binding:
/// bstr`) -- unlike frost-core's own combined-blob serialization, which is
/// opaque and not spec-shaped. The inverse of [`combine_commitments`].
#[wasm_bindgen]
pub fn split_commitments(commitments: Vec<u8>) -> Result<SplitCommitmentsOutput, JsValue> {
    let commitments = SigningCommitments::deserialize(&commitments).map_err(js_err)?;
    let (hiding, binding) =
        wire_mesh_threshold::signing::split_commitments(&commitments).map_err(js_err)?;
    Ok(SplitCommitmentsOutput { hiding, binding })
}

/// Reconstructs a serialized `SigningCommitments` (the same combined-blob
/// shape [`signing_build_package`] and [`signing_round2_sign`] expect) from
/// the two independently-serialized halves `threshold-commitment` carries
/// on the wire. The inverse of [`split_commitments`].
#[wasm_bindgen]
pub fn combine_commitments(hiding: Vec<u8>, binding: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    let commitments =
        wire_mesh_threshold::signing::combine_commitments(&hiding, &binding).map_err(js_err)?;
    commitments.serialize().map_err(js_err)
}

/// Coordinator-side: builds the `SigningPackage` bytes every participant's
/// round 2 is computed against.
#[wasm_bindgen]
pub fn signing_build_package(
    ids: Array,
    commitments: Array,
    message: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    let map = parallel_arrays_to_map(&ids, &commitments, |bytes| {
        SigningCommitments::deserialize(bytes).map_err(js_err)
    })?;
    let package = wire_mesh_threshold::signing::build_signing_package(map, &message);
    package.serialize().map_err(js_err)
}

/// Round 2: releases this participant's signature share. The CALLER MUST
/// have already taken (one-shot, never re-readable) `nonces` from its own
/// durable nonce store before calling this -- exactly as
/// `wire_mesh_threshold::signing::round2_sign` requires on the Rust side.
#[wasm_bindgen]
pub fn signing_round2_sign(
    nonces: Vec<u8>,
    signing_package: Vec<u8>,
    own_key_package: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    let nonces = SigningNonces::deserialize(&nonces).map_err(js_err)?;
    let signing_package = SigningPackage::deserialize(&signing_package).map_err(js_err)?;
    let key_package = KeyPackage::deserialize(&own_key_package).map_err(js_err)?;
    let share =
        frost_ed25519::round2::sign(&signing_package, &nonces, &key_package).map_err(js_err)?;
    Ok(share.serialize())
}

/// Coordinator-side: sums and verifies the collected shares into the final
/// aggregate signature -- an ordinary 64-byte Ed25519 signature. See
/// `wire_mesh_threshold::signing::aggregate`'s own doc comment for why a
/// caller MUST treat any error here as "publish nothing".
#[wasm_bindgen]
pub fn signing_aggregate(
    signing_package: Vec<u8>,
    ids: Array,
    shares: Array,
    public_key_package: Vec<u8>,
) -> Result<Vec<u8>, JsValue> {
    let signing_package = SigningPackage::deserialize(&signing_package).map_err(js_err)?;
    let shares_map = parallel_arrays_to_map(&ids, &shares, |bytes| {
        SignatureShare::deserialize(bytes).map_err(js_err)
    })?;
    let public_key_package = PublicKeyPackage::deserialize(&public_key_package).map_err(js_err)?;
    let signature =
        wire_mesh_threshold::signing::aggregate(&signing_package, &shares_map, &public_key_package)
            .map_err(js_err)?;
    signature.serialize().map_err(js_err)
}

/// Extracts a `KeyPackage`'s own `signing_share` bytes -- what
/// `reshare_round1` actually needs as `own_old_signing_share`, since a
/// survivor reshares its share, not its whole key package (which also
/// carries this device's OWN `verifying_share`/the group's `verifying_key`,
/// neither of which the resharing computation itself uses as input).
#[wasm_bindgen]
pub fn key_package_signing_share(key_package: Vec<u8>) -> Result<Vec<u8>, JsValue> {
    let key_package = KeyPackage::deserialize(&key_package).map_err(js_err)?;
    Ok(key_package.signing_share().serialize())
}

// --- Reshare -------------------------------------------------------------

#[wasm_bindgen]
pub struct ReshareRound1Output {
    commitment: Vec<u8>,
    recipient_ids: Array,
    shares: Array,
}

#[wasm_bindgen]
impl ReshareRound1Output {
    #[wasm_bindgen(getter)]
    pub fn commitment(&self) -> Vec<u8> {
        self.commitment.clone()
    }

    #[wasm_bindgen(getter, js_name = recipientIds)]
    pub fn recipient_ids(&self) -> Array {
        self.recipient_ids.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn shares(&self) -> Array {
        self.shares.clone()
    }
}

/// Survivor side: re-shares this device's own Lagrange-weighted sub-share
/// of the group secret across a new (possibly different) participant set.
/// See `wire_mesh_threshold::reshare`'s own module doc comment for the full
/// design rationale -- this is NOT built on `frost_ed25519::keys::refresh`.
#[wasm_bindgen]
pub fn reshare_round1(
    own_device_id: Vec<u8>,
    own_old_signing_share: Vec<u8>,
    survivor_device_ids: Array,
    new_participant_device_ids: Array,
    new_min_signers: u16,
) -> Result<ReshareRound1Output, JsValue> {
    let own_id = identifier_from_device_id_bytes(&own_device_id)?;
    let old_share = SigningShare::deserialize(&own_old_signing_share).map_err(js_err)?;
    let survivor_bytes = array_to_bytes_vec(&survivor_device_ids)?;
    let survivors = survivor_bytes
        .iter()
        .map(|b| identifier_from_device_id_bytes(b))
        .collect::<Result<Vec<_>, _>>()?;
    // device-id <-> identifier is looked up against the caller's own supplied new_participant_device_ids, since the resulting shares map is keyed by the SAME identifiers derived from those exact bytes.
    let device_id_by_identifier = identifier_to_device_id_lookup(&new_participant_device_ids)?;
    let new_ids: Vec<Identifier> = device_id_by_identifier.keys().copied().collect();

    let (commitment, shares) = wire_mesh_threshold::reshare::round1_reshare(
        own_id,
        &old_share,
        &survivors,
        &new_ids,
        new_min_signers,
    )
    .map_err(js_err)?;

    let (recipient_ids, shares_out) = map_to_parallel_arrays(
        &shares,
        |identifier| {
            device_id_by_identifier
                .get(&identifier)
                .cloned()
                .ok_or_else(|| js_err("internal error: recipient identifier not in the supplied new-participant set"))
        },
        |s| s.serialize().map_err(js_err),
    )?;

    Ok(ReshareRound1Output {
        commitment: commitment.serialize_whole().map_err(js_err)?,
        recipient_ids,
        shares: shares_out,
    })
}

/// Splits a survivor's serialized broadcast commitment (`reshare_round1`'s
/// own `commitment` output, a whole-blob serialization) into
/// `threshold-keygen-round1`'s own wire shape: an array of independently-
/// serialized coefficients (`commitment: [* bstr]`). The inverse of
/// [`reshare_combine_commitment_parts`].
#[wasm_bindgen]
pub fn reshare_split_commitment(commitment: Vec<u8>) -> Result<Array, JsValue> {
    let commitment =
        VerifiableSecretSharingCommitment::deserialize_whole(&commitment).map_err(js_err)?;
    let parts = wire_mesh_threshold::reshare::split_commitment(&commitment).map_err(js_err)?;
    let out = Array::new();
    for part in &parts {
        out.push(&Uint8Array::from(part.as_slice()));
    }
    Ok(out)
}

/// Reconstructs a survivor's serialized broadcast commitment (the same
/// whole-blob shape [`reshare_combine_commitments`] expects each entry of
/// its own `commitments` array to be) from the wire's own per-coefficient
/// array. The inverse of [`reshare_split_commitment`].
#[wasm_bindgen]
pub fn reshare_combine_commitment_parts(parts: Array) -> Result<Vec<u8>, JsValue> {
    let part_bytes = array_to_bytes_vec(&parts)?;
    let commitment =
        wire_mesh_threshold::reshare::combine_commitment_parts(&part_bytes).map_err(js_err)?;
    commitment.serialize_whole().map_err(js_err)
}

#[wasm_bindgen]
pub fn reshare_combine_commitments(commitments: Array) -> Result<Vec<u8>, JsValue> {
    let bytes = array_to_bytes_vec(&commitments)?;
    let parsed = bytes
        .iter()
        .map(|b| VerifiableSecretSharingCommitment::deserialize_whole(b).map_err(js_err))
        .collect::<Result<Vec<_>, _>>()?;
    let combined =
        wire_mesh_threshold::reshare::combine_survivor_commitments(&parsed).map_err(js_err)?;
    combined.serialize_whole().map_err(js_err)
}

#[wasm_bindgen]
pub fn reshare_derive_public_key_package(
    combined_commitment: Vec<u8>,
    new_participant_device_ids: Array,
) -> Result<Vec<u8>, JsValue> {
    let commitment = VerifiableSecretSharingCommitment::deserialize_whole(&combined_commitment)
        .map_err(js_err)?;
    let bytes = array_to_bytes_vec(&new_participant_device_ids)?;
    let ids = bytes
        .iter()
        .map(|b| identifier_from_device_id_bytes(b))
        .collect::<Result<Vec<_>, _>>()?;
    let pkp = wire_mesh_threshold::reshare::derive_public_key_package(&commitment, &ids)
        .map_err(js_err)?;
    pkp.serialize().map_err(js_err)
}

#[wasm_bindgen]
pub fn reshare_combine_received_shares(
    own_device_id: Vec<u8>,
    received_shares: Array,
    public_key_package: Vec<u8>,
    new_min_signers: u16,
) -> Result<Vec<u8>, JsValue> {
    let own_id = identifier_from_device_id_bytes(&own_device_id)?;
    let share_bytes = array_to_bytes_vec(&received_shares)?;
    let shares = share_bytes
        .iter()
        .map(|b| SecretShare::deserialize(b).map_err(js_err))
        .collect::<Result<Vec<_>, _>>()?;
    let pkp = PublicKeyPackage::deserialize(&public_key_package).map_err(js_err)?;
    let key_package = wire_mesh_threshold::reshare::combine_received_shares(
        own_id,
        &shares,
        &pkp,
        new_min_signers,
    )
    .map_err(js_err)?;
    key_package.serialize().map_err(js_err)
}
