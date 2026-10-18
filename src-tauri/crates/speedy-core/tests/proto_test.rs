//! U4 wire protocol: frame codec, preamble scanning, message round-trips and Hello
//! negotiation (KTD4).

use serde_json::json;
use speedy_core::proto::{
    Body, Control, Decoder, Event, Frame, FrameReader, FrameWriter, Hello, MAGIC, MAX_FRAME_LEN,
    PROTOCOL_MAX, PROTOCOL_MIN, ProtoError, Request, Response, WIRE_VERSION, encode, negotiate,
};
use tokio::io::AsyncWriteExt;

fn hello(min: u32, max: u32) -> Hello {
    Hello {
        protocol_min: min,
        protocol_max: max,
        agent_version: "0.1.0".into(),
        build_sha: "abc12345".into(),
        host_id: Some("host-1".into()),
        epoch: Some(42),
        capabilities: vec!["pty".into(), "worktrees".into()],
    }
}

/// A webview-style payload exercising every JSON value shape.
fn json_payload() -> serde_json::Value {
    json!({
        "threadId": "t-1",
        "cwd": "/tmp/x",
        "count": 3,
        "negative": -7,
        "big": u64::MAX,
        "ratio": 0.5,
        "ok": true,
        "none": null,
        "list": [1, "two", {"three": [3.0]}],
        "empty": {},
    })
}

/// One frame of every kind and every message variant.
fn all_frames() -> Vec<Frame> {
    let bodies = vec![
        Body::Control(Control::Hello(hello(1, 2))),
        Body::Control(Control::Hello(Hello {
            host_id: None,
            epoch: None,
            ..hello(1, 1)
        })),
        Body::Control(Control::Ping { nonce: 7 }),
        Body::Control(Control::Pong { nonce: u64::MAX }),
        Body::Control(Control::Lagged {
            stream_id: 9,
            last_sent_seq: 1234,
        }),
        Body::Control(Control::Shutdown),
        Body::Request(Request {
            id: 1,
            method: "pty_write".into(),
            params: json_payload(),
        }),
        Body::Response(Response {
            id: 1,
            result: Ok(json_payload()),
        }),
        Body::Response(Response {
            id: 2,
            result: Ok(serde_json::Value::Null),
        }),
        Body::Response(Response {
            id: 3,
            result: Err("no such thread".into()),
        }),
        Body::Event(Event {
            epoch: 5,
            seq: 99,
            event: json!({"kind": "status", "status": "idle"}),
        }),
        Body::PtyData {
            offset: 1 << 40,
            data: b"\x1b[31mred\x1b[0m\r\n".to_vec(),
        },
        Body::PtyData {
            offset: 0,
            data: vec![],
        },
        Body::PtyReset {
            offset: 2 * 1024 * 1024,
        },
    ];
    bodies
        .into_iter()
        .enumerate()
        .map(|(i, body)| Frame {
            stream_id: i as u32 * 3,
            body,
        })
        .collect()
}

fn decode_all(dec: &mut Decoder) -> Vec<Frame> {
    let mut out = Vec::new();
    while let Some(f) = dec.next_frame().unwrap() {
        out.push(f);
    }
    out
}

#[test]
fn every_frame_round_trips_through_decoder() {
    for frame in all_frames() {
        let bytes = encode(&frame).unwrap();
        let mut dec = Decoder::new();
        dec.feed(&bytes);
        assert_eq!(dec.next_frame().unwrap(), Some(frame));
        assert_eq!(dec.next_frame().unwrap(), None);
    }
}

#[test]
fn frame_layout_is_len_kind_stream_payload() {
    let bytes = encode(&Frame {
        stream_id: 0x0102_0304,
        body: Body::PtyReset { offset: 5 },
    })
    .unwrap();
    // length = kind(1) + stream(4) + offset(8)
    assert_eq!(&bytes[..4], &13u32.to_le_bytes());
    assert_eq!(&bytes[5..9], &0x0102_0304u32.to_le_bytes());
    assert_eq!(&bytes[9..], &5u64.to_le_bytes());

    let data = encode(&Frame {
        stream_id: 1,
        body: Body::PtyData {
            offset: 8,
            data: b"hi".to_vec(),
        },
    })
    .unwrap();
    assert_eq!(&data[9..17], &8u64.to_le_bytes());
    assert_eq!(&data[17..], b"hi");
}

#[test]
fn decoder_handles_one_byte_feeds_and_many_frames_per_feed() {
    let frames = all_frames();
    let stream: Vec<u8> = frames.iter().flat_map(|f| encode(f).unwrap()).collect();

    let mut dec = Decoder::new();
    let mut got = Vec::new();
    for b in &stream {
        dec.feed(std::slice::from_ref(b));
        got.extend(decode_all(&mut dec));
    }
    assert_eq!(got, frames);

    let mut dec = Decoder::new();
    dec.feed(&stream);
    assert_eq!(decode_all(&mut dec), frames);
}

#[test]
fn oversized_header_is_rejected_before_the_payload_arrives() {
    let mut dec = Decoder::new();
    dec.feed(&(32u32 * 1024 * 1024).to_le_bytes());
    dec.feed(&[1, 0, 0, 0, 0]);
    assert!(matches!(dec.next_frame(), Err(ProtoError::FrameTooLarge(n)) if n == 32 * 1024 * 1024));
}

