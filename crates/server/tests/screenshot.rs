//! Screenshots crop to what they're asked for and say what they show. Needs
//! Chrome (or FINITE_CHROME); without one, each test says so and passes.

use std::{collections::BTreeMap, time::Duration};

use finite_design::{Document, edit, html};
use finite_server::screenshot::{
    Format, Image, MAX_OUTPUT_SIDE, Options, Rect, Shot, capture, plan,
};

/// A PNG's width, height and RGBA pixels.
fn decode(png: &[u8]) -> (u32, u32, Vec<[u8; 4]>) {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::ALPHA);
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut buf).unwrap();
    let channels = info.color_type.samples();
    let pixels = buf[..info.buffer_size()]
        .chunks(channels)
        .map(|p| match p {
            [r, g, b, a] => [*r, *g, *b, *a],
            [g, a] => [*g, *g, *g, *a],
            _ => unreachable!("ALPHA always adds an alpha channel"),
        })
        .collect();
    (info.width, info.height, pixels)
}

struct Png {
    width: u32,
    height: u32,
    pixels: Vec<[u8; 4]>,
}

impl Png {
    fn of(image: &Image) -> Self {
        let (width, height, pixels) = decode(&image.data);
        Self {
            width,
            height,
            pixels,
        }
    }

    fn at(&self, x: u32, y: u32) -> [u8; 4] {
        self.pixels[(y * self.width + x) as usize]
    }

    fn rgb(&self, x: u32, y: u32) -> [u8; 3] {
        let [r, g, b, _] = self.at(x, y);
        [r, g, b]
    }
}

const WHITE: [u8; 3] = [255, 255, 255];
const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];

/// A document holding one artboard written as `html`, and its node ids by
/// layer name (`data-name`).
fn design(html: &str) -> (Document, BTreeMap<String, String>) {
    let mut ops = Vec::new();
    let mut n = 0;
    html::parse(html).unwrap().remove(0).create_ops(
        None,
        "V".into(),
        Some((0.0, 0.0)),
        &mut || {
            n += 1;
            format!("n{n}")
        },
        &mut ops,
    );
    let mut doc = Document::default();
    doc.apply_all(&ops);
    let mut names = BTreeMap::new();
    let mut stack = vec!["n1".to_owned()];
    while let Some(id) = stack.pop() {
        let node = doc.get(&id).unwrap();
        if let Some(name) = &node.name {
            names.insert(name.clone(), id.clone());
        }
        stack.extend(doc.children(Some(&id)).iter().map(|c| c.id.clone()));
    }
    (doc, names)
}

/// The artboard most tests use: 400×300, white, with a red 100×80 box at
/// (50, 60) holding a line of text, and a blue box that's hidden.
const BOARD: &str = r#"<div data-name="Board" style="width: 400px; height: 300px; background: #fff; position: relative; overflow: hidden">
  <div data-name="Red" style="position: absolute; left: 50px; top: 60px; width: 100px; height: 80px; background: #f00"><span data-name="Label" style="display: block; width: 40px; height: 20px">Hi</span></div>
  <div data-name="Gone" style="display: none; width: 10px; height: 10px"></div>
  <div data-name="Blue" style="position: absolute; left: 200px; top: 60px; width: 100px; height: 80px; background: #00f"></div>
</div>"#;

/// Captures `shots`, or returns `None` when no browser is installed.
async fn shoot(
    doc: &Document,
    shots: Vec<Shot>,
    options: Options,
) -> Option<Vec<Result<Image, String>>> {
    let plan = plan(doc, shots, options).unwrap();
    match capture(plan).await {
        Ok(images) => Some(images),
        Err(error) if error.contains("no Chrome") => {
            eprintln!("skipped: {error}");
            None
        }
        Err(error) => panic!("{error}"),
    }
}

#[tokio::test]
async fn a_tall_artboard_is_captured_within_the_limit() {
    // White, with a black band along the very bottom. If the page were
    // cropped rather than shrunk, the band wouldn't be in the image.
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 1440px; height: 8000px; background: #fff; position: relative"><div style="position: absolute; left: 0; right: 0; bottom: 0; height: 200px; background: #000"></div></div>"#,
    );
    let options = Options {
        scale: 2.0,
        ..Default::default()
    };
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Board"])], options).await else {
        return;
    };
    let image = images[0].as_ref().unwrap();
    let png = Png::of(image);
    assert!(
        (png.height as f64 - MAX_OUTPUT_SIDE).abs() <= 2.0,
        "{}×{}",
        png.width,
        png.height
    );
    assert_eq!(
        (png.width, png.height),
        (image.pixel_width, image.pixel_height)
    );
    assert!(image.scale < image.requested_scale);
    assert_eq!(
        png.rgb(png.width / 2, png.height - 10),
        [0, 0, 0],
        "the bottom band is in the image"
    );
    assert_eq!(png.rgb(png.width / 2, png.height / 2), WHITE);
}

