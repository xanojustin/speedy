//! U4: the agent wire protocol (KTD4): length-prefixed binary frames carrying msgpack
//! payloads, shared by `speedy-agent` and the app.

pub mod frame;
pub mod messages;

pub use frame::{
    Body, Decoder, Frame, FrameReader, FrameWriter, MAGIC, MAX_FRAME_LEN, MAX_PREAMBLE_NOISE,
    ProtoError, WIRE_VERSION, encode,
};
pub use messages::{
    Control, Event, Hello, Incompatible, PROTOCOL_MAX, PROTOCOL_MIN, Request, Response, negotiate,
};
