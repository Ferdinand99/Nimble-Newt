//! Message digests for the tools panel (text, selections and whole files).

use crate::{Error, Result};
use md5::Md5;
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha512};
use std::io::Read;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Algorithm {
    Md5,
    Sha1,
    Sha256,
    Sha512,
}

impl Algorithm {
    pub const ALL: [Algorithm; 4] = [
        Algorithm::Md5,
        Algorithm::Sha1,
        Algorithm::Sha256,
        Algorithm::Sha512,
    ];
}

enum State {
    Md5(Md5),
    Sha1(Sha1),
    Sha256(Sha256),
    Sha512(Sha512),
}

impl State {
    fn new(a: Algorithm) -> State {
        match a {
            Algorithm::Md5 => State::Md5(Md5::new()),
            Algorithm::Sha1 => State::Sha1(Sha1::new()),
            Algorithm::Sha256 => State::Sha256(Sha256::new()),
            Algorithm::Sha512 => State::Sha512(Sha512::new()),
        }
    }
    fn update(&mut self, data: &[u8]) {
        match self {
            State::Md5(h) => h.update(data),
            State::Sha1(h) => h.update(data),
            State::Sha256(h) => h.update(data),
            State::Sha512(h) => h.update(data),
        }
    }
    fn finish(self) -> String {
        let bytes: Vec<u8> = match self {
            State::Md5(h) => h.finalize().to_vec(),
            State::Sha1(h) => h.finalize().to_vec(),
            State::Sha256(h) => h.finalize().to_vec(),
            State::Sha512(h) => h.finalize().to_vec(),
        };
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// Lower-case hex digest of `data`.
pub fn hash_bytes(a: Algorithm, data: &[u8]) -> String {
    let mut s = State::new(a);
    s.update(data);
    s.finish()
}

/// Digests of one input with several algorithms in a single pass.
pub fn hash_reader(algos: &[Algorithm], mut r: impl Read) -> Result<Vec<(Algorithm, String)>> {
    let mut states: Vec<(Algorithm, State)> = algos.iter().map(|a| (*a, State::new(*a))).collect();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = r.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for (_, s) in &mut states {
            s.update(&buf[..n]);
        }
    }
    Ok(states.into_iter().map(|(a, s)| (a, s.finish())).collect())
}

pub fn hash_file(path: &Path, algos: &[Algorithm]) -> Result<Vec<(Algorithm, String)>> {
    let f =
        std::fs::File::open(path).map_err(|e| Error::Msg(format!("{}: {e}", path.display())))?;
    hash_reader(algos, f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vectors() {
        assert_eq!(
            hash_bytes(Algorithm::Md5, b""),
            "d41d8cd98f00b204e9800998ecf8427e"
        );
        assert_eq!(
            hash_bytes(Algorithm::Md5, b"abc"),
            "900150983cd24fb0d6963f7d28e17f72"
        );
        assert_eq!(
            hash_bytes(Algorithm::Sha1, b"abc"),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hash_bytes(Algorithm::Sha256, b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            hash_bytes(Algorithm::Sha512, b"abc"),
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
        );
        assert_eq!(
            hash_bytes(Algorithm::Sha256, b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn streaming_matches_one_shot_across_buffer_boundaries() {
        let data: Vec<u8> = (0..(3 * (1 << 20) + 17)).map(|i| (i % 251) as u8).collect();
        let r = hash_reader(&Algorithm::ALL, &data[..]).unwrap();
        for (a, h) in r {
            assert_eq!(h, hash_bytes(a, &data), "{a:?}");
        }
    }

    #[test]
    fn files_and_missing_files() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("f.txt");
        std::fs::write(&p, "abc").unwrap();
        let r = hash_file(&p, &[Algorithm::Sha1]).unwrap();
        assert_eq!(
            r,
            vec![(
                Algorithm::Sha1,
                "a9993e364706816aba3e25717850c26c9cd0d89d".to_string()
            )]
        );
        assert!(hash_file(&d.path().join("nope"), &[Algorithm::Md5]).is_err());
    }

    #[test]
    fn algorithm_names_in_json() {
        assert_eq!(
            serde_json::to_string(&Algorithm::Sha256).unwrap(),
            "\"sha256\""
        );
        assert_eq!(
            serde_json::from_str::<Algorithm>("\"md5\"").unwrap(),
            Algorithm::Md5
        );
    }
}
