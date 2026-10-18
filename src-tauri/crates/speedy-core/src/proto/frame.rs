//! U4: the frame codec (KTD4).
//!
//! A frame is a `u32` LE length, a `u8` kind, a `u32` LE stream id and the payload; the
//! length counts kind, stream id and payload, and is capped at [`MAX_FRAME_LEN`]. Message
//! payloads are msgpack (maps with field names, so fields can be added later). `PtyData`
//! is a `u64` LE byte offset then raw bytes; `PtyReset` is the `u64` LE ring-start offset.
//!
//! The agent opens the stream with [`MAGIC`] and a `u16` LE [`WIRE_VERSION`]. A reader
//! skips up to [`MAX_PREAMBLE_NOISE`] bytes before it (shell rc output, motd).

use std::fmt;
use std::io;

use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::messages::{Control, Event, Request, Response};

pub const MAGIC: &[u8; 5] = b"SPDY\0";
pub const WIRE_VERSION: u16 = 1;
/// Largest allowed value of a frame's length field.
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;
/// Most bytes [`FrameReader::read_preamble`] discards before giving up.
pub const MAX_PREAMBLE_NOISE: usize = 64 * 1024;

const LEN_BYTES: usize = 4;
/// Kind byte plus stream id.
const HEADER_BYTES: usize = 5;
const PREAMBLE_BYTES: usize = MAGIC.len() + 2;
const READ_CHUNK: usize = 32 * 1024;

const KIND_CONTROL: u8 = 1;
const KIND_REQUEST: u8 = 2;
const KIND_RESPONSE: u8 = 3;
const KIND_EVENT: u8 = 4;
const KIND_PTY_DATA: u8 = 5;
const KIND_PTY_RESET: u8 = 6;

/// One decoded frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// 0 for control and RPC traffic; otherwise a subscription or terminal stream.
    pub stream_id: u32,
    pub body: Body,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Body {
    Control(Control),
    Request(Request),
    Response(Response),
    Event(Event),
    /// Terminal output; `offset` is the position of `data[0]` in that terminal's stream.
    PtyData {
        offset: u64,
        data: Vec<u8>,
    },
    /// The ring now starts at `offset`; the client discards what it had (KTD5).
    PtyReset {
        offset: u64,
    },
}

#[derive(Debug)]
pub enum ProtoError {
    Io(io::Error),
    /// A frame's length exceeds [`MAX_FRAME_LEN`].
    FrameTooLarge(usize),
    UnknownKind(u8),
    /// A payload that doesn't decode, or a length too short for the header.
    Malformed(String),
    Encode(String),
    /// The stream ended inside a frame or the preamble.
    Truncated,
    /// No preamble within [`MAX_PREAMBLE_NOISE`] bytes.
    PreambleNotFound,
}

impl fmt::Display for ProtoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(e) => write!(f, "i/o error: {e}"),
            Self::FrameTooLarge(n) => {
                write!(f, "frame of {n} bytes exceeds the {MAX_FRAME_LEN}-byte cap")
            }
            Self::UnknownKind(k) => write!(f, "unknown frame kind {k}"),
            Self::Malformed(m) => write!(f, "malformed frame: {m}"),
            Self::Encode(m) => write!(f, "failed to encode frame: {m}"),
            Self::Truncated => write!(f, "stream ended mid-frame"),
            Self::PreambleNotFound => {
                write!(
                    f,
                    "no agent preamble within the first {MAX_PREAMBLE_NOISE} bytes"
                )
            }
        }
    }
}

impl std::error::Error for ProtoError {}

impl From<io::Error> for ProtoError {
    fn from(e: io::Error) -> Self {
        Self::Io(e)
    }
}

fn msgpack<T: Serialize>(v: &T) -> Result<Vec<u8>, ProtoError> {
    rmp_serde::to_vec_named(v).map_err(|e| ProtoError::Encode(e.to_string()))
}

fn unpack<T: DeserializeOwned>(payload: &[u8]) -> Result<T, ProtoError> {
    rmp_serde::from_slice(payload).map_err(|e| ProtoError::Malformed(e.to_string()))
}

fn split_offset(payload: &[u8]) -> Result<(u64, &[u8]), ProtoError> {
    match payload.split_first_chunk::<8>() {
        Some((off, rest)) => Ok((u64::from_le_bytes(*off), rest)),
        None => Err(ProtoError::Malformed(
            "pty payload shorter than its offset".into(),
        )),
    }
}