#[tokio::test]
async fn shots_crop_to_their_node_with_padding_and_regions() {
    let (doc, names) = design(BOARD);
    let shots = vec![
        Shot::node(&names["Board"]),
        Shot::node(&names["Red"]),
        Shot {
            padding: 10.0,
            ..Shot::node(&names["Red"])
        },
        // The right half of the red box and a bit past it: white.
        Shot {
            region: Some(Rect::new(50.0, 0.0, 70.0, 40.0)),
            ..Shot::node(&names["Red"])
        },
    ];
    let Some(images) = shoot(&doc, shots, Options::default()).await else {
        return;
    };
    let [board, red, padded, region] = &images[..] else {
        panic!()
    };

    let board = board.as_ref().unwrap();
    assert_eq!(board.area, Rect::new(0.0, 0.0, 400.0, 300.0));
    let png = Png::of(board);
    assert_eq!((png.width, png.height), (400, 300));
    assert_eq!(
        png.rgb(120, 120),
        RED,
        "inside the red box, clear of its text"
    );
    assert_eq!(png.rgb(10, 10), WHITE);

    let red = red.as_ref().unwrap();
    assert_eq!(red.bounds, Rect::new(50.0, 60.0, 100.0, 80.0));
    assert_eq!(red.area, red.bounds);
    let png = Png::of(red);
    assert_eq!((png.width, png.height), (100, 80));
    assert_eq!(png.rgb(99, 79), RED);
    assert!(!red.cut_off);

    let padded = padded.as_ref().unwrap();
    assert_eq!(padded.area, Rect::new(40.0, 50.0, 120.0, 100.0));
    let png = Png::of(padded);
    assert_eq!(png.rgb(2, 2), WHITE, "the padding shows the artboard");
    assert_eq!(png.rgb(60, 50), RED);

    let region = region.as_ref().unwrap();
    assert_eq!(region.area, Rect::new(100.0, 60.0, 70.0, 40.0));
    let png = Png::of(region);
    assert_eq!(png.rgb(10, 10), RED);
    assert_eq!(png.rgb(65, 10), WHITE, "the region reaches past the node");
}

#[tokio::test]
async fn text_nodes_hidden_nodes_and_the_artboard_edge() {
    let (doc, names) = design(BOARD);
    let label = &names["Label"];
    let text = doc.children(Some(label))[0].id.clone();
    let shots = vec![
        Shot::node(&text),
        Shot::node(&names["Gone"]),
        // 60px of padding reaches past the top of the artboard.
        Shot {
            padding: 70.0,
            ..Shot::node(&names["Red"])
        },
    ];
    let Some(images) = shoot(&doc, shots, Options::default()).await else {
        return;
    };
    let text_shot = images[0].as_ref().unwrap();
    assert_eq!(
        &text_shot.element, label,
        "a text node is captured as its parent"
    );
    assert_eq!(text_shot.bounds, Rect::new(50.0, 60.0, 40.0, 20.0));

    let gone = images[1].as_ref().unwrap_err();
    assert!(gone.contains("no size"), "{gone}");

    let edge = images[2].as_ref().unwrap();
    assert!(edge.cut_off);
    assert_eq!(edge.area, Rect::new(0.0, 0.0, 220.0, 210.0));
}

#[tokio::test]
async fn options_hide_outline_and_clear_backgrounds() {
    let (doc, names) = design(BOARD);
    let options = Options {
        hide: vec![names["Blue"].clone()],
        highlight: vec![names["Red"].clone()],
        ..Default::default()
    };
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Board"])], options).await else {
        return;
    };
    let png = Png::of(images[0].as_ref().unwrap());
    assert_eq!(png.rgb(250, 100), WHITE, "the blue box is hidden");
    let outline = png.rgb(50, 100);
    assert_ne!(outline, RED, "the red box is outlined");
    assert_eq!(png.rgb(100, 100), RED);

    // Transparent: the label has no background of its own, and loses the red behind it.
    let options = Options {
        transparent: true,
        ..Default::default()
    };
    let shots = vec![Shot::node(&names["Label"]), Shot::node(&names["Blue"])];
    let images = shoot(&doc, shots, options).await.unwrap();
    let label = Png::of(images[0].as_ref().unwrap());
    assert_eq!(label.at(38, 18)[3], 0, "behind the label is transparent");
    let blue = Png::of(images[1].as_ref().unwrap());
    assert_eq!(
        blue.at(50, 40),
        [0, 0, 255, 255],
        "the node keeps its own background"
    );
}

