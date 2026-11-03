//! Times selector matching on a page the size of a long Wikipedia article.
//! `cargo run --release -p finite-design --example select`

use std::time::Instant;

use finite_design::{
    Design, DesignMeta,
    edit::{self, NewArtboard, WriteMode},
    select::{self, Matcher, Scope},
};

fn main() {
    let mut html = String::from(r#"<header class="top"><nav>"#);
    for i in 0..40 {
        html += &format!(r#"<a class="nav" href="/wiki/Topic_{i}">Topic {i}</a>"#);
    }
    html += r#"</nav></header><main id="content">"#;
    for s in 0..100 {
        html += &format!(r#"<section class="section" id="s{s}"><h2>Section {s}</h2>"#);
        for p in 0..5 {
            html += &format!(
                r#"<p>Paragraph {p} of section {s}, with <a href="https://example.com/{s}/{p}">a link</a>,
                some <b>bold</b> words and a <span class="ref">[{p}]</span> reference.</p>"#
            );
        }
        html += "<ul>";
        for l in 0..4 {
            html += &format!(r#"<li class="item">Item {l}</li>"#);
        }
        html += "</ul>";
        if s % 6 == 0 {
            html +=
                "<table><tr><th>Key</th><th>Value</th></tr><tr><td>a</td><td>1</td></tr></table>";
        }
        html += "</section>";
    }
    html += r#"<footer><p>Last edited today</p></footer></main>"#;

    let mut design = Design::new(DesignMeta {
        id: "big".into(),
        name: "Article".into(),
        created_at: 0,
        updated_at: 0,
    });
    let spec = NewArtboard {
        name: "Article".into(),
        width: 1440.0,
        height: None,
        position: None,
        page: None,
        styles: Default::default(),
    };
    let ops = edit::create_artboard(design.doc(), "page".into(), spec).unwrap();
    design.commit("agent", "Add page", &ops, 0).unwrap();
    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("n{n}")
    };
    let (ops, _) = edit::write_html(
        design.doc(),
        "page",
        &html,
        WriteMode::Append,
        None,
        &mut new_id,
    )
    .unwrap();
    design.commit("agent", "Write", &ops, 0).unwrap();
    let doc = design.doc();
    println!("{} nodes", doc.len());

    let t = Instant::now();
    let matcher = Matcher::new(doc, Scope::Design);
    println!("index the design:                 {:?}", t.elapsed());

    for selector in [
        "p",
        "#s50 > h2",
        "section:nth-child(2n+1) li:last-child",
        ".section:has(table) > h2",
        ":has(> h2)",
        ":has(a[href^='https'])",
        "p:contains('section 99, with')",
        ":contains('last edited')",
        "section:not(:has(table)) p:not(:contains(bold))",
    ] {
        let list = select::parse(selector).unwrap();
        let best = |run: &dyn Fn() -> usize| {
            (0..20)
                .map(|_| {
                    let t = Instant::now();
                    (run(), t.elapsed())
                })
                .min_by_key(|&(_, time)| time)
                .unwrap()
        };
        let (found, fresh) = best(&|| select::matches(doc, &list, Scope::Design).len());
        let (_, reused) = best(&|| matcher.select(&list).len());
        println!(
            "{selector:<52} {found:>5} matches  {fresh:>9.2?}  {reused:>9.2?} reusing the index"
        );
    }
}