/// Encodes one frame, refusing one whose length would exceed [`MAX_FRAME_LEN`].
pub fn encode(frame: &Frame) -> Result<Vec<u8>, ProtoError> {
    let (kind, payload) = match &frame.body {
        Body::Control(m) => (KIND_CONTROL, msgpack(m)?),
        Body::Request(m) => (KIND_REQUEST, msgpack(m)?),
        Body::Response(m) => (KIND_RESPONSE, msgpack(m)?),
        Body::Event(m) => (KIND_EVENT, msgpack(m)?),
        Body::PtyData { offset, data } => {
            let mut p = Vec::with_capacity(8 + data.len());
            p.extend_from_slice(&offset.to_le_bytes());
            p.extend_from_slice(data);
            (KIND_PTY_DATA, p)
        }
        Body::PtyReset { offset } => (KIND_PTY_RESET, offset.to_le_bytes().to_vec()),
    };
    let len = HEADER_BYTES + payload.len();
    if len > MAX_FRAME_LEN {
        return Err(ProtoError::FrameTooLarge(len));
    }
    let mut out = Vec::with_capacity(LEN_BYTES + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(kind);
    out.extend_from_slice(&frame.stream_id.to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(out)
}

fn decode_body(kind: u8, payload: &[u8]) -> Result<Body, ProtoError> {
    Ok(match kind {
        KIND_CONTROL => Body::Control(unpack(payload)?),
        KIND_REQUEST => Body::Request(unpack(payload)?),
        KIND_RESPONSE => Body::Response(unpack(payload)?),
        KIND_EVENT => Body::Event(unpack(payload)?),
        KIND_PTY_DATA => {
            let (offset, data) = split_offset(payload)?;
            Body::PtyData {
                offset,
                data: data.to_vec(),
            }
        }
        KIND_PTY_RESET => Body::PtyReset {
            offset: split_offset(payload)?.0,
        },
        other => return Err(ProtoError::UnknownKind(other)),
    })
}

/// Incremental decoder: feed bytes as they arrive, pop whole frames. After an error the
/// stream is unusable and the connection should be dropped.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// True when no partial frame is buffered.
    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// The next whole frame, or `None` until more bytes arrive. An oversized length is
    /// rejected as soon as the length field is in.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtoError> {
        let Some(len) = self.buf.first_chunk::<LEN_BYTES>() else {
            return Ok(None);
        };
        let len = u32::from_le_bytes(*len) as usize;
        if len > MAX_FRAME_LEN {
            return Err(ProtoError::FrameTooLarge(len));
        }
        if len < HEADER_BYTES {
            return Err(ProtoError::Malformed(format!(
                "length {len} is shorter than the header"
            )));
        }
        let total = LEN_BYTES + len;
        if self.buf.len() < total {
            return Ok(None);
        }
        let kind = self.buf[LEN_BYTES];
        let stream_id = u32::from_le_bytes(
            self.buf[LEN_BYTES + 1..LEN_BYTES + HEADER_BYTES]
                .try_into()
                .unwrap(),
        );
        let body = decode_body(kind, &self.buf[LEN_BYTES + HEADER_BYTES..total])?;
        self.buf.drain(..total);
        Ok(Some(Frame { stream_id, body }))
    }
}

/// Reads frames from a byte stream.
pub struct FrameReader<R> {
    inner: R,
    dec: Decoder,
    chunk: Box<[u8]>,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(inner: R) -> Self {
        Self {
            inner,
            dec: Decoder::new(),
            chunk: vec![0; READ_CHUNK].into_boxed_slice(),
        }
    }

    async fn fill(&mut self) -> Result<usize, ProtoError> {
        Ok(self.inner.read(&mut self.chunk).await?)
    }

    /// Skips noise up to the agent's preamble and returns its wire version. Bytes read
    /// past the preamble are kept for [`Self::read_frame`].
    pub async fn read_preamble(&mut self) -> Result<u16, ProtoError> {
        let mut buf = Vec::new();
        loop {
            let found = buf.windows(MAGIC.len()).position(|w| w == MAGIC);
            let noise = found.unwrap_or(buf.len().saturating_sub(MAGIC.len() - 1));
            if noise > MAX_PREAMBLE_NOISE {
                return Err(ProtoError::PreambleNotFound);
            }
            if let Some(at) = found
                && buf.len() >= at + PREAMBLE_BYTES
            {
                let version =
                    u16::from_le_bytes([buf[at + MAGIC.len()], buf[at + MAGIC.len() + 1]]);
                self.dec.feed(&buf[at + PREAMBLE_BYTES..]);
                return Ok(version);
            }
            let n = self.fill().await?;
            if n == 0 {
                return Err(ProtoError::Truncated);
            }
            buf.extend_from_slice(&self.chunk[..n]);
        }
    }

    /// The next frame, or `None` at a clean end of stream between frames. Cancel-safe: bytes
    /// are kept only once a read completes, so a `select!` may drop it and call it again.
    pub async fn read_frame(&mut self) -> Result<Option<Frame>, ProtoError> {
        loop {
            if let Some(frame) = self.dec.next_frame()? {
                return Ok(Some(frame));
            }
            let n = self.fill().await?;
            if n == 0 {
                return if self.dec.is_empty() {
                    Ok(None)
                } else {
                    Err(ProtoError::Truncated)
                };
            }
            self.dec.feed(&self.chunk[..n]);
        }
    }
}

/// Writes frames to a byte stream, flushing after each.
pub struct FrameWriter<W> {
    inner: W,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(inner: W) -> Self {
        Self { inner }
    }

    /// Writes [`MAGIC`] and [`WIRE_VERSION`]; the agent sends this before its first frame.
    pub async fn write_preamble(&mut self) -> Result<(), ProtoError> {
        let mut p = MAGIC.to_vec();
        p.extend_from_slice(&WIRE_VERSION.to_le_bytes());
        self.inner.write_all(&p).await?;
        self.inner.flush().await?;
        Ok(())
    }

    pub async fn write_frame(&mut self, frame: &Frame) -> Result<(), ProtoError> {
        self.inner.write_all(&encode(frame)?).await?;
        self.inner.flush().await?;
        Ok(())
    }
}
