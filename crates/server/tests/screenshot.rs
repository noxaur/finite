//! A tall artboard's screenshot fits the API's image limit. Needs Chrome
//! (or FINITE_CHROME); without one, the test says so and passes.

use finite_design::{
    Document,
    edit::{self, NewArtboard, WriteMode},
};
use finite_server::screenshot::{MAX_OUTPUT_SIDE, capture, output_scale, page};

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
        Ok(shot) => {
            let (w, h, pixels) = decode(&shot.png);
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

#[tokio::test]
async fn a_capture_measures_where_each_element_rendered() {
    let mut doc = Document::default();
    let spec = NewArtboard {
        name: "Phone".into(),
        width: 300.0,
        height: 200.0,
        position: Some((0.0, 0.0)),
        styles: Default::default(),
    };
    doc.apply_all(&edit::create_artboard(&doc, "board".into(), spec).unwrap());
    let mut n = 0;
    let html = r#"<div style="height: 260px; flex-shrink: 0"></div><p style="width: 40px; white-space: nowrap; margin: 0">Too long to fit</p>"#;
    let (ops, roots) = edit::write_html(&doc, "board", html, WriteMode::Append, None, &mut || {
        n += 1;
        format!("n{n}")
    })
    .unwrap();
    doc.apply_all(&ops);
    let (page, width, height) = page(&doc, "board", None).unwrap();
    match capture(&page, width, height, 1.0).await {
        Ok(shot) => {
            let boxes = shot.boxes.expect("the page was measured");
            let find = |id: &str| boxes.iter().find(|b| b.id == id).unwrap();
            assert_eq!((find("board").width, find("board").height), (300.0, 200.0));
            // The tall block runs past the artboard's bottom edge…
            assert_eq!(find(&roots[0]).height, 260.0);
            // …and the text past its own box.
            let text = find(&roots[1]);
            assert_eq!(text.y, 260.0);
            assert!(text.text_overflow.0 > 20.0, "{text:?}");
        }
        Err(error) if error.contains("no Chrome") => eprintln!("skipped: {error}"),
        Err(error) => panic!("{error}"),
    }
}
