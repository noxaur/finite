//! A tall artboard's screenshot fits the API's image limit. Needs Chrome
//! (or FINITE_CHROME); without one, the test says so and passes.

use finite_server::screenshot::{MAX_OUTPUT_SIDE, capture, output_scale};

/// A PNG's width, height and RGB pixels.
fn decode(png: &[u8]) -> (u32, u32, Vec<[u8; 3]>) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(png))
        .read_info()
        .unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    let channels = info.color_type.samples();
    let pixels = buf[..info.buffer_size()]
        .chunks(channels)
        .map(|p| [p[0], p[1], p[2]])
        .collect();
    (info.width, info.height, pixels)
}

#[tokio::test]
async fn a_tall_artboard_is_captured_within_the_limit() {
    // White, with a black band along the very bottom. If the page were
    // cropped rather than shrunk, the band wouldn't be in the image.
    let page = r#"<!doctype html><body style="margin:0"><div style="width:1440px;height:8000px;background:#fff;position:relative"><div style="position:absolute;left:0;right:0;bottom:0;height:200px;background:#000"></div></div></body>"#;
    let scale = output_scale(1440.0, 8000.0, 2.0);
    match capture(page, 1440.0, 8000.0, scale).await {
        Ok(png) => {
            let (w, h, pixels) = decode(&png);
            assert!(h as f64 <= MAX_OUTPUT_SIDE + 1.0, "{w}×{h}");
            assert!(h as f64 >= MAX_OUTPUT_SIDE - 2.0, "{w}×{h}");
            let at = |x: u32, y: u32| pixels[(y * w + x) as usize];
            assert_eq!(
                at(w / 2, h - 10),
                [0, 0, 0],
                "the bottom band is in the image"
            );
            assert_eq!(at(w / 2, h / 2), [255, 255, 255]);
        }
        Err(error) if error.contains("no Chrome") => eprintln!("skipped: {error}"),
        Err(error) => panic!("{error}"),
    }
}
