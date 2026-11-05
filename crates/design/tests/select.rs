//! CSS selectors matched against a document: every artboard is a root, ids
//! are node ids first, and `:contains` reads visible text.

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, NodeKind,
    edit::{self, NewArtboard, WriteMode},
    select::{self, Matcher, Scope},
};

/// A design with one artboard per `(id, page, html)`. Elements are named by
/// their `data-name`, so tests can say which matched.
fn design(boards: &[(&str, Option<&str>, &str)]) -> Design {
    let mut design = Design::new(DesignMeta {
        id: "d".into(),
        name: "Select".into(),
        created_at: 0,
        updated_at: 0,
    });
    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("n{n}")
    };
    for &(id, page, html) in boards {
        if let Some(page) = page
            && design.doc().page(page).is_none()
        {
            let ops = edit::create_page(design.doc(), page.into(), page).unwrap();
            design.commit("agent", "Page", &ops, 0).unwrap();
        }
        let spec = NewArtboard {
            name: id.into(),
            width: 100.0,
            height: Some(100.0),
            position: None,
            page: page.map(Into::into),
            styles: BTreeMap::new(),
        };
        let ops = edit::create_artboard(design.doc(), id.into(), spec).unwrap();
        design.commit("agent", "Artboard", &ops, 0).unwrap();
        let (ops, _) =
            edit::write_html(design.doc(), id, html, WriteMode::Append, None, &mut new_id).unwrap();
        design.commit("agent", "Write", &ops, 0).unwrap();
    }
    design
}

const PAGE: &str = r#"
<header data-name="Header" class="bar top">
  <a data-name="Home" href="/" class="nav">Home</a>
  <a data-name="Docs" href="https://example.com/docs" class="nav" lang="en-US">Docs</a>
  <a data-name="Blog" href="https://example.com/blog.html" class="nav" title="Our Blog">Blog</a>
</header>
<main data-name="Main" id="content">
  <section data-name="Cards">
    <div data-name="Card 1" class="card"><h2 data-name="Title 1">Fast</h2><p data-name="Body 1">Edits are <b data-name="Bold">quick</b></p></div>
    <div data-name="Card 2" class="card featured"><h2 data-name="Title 2">Live</h2><p data-name="Body 2">Everyone sees it</p></div>
    <div data-name="Card 3" class="card"><p data-name="Body 3">No title</p></div>
    <span data-name="Spacer"></span>
  </section>
  <style data-name="Styles">.card { color: red } /* Sign up */</style>
  <button data-name="Cta" style="color: red; padding: 8px">Sign
     UP now</button>
</main>
"#;

fn page() -> Design {
    design(&[("home", None, PAGE)])
}

/// The names of the elements `selector` matches across the design.
fn pick(design: &Design, selector: &str) -> Vec<String> {
    let list = select::parse(selector).unwrap_or_else(|e| panic!("{selector}: {e}"));
    names(design, select::matches(design.doc(), &list, Scope::Design))
}

fn names(design: &Design, ids: Vec<String>) -> Vec<String> {
    ids.iter()
        .map(|id| design.doc().get(id).unwrap().display_name())
        .collect()
}

fn refuse(selector: &str) -> String {
    select::parse(selector).unwrap_err().to_string()
}

#[test]
fn type_universal_and_class() {
    let d = page();
    assert_eq!(pick(&d, "h2"), ["Title 1", "Title 2"]);
    assert_eq!(pick(&d, "H2"), ["Title 1", "Title 2"]);
    assert_eq!(pick(&d, ".card"), ["Card 1", "Card 2", "Card 3"]);
    assert_eq!(pick(&d, ".card.featured"), ["Card 2"]);
    assert_eq!(pick(&d, "div.featured"), ["Card 2"]);
    assert_eq!(pick(&d, "section > *"), pick(&d, "section > div, span"));
    assert_eq!(
        pick(&d, "*").len(),
        d.doc().nodes().filter(|n| n.tag().is_some()).count()
    );
}