#[tokio::test]
async fn overflow_is_reported_and_can_be_revealed() {
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 200px; height: 100px; background: #fff; overflow: hidden"><div style="width: 200px; height: 250px; background: #00f; flex-shrink: 0"></div></div>"#,
    );
    let board = &names["Board"];
    let Some(images) = shoot(&doc, vec![Shot::node(board)], Options::default()).await else {
        return;
    };
    let cut = images[0].as_ref().unwrap();
    assert_eq!(cut.overflow.bottom, 150.0);
    assert_eq!((cut.pixel_width, cut.pixel_height), (200, 100));

    let options = Options {
        reveal_overflow: true,
        ..Default::default()
    };
    let images = shoot(&doc, vec![Shot::node(board)], options).await.unwrap();
    let shown = images[0].as_ref().unwrap();
    assert_eq!(shown.area, Rect::new(0.0, 0.0, 200.0, 250.0));
    let png = Png::of(shown);
    assert_eq!((png.width, png.height), (200, 250));
    assert_eq!(png.rgb(100, 240), BLUE);
}

#[tokio::test]
async fn overflow_of_a_collapsed_auto_height_artboard_can_be_revealed() {
    // Only positioned children, so the artboard is 0px tall.
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 200px; height: auto; position: relative; overflow: hidden"><div style="position: absolute; left: 0; top: 0; width: 100px; height: 200px; background: #00f"></div></div>"#,
    );
    let options = Options {
        reveal_overflow: true,
        ..Default::default()
    };
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Board"])], options).await else {
        return;
    };
    let shown = images[0].as_ref().expect("something to capture");
    assert_eq!(shown.area.height, 200.0);
    assert_eq!(Png::of(shown).rgb(50, 100), BLUE);

    // The board's own scale still applies, though its height can't show it.
    for (scale, height) in [("2", 400.0), ("0.5", 100.0)] {
        let (doc, names) = design(&format!(
            r#"<div data-name="Board" style="width: 200px; height: auto; position: relative; overflow: hidden; transform: scale({scale}); transform-origin: 0 0"><div style="position: absolute; left: 0; top: 0; width: 100px; height: 200px; background: #00f"></div></div>"#
        ));
        let options = Options {
            reveal_overflow: true,
            ..Default::default()
        };
        let images = shoot(&doc, vec![Shot::node(&names["Board"])], options)
            .await
            .unwrap();
        let shown = images[0].as_ref().expect("something to capture");
        assert_eq!(shown.area.height, height, "scale({scale})");
    }
}

#[tokio::test]
async fn revealed_overflow_follows_a_scaled_artboard() {
    // Scaled 2× from its top-left corner: 400×200 on the page, with 150px
    // of overflow that shows as 300px.
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 200px; height: 100px; background: #fff; overflow: hidden; transform: scale(2); transform-origin: 0 0"><div style="width: 200px; height: 250px; background: #00f; flex-shrink: 0"></div></div>"#,
    );
    let options = Options {
        reveal_overflow: true,
        ..Default::default()
    };
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Board"])], options).await else {
        return;
    };
    let shown = images[0].as_ref().unwrap();
    assert_eq!(shown.area, Rect::new(0.0, 0.0, 400.0, 500.0));

    // A fractional height isn't mistaken for a scale.
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 200px; height: 100.5px; overflow: hidden"><div style="width: 200px; height: 5000px; flex-shrink: 0"></div></div>"#,
    );
    let options = Options {
        reveal_overflow: true,
        ..Default::default()
    };
    let images = shoot(&doc, vec![Shot::node(&names["Board"])], options.clone())
        .await
        .unwrap();
    let shown = images[0].as_ref().unwrap();
    assert_eq!(shown.area.height, 5000.0);

    // Nor is padding on a content-box artboard: 120px tall, content reaching 320px.
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 200px; height: 100px; padding: 10px; box-sizing: content-box; overflow: hidden"><div style="height: 300px; flex-shrink: 0"></div></div>"#,
    );
    let images = shoot(&doc, vec![Shot::node(&names["Board"])], options)
        .await
        .unwrap();
    let shown = images[0].as_ref().unwrap();
    assert_eq!(shown.area.height, 320.0);
}