#[test]
fn unknown_kind_is_an_error() {
    let mut bytes = 5u32.to_le_bytes().to_vec();
    bytes.push(0xEE);
    bytes.extend(0u32.to_le_bytes());
    let mut dec = Decoder::new();
    dec.feed(&bytes);
    assert!(matches!(
        dec.next_frame(),
        Err(ProtoError::UnknownKind(0xEE))
    ));
}

#[test]
fn encode_refuses_a_frame_over_the_cap() {
    let data = vec![0u8; MAX_FRAME_LEN];
    let frame = Frame {
        stream_id: 1,
        body: Body::PtyData { offset: 0, data },
    };
    assert!(matches!(encode(&frame), Err(ProtoError::FrameTooLarge(_))));
}

#[test]
fn negotiate_picks_the_highest_shared_version() {
    assert_eq!(negotiate(&hello(3, 4), &hello(4, 5)), Ok(4));
    assert_eq!(negotiate(&hello(4, 5), &hello(3, 4)), Ok(4));
    assert_eq!(
        negotiate(&hello(PROTOCOL_MIN, PROTOCOL_MAX), &hello(1, 1)),
        Ok(1)
    );
}

#[test]
fn negotiate_rejects_disjoint_ranges_naming_both() {
    let err = negotiate(&hello(2, 3), &hello(4, 5)).unwrap_err();
    assert_eq!((err.ours, err.theirs), ((2, 3), (4, 5)));
    let msg = err.to_string();
    assert!(msg.contains("2..=3") && msg.contains("4..=5"), "{msg}");
}

async fn write_all_frames(bytes: &[u8]) -> FrameReader<tokio::io::DuplexStream> {
    let (mut tx, rx) = tokio::io::duplex(64 * 1024);
    let bytes = bytes.to_vec();
    tokio::spawn(async move {
        // The reader may stop early (on error), closing the pipe.
        let _ = tx.write_all(&bytes).await;
    });
    FrameReader::new(rx)
}

#[tokio::test]
async fn async_reader_and_writer_round_trip_with_preamble() {
    let (tx, rx) = tokio::io::duplex(1024);
    let frames = all_frames();
    let sent = frames.clone();
    let writer = tokio::spawn(async move {
        let mut w = FrameWriter::new(tx);
        w.write_preamble().await.unwrap();
        for f in &sent {
            w.write_frame(f).await.unwrap();
        }
    });

    let mut r = FrameReader::new(rx);
    assert_eq!(r.read_preamble().await.unwrap(), WIRE_VERSION);
    let mut got = Vec::new();
    while let Some(f) = r.read_frame().await.unwrap() {
        got.push(f);
    }
    writer.await.unwrap();
    assert_eq!(got, frames);
}

#[tokio::test]
async fn preamble_after_shell_noise_is_found() {
    let mut bytes: Vec<u8> = b"Last login: Sat Oct 18\r\nwelcome to the mini\n".repeat(70);
    bytes.truncate(3 * 1024);
    // A partial magic in the noise must not confuse the scanner.
    bytes.extend_from_slice(b"SPD");
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    let frame = Frame {
        stream_id: 0,
        body: Body::Control(Control::Ping { nonce: 1 }),
    };
    bytes.extend(encode(&frame).unwrap());

    let mut r = write_all_frames(&bytes).await;
    assert_eq!(r.read_preamble().await.unwrap(), WIRE_VERSION);
    assert_eq!(r.read_frame().await.unwrap(), Some(frame));
    assert_eq!(r.read_frame().await.unwrap(), None);
}

#[tokio::test]
async fn noise_past_the_cap_is_an_error() {
    let mut bytes = vec![b'x'; 65 * 1024];
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&WIRE_VERSION.to_le_bytes());
    let mut r = write_all_frames(&bytes).await;
    assert!(matches!(
        r.read_preamble().await,
        Err(ProtoError::PreambleNotFound)
    ));
}

#[tokio::test]
async fn async_reader_rejects_oversized_header() {
    let mut bytes = (32u32 * 1024 * 1024).to_le_bytes().to_vec();
    bytes.extend([1, 0, 0, 0, 0]);
    let mut r = write_all_frames(&bytes).await;
    assert!(matches!(
        r.read_frame().await,
        Err(ProtoError::FrameTooLarge(_))
    ));
}

#[tokio::test]
async fn truncated_frame_at_eof_is_an_error_and_clean_eof_is_none() {
    let frame = Frame {
        stream_id: 2,
        body: Body::PtyData {
            offset: 0,
            data: b"hello".to_vec(),
        },
    };
    let bytes = encode(&frame).unwrap();

    let mut r = write_all_frames(&bytes[..bytes.len() - 2]).await;
    assert!(matches!(r.read_frame().await, Err(ProtoError::Truncated)));

    let mut r = write_all_frames(&bytes[..2]).await;
    assert!(matches!(r.read_frame().await, Err(ProtoError::Truncated)));

    let mut r = write_all_frames(&bytes).await;
    assert_eq!(r.read_frame().await.unwrap(), Some(frame));
    assert_eq!(r.read_frame().await.unwrap(), None);
}