#[test]
fn ids_are_node_ids_then_id_attributes() {
    let d = page();
    let main = d
        .doc()
        .nodes()
        .find(|n| n.name.as_deref() == Some("Main"))
        .unwrap();
    assert_eq!(pick(&d, &format!("#{}", main.id)), ["Main"]);
    assert_eq!(pick(&d, "#content"), ["Main"]);
    assert_eq!(pick(&d, "#content > section"), ["Cards"]);
    assert_eq!(pick(&d, "#home"), ["home"]);
}

#[test]
fn ids_may_start_with_a_digit() {
    let mut d = design(&[("4kx92mab", None, r#"<p data-name="P">"#)]);
    assert_eq!(pick(&d, "#4kx92mab"), ["4kx92mab"]);
    assert_eq!(pick(&d, "#4kx92mab > p, [title='#4']"), ["P"]);
    // A digit inside a string isn't touched.
    let ops = edit::write_html(
        d.doc(),
        "4kx92mab",
        r##"<i data-name="I" title="#4"></i>"##,
        WriteMode::Append,
        None,
        &mut || "i1".into(),
    )
    .unwrap()
    .0;
    d.commit("agent", "Write", &ops, 0).unwrap();
    assert_eq!(pick(&d, "[title='#4']"), ["I"]);
    assert_eq!(pick(&d, "#i1:empty"), ["I"]);
}

#[test]
fn attribute_operators() {
    let d = page();
    assert_eq!(pick(&d, "a[title]"), ["Blog"]);
    assert_eq!(pick(&d, "[href='/']"), ["Home"]);
    assert_eq!(pick(&d, "[class~=top]"), ["Header"]);
    assert_eq!(pick(&d, "[lang|=en]"), ["Docs"]);
    assert_eq!(pick(&d, "[href^='https']"), ["Docs", "Blog"]);
    assert_eq!(pick(&d, "[href$='.html']"), ["Blog"]);
    assert_eq!(pick(&d, "[href*=example]"), ["Docs", "Blog"]);
    assert_eq!(pick(&d, "[title='our blog']"), Vec::<String>::new());
    assert_eq!(pick(&d, "[title='our blog' i]"), ["Blog"]);
    assert_eq!(pick(&d, "[title*=BLOG i]"), ["Blog"]);
    // The layer name, id and inline styles read as get_html writes them.
    assert_eq!(
        pick(&d, "[data-name^='Card ']"),
        ["Card 1", "Card 2", "Card 3"]
    );
    assert_eq!(pick(&d, "[data-id='home']"), ["home"]);
    assert_eq!(pick(&d, "button[style*='padding: 8px']"), ["Cta"]);
}

#[test]
fn combinators() {
    let d = page();
    assert_eq!(pick(&d, "main p"), ["Body 1", "Body 2", "Body 3"]);
    assert_eq!(pick(&d, "main > p"), Vec::<String>::new());
    assert_eq!(pick(&d, ".card > p > b"), ["Bold"]);
    assert_eq!(pick(&d, "h2 + p"), ["Body 1", "Body 2"]);
    assert_eq!(pick(&d, ".card ~ span"), ["Spacer"]);
    assert_eq!(pick(&d, ".featured ~ .card"), ["Card 3"]);
    assert_eq!(pick(&d, "header + main"), ["Main"]);
}

#[test]
fn structural_pseudo_classes() {
    let d = page();
    assert_eq!(pick(&d, ".nav:first-child"), ["Home"]);
    assert_eq!(pick(&d, ".nav:last-child"), ["Blog"]);
    assert_eq!(pick(&d, "p:only-child"), ["Body 3"]);
    assert_eq!(pick(&d, "a:nth-child(2)"), ["Docs"]);
    assert_eq!(pick(&d, "a:nth-child(odd)"), ["Home", "Blog"]);
    assert_eq!(pick(&d, "a:nth-child(2n)"), ["Docs"]);
    assert_eq!(pick(&d, "section > :nth-child(-n+2)"), ["Card 1", "Card 2"]);
    assert_eq!(pick(&d, "section > :nth-last-child(1)"), ["Spacer"]);
    assert_eq!(pick(&d, ":nth-child(2 of .card)"), ["Card 2"]);
    assert_eq!(pick(&d, "section > div:first-of-type"), ["Card 1"]);
    assert_eq!(pick(&d, "section > div:last-of-type"), ["Card 3"]);
    assert_eq!(pick(&d, "section > :last-of-type"), ["Card 3", "Spacer"]);
    // Text counts as content; an element with only children isn't empty.
    assert_eq!(pick(&d, "section :empty"), ["Spacer"]);
}

#[test]
fn not_is_where() {
    let d = page();
    assert_eq!(pick(&d, ".card:not(.featured)"), ["Card 1", "Card 3"]);
    assert_eq!(pick(&d, ".card:not(:has(h2))"), ["Card 3"]);
    assert_eq!(pick(&d, ":is(h2, b)"), ["Title 1", "Bold", "Title 2"]);
    assert_eq!(
        pick(&d, ":where(header, section) > :first-child"),
        ["Home", "Card 1"]
    );
    assert_eq!(pick(&d, ".card :is(h2 + p) b"), ["Bold"]);
}

#[test]
fn has_children_or_descendants() {
    let d = page();
    // As in CSS, :has(> x) looks at children, :has(x) at every descendant,
    // so it matches every ancestor of an x.
    assert_eq!(pick(&d, ":has(> h2)"), ["Card 1", "Card 2"]);
    assert_eq!(
        pick(&d, ":has(h2)"),
        ["home", "Main", "Cards", "Card 1", "Card 2"]
    );
    assert_eq!(pick(&d, "div:has(b)"), ["home", "Card 1"]);
    assert_eq!(pick(&d, "h2:has(+ p b)"), ["Title 1"]);
    assert_eq!(pick(&d, "div:has(~ span)"), ["Card 1", "Card 2", "Card 3"]);
}

#[test]
fn root_is_an_artboard() {
    let d = design(&[
        (
            "one",
            None,
            r#"<header data-name="H1"><nav data-name="N1"></nav></header>"#,
        ),
        ("two", None, r#"<header data-name="H2"></header>"#),
    ]);
    assert_eq!(pick(&d, ":root"), ["one", "two"]);
    assert_eq!(pick(&d, ":root > header"), ["H1", "H2"]);
    assert_eq!(pick(&d, ":root > nav"), Vec::<String>::new());
    // Artboards aren't siblings: no selector reaches from one to another.
    assert_eq!(pick(&d, ":root + :root, :root ~ *"), Vec::<String>::new());
    assert_eq!(pick(&d, ":root:first-child"), ["one", "two"]);
}

#[test]
fn contains_reads_visible_text() {
    let d = page();
    // Ignores case and whitespace, includes descendants, and skips <style>.
    assert_eq!(pick(&d, "button:contains('sign up')"), ["Cta"]);
    assert_eq!(pick(&d, ":contains(\"SIGN UP\")"), ["home", "Main", "Cta"]);
    assert_eq!(pick(&d, ".card:contains(quick)"), ["Card 1"]);
    assert_eq!(pick(&d, "p:contains('are quick')"), ["Body 1"]);
    assert_eq!(pick(&d, "p:contains(Everyone sees)"), ["Body 2"]);
    assert_eq!(pick(&d, "style:contains(color)"), Vec::<String>::new());
    // Text from different elements reads with a space between.
    assert_eq!(pick(&d, ".card:contains('fast edits')"), ["Card 1"]);
    assert_eq!(
        pick(&d, ".card:not(:contains(title))"),
        ["Card 1", "Card 2"]
    );
}

#[test]
fn results_are_in_document_order_once() {
    let d = design(&[
        (
            "a",
            None,
            r#"<p data-name="A1" class="x"></p><p data-name="A2" class="y"></p>"#,
        ),
        ("b", None, r#"<p data-name="B1" class="y x"></p>"#),
    ]);
    assert_eq!(pick(&d, ".y, .x"), ["A1", "A2", "B1"]);
    assert_eq!(pick(&d, "p, .x, :root"), ["a", "A1", "A2", "b", "B1"]);
}

#[test]
fn scope_to_a_page_or_within_nodes() {
    let d = design(&[
        ("home", None, r#"<p data-name="Home P"></p>"#),
        (
            "about",
            Some("drafts"),
            r#"<div data-name="Box"><p data-name="About P"></p></div>"#,
        ),
    ]);
    let doc = d.doc();
    let list = select::parse("p, :root").unwrap();
    let first = doc.first_page().to_owned();
    assert_eq!(
        names(&d, select::matches(doc, &list, Scope::Page(&first))),
        ["home", "Home P"]
    );
    assert_eq!(
        names(&d, select::matches(doc, &list, Scope::Page("drafts"))),
        ["about", "About P"]
    );
    assert!(select::matches(doc, &list, Scope::Page("missing")).is_empty());

    // Within a node: its descendants, matched in the context of the
    // whole artboard.
    let boxed = doc.children(Some("about"))[0].id.clone();
    let within = [boxed.clone()];
    let scoped = |selector: &str| {
        let list = select::parse(selector).unwrap();
        names(&d, select::matches(doc, &list, Scope::Within(&within)))
    };
    assert_eq!(scoped("*"), ["About P"]);
    assert_eq!(scoped(":root > div > p"), ["About P"]);
    assert_eq!(scoped("div"), Vec::<String>::new());
    let both = ["about".to_owned(), boxed, "home".to_owned()];
    let list = select::parse("p").unwrap();
    assert_eq!(
        names(&d, select::matches(doc, &list, Scope::Within(&both))),
        ["Home P", "About P"]
    );
}

#[test]
fn one_matcher_serves_many_selectors() {
    let d = page();
    let matcher = Matcher::new(d.doc(), Scope::Design);
    for selector in ["h2", ".card:has(b)", "button:contains(up)"] {
        let list = select::parse(selector).unwrap();
        assert_eq!(names(&d, matcher.select(&list)), pick(&d, selector));
    }
}

#[test]
fn text_nodes_are_named_by_id_only() {
    let d = page();
    let doc = d.doc();
    let text = |s: &str| {
        doc.nodes()
            .find(|n| n.kind == NodeKind::Text && n.text.as_deref() == Some(s))
            .unwrap()
            .id
            .clone()
    };
    let (fast, live) = (text("Fast"), text("Live"));
    let list = select::parse(&format!("#{fast}, #{live}")).unwrap();
    assert_eq!(list.ids().unwrap(), [fast.clone(), live.clone()]);
    assert!(select::matches(doc, &list, Scope::Design).is_empty());
    let matcher = Matcher::new(doc, Scope::Design);
    assert_eq!(matcher.text_nodes(&list), [fast.clone(), live]);

    // Only for a bare #id list, and only in scope.
    let list = select::parse(&format!("#{fast}, h2")).unwrap();
    assert!(list.ids().is_none());
    assert!(matcher.text_nodes(&list).is_empty());
    let list = select::parse(&format!("#{fast}")).unwrap();
    assert!(
        Matcher::new(doc, Scope::Page("missing"))
            .text_nodes(&list)
            .is_empty()
    );
    let title = doc.get(&fast).unwrap().parent.clone().unwrap();
    assert_eq!(
        Matcher::new(doc, Scope::Within(&[title])).text_nodes(&list),
        [fast]
    );
}

#[test]
fn states_and_pseudo_elements_are_refused() {
    let state = "To style that state, use a css op with to: \"style\".";
    assert_eq!(
        refuse(".btn:hover"),
        format!("\":hover\" describes a state, not elements. {state}")
    );
    assert!(refuse("a:is(:focus-visible, .x)").ends_with(state));
    assert!(refuse("input:not(:checked)").ends_with(state));
    assert_eq!(
        refuse("p::before"),
        "\"::before\" is a pseudo-element, not an element. To style it, use a css op with to: \"style\"."
    );
    assert!(refuse("p:after").starts_with("\"::after\" is a pseudo-element"));
}

#[test]
fn errors_name_the_selector_and_where() {
    assert_eq!(
        refuse("div:wobble"),
        "\":wobble\" isn't supported in a selector (in \"div:wobble\")"
    );
    assert_eq!(
        refuse("p:lang(en)"),
        "\":lang\" isn't supported in a selector (in \"p:lang(en)\")"
    );
    assert_eq!(
        refuse("div..card"),
        "can't read \"div..card\" as a CSS selector (at \".card\")"
    );
    assert_eq!(
        refuse("a > , b"),
        "can't read \"a > , b\" as a CSS selector (at \", b\")"
    );
    assert_eq!(
        refuse("#4kx92mab ]"),
        "can't read \"#4kx92mab ]\" as a CSS selector (at \"]\")"
    );
    assert_eq!(
        refuse("a >"),
        "can't read \"a >\" as a CSS selector (it ends too soon)"
    );
    assert_eq!(refuse("  "), "the selector is empty");
}

#[test]
fn loose_selectors_match_the_element_a_rule_styles() {
    let d = page();
    let loose = |selector: &str| {
        let list = select::parse_loose(selector).unwrap();
        names(&d, select::matches(d.doc(), &list, Scope::Design))
    };
    assert_eq!(loose(".card:hover h2"), ["Title 1", "Title 2"]);
    assert_eq!(loose("button:focus-visible"), ["Cta"]);
    assert_eq!(loose(".featured::before"), ["Card 2"]);
    assert_eq!(
        loose(".featured::after, h2::first-letter"),
        ["Title 1", "Card 2", "Title 2"]
    );
    assert_eq!(
        loose("a:-webkit-any-link:lang(en)"),
        ["Home", "Docs", "Blog"]
    );
    assert_eq!(loose("input::placeholder"), Vec::<String>::new());
    assert!(select::parse_loose("div..card").is_err());
}

#[test]
fn nested_has_says_why() {
    let error = select::parse(":has(> :has(> #k3x9a2bq))")
        .unwrap_err()
        .to_string();
    assert!(
        error.contains(":has() can't hold another :has()"),
        "{error}"
    );
    assert!(select::parse(":has(> div > #k3x9a2bq)").is_ok());
}

/// `#instance/node` names a node inside an instance, as `get_html` writes
/// its `data-id`.
#[test]
fn virtual_ids_name_nodes_inside_instances() {
    let mut design = design(&[(
        "board",
        None,
        r#"<header data-name="Nav" data-component="Bar"><h1 data-name="Title">Home</h1></header><header data-name="Nav" data-component="Bar"><h1 data-name="Title">Settings</h1></header>"#,
    )]);
    let doc = design.doc();
    let instance = doc
        .nodes()
        .find(|n| n.is_instance())
        .expect("the second bar is an instance")
        .id
        .clone();
    let view = design.view().clone();
    let title = view
        .children(Some(&instance))
        .first()
        .expect("the instance shows the title")
        .id
        .clone();
    assert!(title.contains('/'), "{title}");
    let list = select::parse(&format!("#{title}, #{title} > *")).unwrap();
    let found = Matcher::new(&view, Scope::Design).select(&list);
    assert_eq!(found, vec![title.clone()]);
    // The escaped spelling, and a selector that already escaped the slash.
    let escaped = title.replace('/', r"\/");
    let list = select::parse(&format!("#{escaped}")).unwrap();
    assert_eq!(
        Matcher::new(&view, Scope::Design).select(&list),
        vec![title]
    );
    let _ = &mut design;
}

/// `#a/b/c`, `#a\/b\/c` and a mix of the two are one id. A slash inside a
/// string is not part of an id.
#[test]
fn virtual_id_spellings_are_the_same_id() {
    let id = "k2n0d9xa/9qd2h0ce/f6bhzd5n";
    let mixed = {
        let (head, tail) = id.split_once('/').unwrap();
        format!(r"{head}\/{tail}")
    };
    for form in [id.to_owned(), id.replace('/', r"\/"), mixed] {
        let list = select::parse(&format!("#{form}")).unwrap_or_else(|e| panic!("{form}: {e}"));
        assert_eq!(list.ids(), Some(&[id.to_owned()][..]), "{form}");
    }
    // A slash inside a string is not part of an id, and select still parses
    // an unescaped path that names nothing.
    let d = page();
    assert_eq!(
        pick(&d, r#"[href="https://example.com/docs"], #nope/missing"#),
        ["Docs"]
    );
}