#[tokio::test]
async fn scales_and_formats() {
    let (doc, names) = design(BOARD);
    let red = &names["Red"];
    for (scale, size) in [(0.25, (25, 20)), (0.5, (50, 40)), (2.0, (200, 160))] {
        let options = Options {
            scale,
            ..Default::default()
        };
        let Some(images) = shoot(&doc, vec![Shot::node(red)], options).await else {
            return;
        };
        let png = Png::of(images[0].as_ref().unwrap());
        assert_eq!((png.width, png.height), size, "at {scale}×");
        assert_eq!(png.rgb(size.0 / 2, size.1 / 2), RED);
    }
    let options = Options {
        format: Format::Jpeg { quality: 70 },
        ..Default::default()
    };
    let images = shoot(&doc, vec![Shot::node(red)], options).await.unwrap();
    let jpeg = images[0].as_ref().unwrap();
    assert_eq!(jpeg.mime, "image/jpeg");
    assert_eq!(&jpeg.data[..2], &[0xff, 0xd8], "a JPEG");

    let refused = plan(
        &doc,
        vec![Shot::node(red)],
        Options {
            format: Format::Jpeg { quality: 70 },
            transparent: true,
            ..Default::default()
        },
    );
    assert!(refused.unwrap_err().contains("no transparency"));
}

#[tokio::test]
async fn scripted_artboards_run_before_the_capture() {
    // The script turns the box blue after half a second.
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 100px; height: 100px"><div data-name="Box" id="box" style="width: 100px; height: 100px; background: #f00"></div><script>setTimeout(() => { document.getElementById('box').style.background = 'blue'; }, 500);</script></div>"#,
    );
    let options = Options {
        settle: Duration::from_secs(1),
        ..Default::default()
    };
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Box"])], options).await else {
        return;
    };
    let image = images[0].as_ref().unwrap();
    assert_eq!(image.settled, Some(Duration::from_secs(1)));
    assert_eq!(Png::of(image).rgb(50, 50), BLUE);
}

#[test]
fn plans_refuse_unknown_nodes_and_too_many_shots() {
    let (doc, names) = design(BOARD);
    let missing = plan(&doc, vec![Shot::node("nope")], Options::default());
    assert!(missing.unwrap_err().contains("not found"));
    let many = (0..11).map(|_| Shot::node(&names["Red"])).collect();
    assert!(
        plan(&doc, many, Options::default())
            .unwrap_err()
            .contains("at most")
    );
}

#[tokio::test]
async fn a_whole_artboard_shot_measures_every_element() {
    let (doc, names) = design(
        r#"<div data-name="Board" style="width: 300px; height: 200px; display: flex; flex-direction: column; overflow: hidden"><div data-name="Tall" style="height: 260px; flex-shrink: 0"></div><p data-name="Text" style="width: 40px; white-space: nowrap; margin: 0">Too long to fit</p></div>"#,
    );
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Board"])], Options::default()).await
    else {
        return;
    };
    let boxes = images[0]
        .as_ref()
        .unwrap()
        .boxes
        .clone()
        .expect("a whole artboard is measured");
    let find = |name: &str| boxes.iter().find(|b| b.id == names[name]).unwrap();
    assert_eq!((find("Board").width, find("Board").height), (300.0, 200.0));
    // The tall block runs past the artboard's bottom edge…
    assert_eq!(find("Tall").height, 260.0);
    // …and the text past its own box.
    let text = find("Text");
    assert_eq!(text.y, 260.0);
    assert!(text.text_overflow.0 > 20.0, "{text:?}");

    // A node's shot doesn't carry them.
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Tall"])], Options::default()).await
    else {
        return;
    };
    assert!(images[0].as_ref().unwrap().boxes.is_none());
}

#[tokio::test]
async fn shared_css_applies_and_the_artboard_overrides_it() {
    let (mut doc, names) = design(
        r#"<div data-name="Board" style="width: 300px; height: 200px"><style>.b { width: 70px; }</style><div data-name="A" class="a"></div><div data-name="B" class="b"></div></div>"#,
    );
    // More specific than the artboard's own rule, which still wins.
    // It overrides the base styles' box-sizing, too.
    doc.apply_all(
        &edit::set_css(
            ".a, div.b { width: 50px; height: 10px; } .a { box-sizing: content-box; padding-left: 10px; }",
        )
        .unwrap(),
    );
    let Some(images) = shoot(&doc, vec![Shot::node(&names["Board"])], Options::default()).await
    else {
        return;
    };
    let boxes = images[0].as_ref().unwrap().boxes.clone().unwrap();
    let width = |name: &str| boxes.iter().find(|b| b.id == names[name]).unwrap().width;
    assert_eq!(width("A"), 60.0);
    assert_eq!(width("B"), 70.0);
}
