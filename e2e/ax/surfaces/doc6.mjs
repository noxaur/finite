// doc6: the six-tool surface from the MCP redesign v2 ("the document is the
// API"): designs, read, edit, render, comments, undo. Elements are addressed
// with CSS selectors (#id is a node's data-id), and every change goes through
// one transactional `edit` that takes ops (artboard, html, css, attrs, move,
// remove, replace) with `as` names and `@name` refs, `status` and `check`.
// Each tool's description carries its full grammar; the instructions are a
// short map.
//
//   node e2e/ax/run.mjs --task restyle --runs 1 --label doc6 --surface e2e/ax/surfaces/doc6.mjs
//
// Every edit lands in the real design through real tools, so task checks stay
// meaningful. What is approximated in this mock, not built:
//
// - Selectors are matched here in JS, over each artboard's get_html: tag, *,
//   #id (data-id, then id), .class, [attr], [attr=v] (and ~= |= ^= $= *=, i),
//   the four combinators, :root (an artboard), :contains("text"),
//   :first-child, :last-child, :only-child, :nth-child(an+b), :empty,
//   :not(), :is(), :where(), :has(). Text nodes have no selector; a bare
//   #id that matches no element is passed through, so #textId still works.
// - All or nothing: ops run as separate real calls. When one fails, the mock
//   undoes the real steps already applied with the real undo tool, then
//   reports the error. Another agent's edit in between could interleave.
// - One undo step per edit call: the real server makes one step per real
//   call. The mock counts the real steps of each edit (from get_history) and
//   its `undo` undoes all of them, per edit; `redo: true` likewise.
// - html with mode inner or replace is the real write_html (replace-children
//   or replace), not a keyed diff: the new nodes get new ids, so comment pins
//   and history on the old ones are not kept. The three-way merge (stamps and
//   read marks, "their change wins") is not mocked at all.
// - css merges rules in JS (postcss), then writes the whole sheet with
//   set_text_content (a <style> block). to: "inline" calls
//   update_styles per matched element. The cascade note is computed here.
// - replace is the real replace_values; the tokens part (which the real
//   tool doesn't cover) is replaced in JS, colors in any hex or rgb notation.
// - check runs real get_layout on the touched artboards after the ops;
//   status calls start_working_on_nodes after them. render, comments and
//   designs are thin merges of the real tools.
// - Replies keep the real tools' wording, with old tool names in hints
//   rewritten to the new surface (see retool).
// - dryRun applies the ops through real tools, reports them, then undoes
//   them, so people watching see the change flash in and out.
// - designId takes a design's name too: the mock looks it up with
//   list_designs when it isn't an id.
//
// Round 2 (after pages, import and export, get_jsx and delete_design
// shipped) adds them without adding tools: pages and imports are edit ops,
// jsx and file exports are read views, and designs deletes. check is on by
// default, since agents set it on almost every edit in round 1.
import postcss from "postcss";

// ---------------------------------------------------------------- HTML tree

const VOID = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
const RAW = new Set(["style", "script"]);
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k[0] === "#")
      return String.fromCodePoint(k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1)));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }[k];
  });

/** Parses get_html's markup into a tree of {tag, attrs, children, parent, text}. */
function parseHtml(html) {
  const top = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = top;
  const tagRe =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let last = 0;
  const text = (s) => {
    const t = decode(s).trim();
    if (t) cur.children.push({ tag: "#text", text: t, attrs: {}, children: [], parent: cur });
  };
  let m;
  while ((m = tagRe.exec(html))) {
    text(html.slice(last, m.index));
    last = tagRe.lastIndex;
    if (m[0].startsWith("<!--")) {
      // get_html's mark on an element whose children it left out to fit.
      if (m[0].endsWith("not shown -->")) cur.collapsed = true;
      continue;
    }
    if (m[1]) {
      const tag = m[1].toLowerCase();
      for (let n = cur; n && n !== top; n = n.parent)
        if (n.tag === tag) {
          cur = n.parent;
          break;
        }
      continue;
    }
    const tag = m[2].toLowerCase();
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
      attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const el = { tag, attrs, children: [], parent: cur };
    cur.children.push(el);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      el.text = html.slice(last, end < 0 ? html.length : end);
      const close = end < 0 ? html.length : html.indexOf(">", end) + 1;
      last = tagRe.lastIndex = close;
    } else if (!m[4] && !VOID.has(tag)) cur = el;
  }
  text(html.slice(last));
  return top;
}

const elements = (n) => n.children.filter((c) => c.tag !== "#text");
const textOf = (n) => (n.tag === "#text" ? n.text : n.children.map(textOf).join(" "));
function* walk(n) {
  for (const c of n.children) {
    if (c.tag === "#text") continue;
    yield c;
    yield* walk(c);
  }
}
const label = (el) =>
  `${el.tag}${el.attrs["data-name"] ? ` "${el.attrs["data-name"]}"` : ""} #${el.attrs["data-id"]}`;

// ---------------------------------------------------------------- selectors

const STATES =
  /^(hover|focus|focus-within|focus-visible|active|visited|link|checked|disabled|enabled|target|placeholder-shown|invalid|valid|required|optional)$/;

/** Splits on a character at the top level: outside quotes, brackets and parentheses. */
function splitTop(s, ch) {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === ch && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Parses a selector list into [{compounds, combs}], combs[k] joining compound k-1 to k. */
function parseSelector(src) {
  return splitTop(src, ",").map((one) => {
    const compounds = [];
    const combs = [];
    let i = 0;
    let c = null;
    const ident = () => {
      let out = "";
      while (i < one.length && /[\w\- -￿\\]/.test(one[i])) {
        if (one[i] === "\\") i++;
        out += one[i++];
      }
      return out;
    };
    const fresh = () => ({ tag: null, ids: [], classes: [], attrs: [], pseudos: [] });
    let pendingComb = null;
    while (i < one.length) {
      const ch = one[i];
      if (/\s/.test(ch) || ch === ">" || ch === "+" || ch === "~") {
        let comb = " ";
        while (i < one.length && /[\s>+~]/.test(one[i])) {
          if (one[i] !== " " && !/\s/.test(one[i])) comb = one[i];
          i++;
        }
        if (c) {
          compounds.push(c);
          c = null;
          pendingComb = comb;
        }
        continue;
      }
      if (!c) {
        c = fresh();
        if (compounds.length) combs[compounds.length] = pendingComb ?? " ";
      }
      if (ch === "*") {
        i++;
        c.tag = "*";
      } else if (/[\w-]/.test(ch)) c.tag = ident().toLowerCase();
      else if (ch === "#") {
        i++;
        c.ids.push(ident());
      } else if (ch === ".") {
        i++;
        c.classes.push(ident());
      } else if (ch === "[") {
        const end = splitTop(one.slice(i), "]")[0].length + i + 1;
        const body = one.slice(i + 1, one.indexOf("]", i));
        const am = body.match(
          /^\s*([^\s~|^$*=]+)\s*(?:([~|^$*]?=)\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s\]]+))\s*(i|s)?)?\s*$/,
        );
        if (!am) throw new Error(`can't read the attribute selector [${body}]`);
        c.attrs.push({
          name: am[1].toLowerCase(),
          op: am[2],
          value: am[3] ?? am[4] ?? am[5],
          i: am[6] === "i",
        });
        i = one.indexOf("]", i) + 1;
        void end;
      } else if (ch === ":") {
        const element = one[i + 1] === ":";
        i += element ? 2 : 1;
        const name = ident().toLowerCase();
        let arg = null;
        if (one[i] === "(") {
          let depth = 0;
          const start = i + 1;
          for (; i < one.length; i++) {
            if (one[i] === "(") depth++;
            else if (one[i] === ")" && --depth === 0) break;
          }
          arg = one.slice(start, i);
          i++;
        }
        c.pseudos.push({
          name,
          arg,
          element: element || /^(before|after|placeholder|selection|marker)$/.test(name),
        });
      } else throw new Error(`can't read "${one}" as a CSS selector (at "${one.slice(i)}")`);
    }
    if (c) compounds.push(c);
    if (!compounds.length) throw new Error(`"${src}" is an empty selector`);
    return { compounds, combs };
  });
}

const prevEl = (el) => {
  const sibs = elements(el.parent);
  return sibs[sibs.indexOf(el) - 1] ?? null;
};
function nth(arg, pos) {
  const a = arg.replace(/\s/g, "").toLowerCase();
  if (a === "odd") return pos % 2 === 1;
  if (a === "even") return pos % 2 === 0;
  const m = a.match(/^([+-]?\d*)n([+-]\d+)?$/);
  if (!m) return pos === Number(a);
  const step = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1]);
  const off = Number(m[2] ?? 0);
  return step === 0 ? pos === off : (pos - off) / step >= 0 && (pos - off) % step === 0;
}

function matchPseudo(el, p, loose) {
  if (p.element) {
    if (loose) return true;
    throw new Error(
      `"::${p.name}" is a pseudo-element, not an element. To style it, use a css op with to: "style".`,
    );
  }
  const sibs = elements(el.parent);
  switch (p.name) {
    case "root":
      return el.parent?.tag === "#root";
    case "contains":
      return textOf(el)
        .toLowerCase()
        .includes(
          p.arg
            .trim()
            .replace(/^["']|["']$/g, "")
            .toLowerCase(),
        );
    case "first-child":
      return sibs[0] === el;
    case "last-child":
      return sibs.at(-1) === el;
    case "only-child":
      return sibs.length === 1;
    case "nth-child":
      return nth(p.arg, sibs.indexOf(el) + 1);
    case "nth-last-child":
      return nth(p.arg, sibs.length - sibs.indexOf(el));
    case "first-of-type":
      return sibs.find((s) => s.tag === el.tag) === el;
    case "last-of-type":
      return sibs.filter((s) => s.tag === el.tag).at(-1) === el;
    case "empty":
      return el.children.length === 0 && !el.text;
    case "not":
      return !parseSelector(p.arg).some((s) => matchAt(el, s, s.compounds.length - 1, loose));
    case "is":
    case "where":
      return parseSelector(p.arg).some((s) => matchAt(el, s, s.compounds.length - 1, loose));
    case "has": {
      // :has(> x) looks at children only; :has(x) at every descendant.
      const child = /^\s*>/.test(p.arg);
      const pool = child ? elements(el) : [...walk(el)];
      return pool.some((d) =>
        parseSelector(p.arg.replace(/^\s*>/, "")).some((s) =>
          matchAt(d, s, s.compounds.length - 1, loose),
        ),
      );
    }
    default:
      if (loose) return true;
      if (STATES.test(p.name))
        throw new Error(
          `":${p.name}" describes a state, not elements. To style it, use a css op with to: "style".`,
        );
      throw new Error(`":${p.name}" isn't supported in select`);
  }
}

function matchCompound(el, c, loose) {
  if (el.tag === "#text" || el.tag === "#root") return false;
  if (c.tag && c.tag !== "*" && el.tag !== c.tag) return false;
  for (const id of c.ids) if (el.attrs["data-id"] !== id && el.attrs.id !== id) return false;
  const classes = (el.attrs.class ?? "").split(/\s+/);
  for (const cls of c.classes) if (!classes.includes(cls)) return false;
  for (const a of c.attrs) {
    let v = el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    let want = a.value;
    if (a.i) [v, want] = [v.toLowerCase(), want.toLowerCase()];
    const ok = {
      "=": v === want,
      "~=": v.split(/\s+/).includes(want),
      "|=": v === want || v.startsWith(want + "-"),
      "^=": v.startsWith(want),
      "$=": v.endsWith(want),
      "*=": v.includes(want),
    }[a.op];
    if (!ok) return false;
  }
  return c.pseudos.every((p) => matchPseudo(el, p, loose));
}

function matchAt(el, sel, k, loose) {
  if (!matchCompound(el, sel.compounds[k], loose)) return false;
  if (k === 0) return true;
  const comb = sel.combs[k];
  const inside = (n) => n && n.tag !== "#root";
  if (comb === ">") return inside(el.parent) && matchAt(el.parent, sel, k - 1, loose);
  if (comb === "+") {
    const s = prevEl(el);
    return Boolean(s) && matchAt(s, sel, k - 1, loose);
  }
  if (comb === "~") {
    for (let s = prevEl(el); s; s = prevEl(s)) if (matchAt(s, sel, k - 1, loose)) return true;
    return false;
  }
  for (let p = el.parent; inside(p); p = p.parent) if (matchAt(p, sel, k - 1, loose)) return true;
  return false;
}

// ---------------------------------------------------------------- the design

const isId = (t) => /^[a-z0-9]{8}$/.test(t) && /\d/.test(t);

/** The design's artboards as parsed trees, with an index from id to element. */
async function loadTrees(real, designId) {
  const info = JSON.parse(await real.call("get_basic_info", { designId }));
  const boards = [];
  const byId = new Map();
  for (const a of info.artboards) {
    const el = await fullTree(real, designId, a.id);
    if (!el) continue;
    for (const n of [el, ...walk(el)]) {
      n.board = a.id;
      if (n.attrs["data-id"]) byId.set(n.attrs["data-id"], n);
    }
    boards.push({ ...a, el });
  }
  return { info, boards, byId };
}

/**
 * A node's whole subtree. get_html cuts a big subtree to fit one result,
 * marking elements whose children it left out, so this fetches those too.
 * A server-side selector engine would see the whole document at once.
 */
async function fullTree(real, designId, id, tag = "div") {
  const first = await real.call("get_html", { designId, nodeId: id, depth: 0 });
  // A leaf too long for one result, like a big <style>: its text stays unread.
  if (first.startsWith("This node's HTML is"))
    return { tag, attrs: { "data-id": id }, children: [], parent: null, unread: true };
  const el = elements(parseHtml(first))[0];
  if (!el) return null;
  const todo = [el, ...walk(el)].filter((n) => n.collapsed);
  for (let calls = 0; todo.length && calls < 5000; calls++) {
    const n = todo.shift();
    const text = await real.call("get_html", { designId, nodeId: n.attrs["data-id"] });
    let kids;
    if (text.startsWith("This node's HTML is")) {
      // Not even its children fit: fetch each child listed in the outline.
      kids = [];
      for (const x of text.matchAll(/^ {2}([a-z][\w-]*)(?: "[^"]*")? #([a-z0-9]{8})/gm))
        kids.push(await fullTree(real, designId, x[2], x[1]));
      kids = kids.filter(Boolean);
    } else {
      const got = elements(parseHtml(text))[0];
      kids = got?.children ?? [];
      for (const k of walk(got ?? { children: [] })) if (k.collapsed) todo.push(k);
    }
    n.children = kids;
    n.collapsed = false;
    for (const k of kids) k.parent = n;
  }
  return el;
}

/**
 * Turns an agent's select (a string or a list) into a selector string:
 * @name refs become #id, and a bare node id like k3x9a2bq becomes #k3x9a2bq.
 */
function selectorText(select, refs) {
  const s = [select].flat().map(String).join(", ").trim();
  if (!s) throw new Error("select is empty");
  return s
    .replace(/@([\w-]+)/g, (_, name) => {
      if (!refs?.has(name))
        throw new Error(
          `"@${name}" isn't defined. Give an earlier op in the same edit "as": "${name}".`,
        );
      return `#${refs.get(name)}`;
    })
    .split(",")
    .map((part) => (isId(part.trim()) ? `#${part.trim()}` : part))
    .join(",");
}

/** Elements a selector matches, in document order, as [{id, el, board}]. */
function matchAll(trees, sel, { loose = false } = {}) {
  const parsed = parseSelector(sel);
  const out = [];
  for (const b of trees.boards)
    for (const el of [b.el, ...walk(b.el)])
      if (parsed.some((s) => matchAt(el, s, s.compounds.length - 1, loose)))
        out.push({ id: el.attrs["data-id"], el, board: b.id });
  if (!out.length && !loose) {
    // A bare #id list that matched no element may name a text node: pass it on.
    const ids = splitTop(sel, ",").map((p) => p.match(/^#([\w-]+)$/)?.[1]);
    if (ids.every(Boolean)) return ids.map((id) => ({ id, el: null, board: null }));
  }
  return out;
}

const isAncestor = (a, b) => {
  for (let n = b?.parent; n; n = n.parent) if (n === a) return true;
  return false;
};

const describeAll = (ms) =>
  ms
    .slice(0, 6)
    .map((m) => (m.el ? label(m.el) : `#${m.id}`))
    .join(", ") + (ms.length > 6 ? `, and ${ms.length - 6} more` : "");

// ---------------------------------------------------------------- rewording

/** Rewrites the real tools' hints into this surface's words. */
function retool(text) {
  return String(text)
    .replace(
      /update_styles \{"updates": \[\{"nodeIds": \["([a-z0-9]+)"\], "styles": \{"([\w-]+)": "([^"]+)"\}\}\]\}/g,
      (_, id, prop, value) => `edit {"op": "css", "css": "#${id} { ${prop}: ${value} }"}`,
    )
    .replace(/\n?Check it with get_screenshot\./, "")
    .replace(
      /Next: create_artboard with that pageId\./,
      'Next: an "artboard" op with page set to its name or id.',
    )
    .replace("Next: create_artboard.", 'Next: edit with an "artboard" op.')
    .replace(/\bget_tree_summary\b|\bget_children\b|\bget_basic_info\b|\bget_node_info\b/g, "read")
    .replace(/\bget_html\b/g, 'read with as: "html"')
    .replace(/\bget_tokens\b/g, 'read with as: "css"')
    .replace(/\bset_tokens\b/g, 'a "tokens" op')
    .replace(/\bset_artboard_mode\b/g, "a move op with mode")
    .replace(/\bget_screenshot\b/g, "render")
    .replace(/\bget_layout\b/g, 'render with output: "layout"')
    .replace(/\bfind_nodes\b/g, "read with contains")
    .replace(/\breplace_values\b/g, "a replace op")
    .replace(/\bupdate_styles\b/g, "a css op")
    .replace(/\bset_text_content\b/g, 'an html op with mode "inner"')
    .replace(/\bwrite_html\b/g, "an html op")
    .replace(/\bset_attributes\b|\brename_nodes\b/g, "an attrs op")
    .replace(/\bmove_nodes\b|\bset_artboard_position\b|\bduplicate_nodes\b/g, "a move op")
    .replace(/\bdelete_nodes\b/g, "a remove op")
    .replace(/\bcreate_artboard\b/g, 'an "artboard" op')
    .replace(/\blist_designs\b|\bcreate_design\b/g, "designs")
    .replace(/\bget_comments\b/g, "comments")
    .replace(/\bwait_for_comments\b/g, "comments with wait")
    .replace(/\breply_to_comment\b/g, "comments with reply")
    .replace(/\bget_jsx\b/g, 'read with as: "jsx"')
    .replace(/\bexport_design\b/g, "read with export")
    .replace(/\bimport_design\b/g, 'an "import" op')
    .replace(/\b(create_page|rename_page|delete_page)\b/g, 'a "page" op')
    .replace(/\bmove_to_page\b/g, "a move op with page")
    .replace(/\bdelete_design\b/g, "designs with delete");
}

// ---------------------------------------------------------------- CSS

const norm = (sel) =>
  sel
    .replace(/\s+/g, " ")
    .replace(/\s*([>+~,])\s*/g, "$1")
    .trim();

function parseCss(css) {
  try {
    return postcss.parse(css);
  } catch (error) {
    throw new Error(`can't parse the CSS: ${error.reason ?? error.message}`);
  }
}

/** Each rule with its at-rule context, like {rule, context: "@media (max-width: 600px)"}. */
function rulesOf(container, context = "") {
  const out = [];
  for (const n of container.nodes ?? []) {
    if (n.type === "rule") out.push({ rule: n, context });
    else if (n.type === "atrule" && n.nodes && !/keyframes$/i.test(n.name))
      out.push(...rulesOf(n, `${context}@${n.name} ${n.params} `));
  }
  return out;
}

/**
 * Merges a patch sheet into a sheet's text: a rule with the same selector (in
 * the same at-rule) takes the patch's declarations, `prop: unset` removes
 * one, an empty rule removes the rule, and @keyframes replace by name.
 * Untouched rules keep their text. Returns {css, changes}.
 */
function mergeSheet(text, patch) {
  const sheet = parseCss(text);
  const changes = [];
  const mergeInto = (into, from, context) => {
    for (const p of from.nodes) {
      if (p.type === "rule") {
        const found = into.nodes?.find(
          (n) => n.type === "rule" && norm(n.selector) === norm(p.selector),
        );
        const decls = p.nodes.filter((d) => d.type === "decl");
        if (!decls.length) {
          if (found) {
            found.remove();
            changes.push(`removed ${context}${p.selector}`);
          }
          continue;
        }
        if (!found) {
          const copy = p.clone();
          copy.each((d) => {
            if (d.type === "decl" && d.value.trim() === "unset") d.remove();
          });
          if (copy.nodes.length) {
            copy.raws.before = "\n";
            into.append(copy);
            changes.push(`added ${context}${p.selector}`);
          }
          continue;
        }
        const what = [];
        for (const d of decls) {
          const same = found.nodes.filter((x) => x.type === "decl" && x.prop === d.prop);
          if (d.value.trim() === "unset") {
            if (same.length) what.push(`${d.prop}: ${same[0].value} → removed`);
            same.forEach((x) => x.remove());
          } else if (same.length) {
            if (same[0].value !== d.value) what.push(`${d.prop}: ${same[0].value} → ${d.value}`);
            same[0].value = d.value;
            same[0].important = d.important;
            same.slice(1).forEach((x) => x.remove());
          } else {
            found.append(d.clone());
            what.push(`${d.prop}: ${d.value} (new)`);
          }
        }
        changes.push(
          `${context}${p.selector}: ${what.length ? what.join(", ") : "already had those values"}`,
        );
      } else if (p.type === "atrule") {
        const found = into.nodes?.find(
          (n) => n.type === "atrule" && n.name === p.name && n.params.trim() === p.params.trim(),
        );
        if (p.nodes && !/keyframes$/i.test(p.name) && found)
          mergeInto(found, p, `${context}@${p.name} ${p.params} `);
        else {
          const copy = p.clone();
          copy.raws.before = found?.raws.before ?? "\n";
          if (found) found.replaceWith(copy);
          else into.append(copy);
          changes.push(`${found ? "replaced" : "added"} ${context}@${p.name} ${p.params}`.trim());
        }
      }
    }
  };
  mergeInto(sheet, patch, "");
  return { css: sheet.toString(), changes };
}

const inlineProps = (el) =>
  (el.attrs.style ?? "")
    .split(";")
    .map((d) => d.split(":")[0].trim().toLowerCase())
    .filter(Boolean);

/** Inline styles beat sheet rules: names the matched elements whose inline style sets the same property. */
function cascadeNotes(trees, patch, onlyBoards) {
  const notes = [];
  for (const { rule } of rulesOf(patch)) {
    const props = rule.nodes
      .filter((d) => d.type === "decl" && d.value.trim() !== "unset")
      .map((d) => d.prop.toLowerCase());
    if (!props.length) continue;
    let ms;
    try {
      ms = matchAll(trees, rule.selector, { loose: true });
    } catch {
      continue;
    }
    if (onlyBoards) ms = ms.filter((m) => onlyBoards.has(m.board));
    for (const prop of props) {
      const beat = ms.filter((m) =>
        inlineProps(m.el).some(
          (p) => p === prop || p.startsWith(prop + "-") || prop.startsWith(p + "-"),
        ),
      );
      if (beat.length)
        notes.push(
          `${beat.length} element${beat.length === 1 ? " sets" : "s set"} ${prop} inline, which beats ${rule.selector}: ${describeAll(beat)}. Use to: "inline", or {"op": "css", "css": "${rule.selector} { ${prop}: unset }", "to": "inline"} to drop the inline value.`,
        );
    }
  }
  return notes;
}

// Colors in any hex or rgb notation, for the tokens part of replace.
function parseColor(s) {
  const t = s.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)),
      a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1,
    };
  }
  m = t.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) {
    const a = m[4] == null ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { rgb: [m[1], m[2], m[3]].map(Number), a };
  }
  return null;
}
function replaceInCss(css, find, replace) {
  const from = parseColor(find);
  if (!from) {
    const n = css.split(find).length - 1;
    return { css: css.split(find).join(replace), n };
  }
  const to = parseColor(replace);
  let n = 0;
  const out = css.replace(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g, (m) => {
    const c = parseColor(m);
    if (!c || c.rgb.join() !== from.rgb.join()) return m;
    if (c.a < 1 && !to) return m;
    n++;
    return c.a < 1 ? `rgba(${to.rgb.join(", ")}, ${+c.a.toFixed(3)})` : replace;
  });
  return { css: out, n };
}

const declarations = (css) => {
  if (css == null) return {};
  if (typeof css === "object") return css;
  const out = {};
  for (const d of String(css).split(";")) {
    const at = d.indexOf(":");
    if (at > 0) out[d.slice(0, at).trim()] = d.slice(at + 1).trim();
  }
  return out;
};
/** The design's tokens and modes, as get_tokens gives them. */
const tokensOf = async (real, designId) => JSON.parse(await real.call("get_tokens", { designId }));
/** Each token's values as [name, mode or null, value]. */
const tokenValues = (t) =>
  Object.entries(t.tokens ?? {}).flatMap(([name, v]) =>
    typeof v === "string" ? [[name, null, v]] : Object.entries(v).map(([m, x]) => [name, m, x]),
  );

/** A design's id from its id or its name, so {"designId": "Acme site"} works. */
async function designIdOf(real, given) {
  const want = String(given).trim();
  // The list is the first block; notes about id matches or more designs follow it.
  const r = await real.callRaw("list_designs", { query: want, limit: 200 });
  const list = r.isError ? [] : JSON.parse(r.content[0].text);
  if (list.some((d) => d.designId === want)) return want;
  const named = list.filter((d) => d.name.toLowerCase() === want.toLowerCase());
  const hits = named.length ? named : list.length === 1 ? list : [];
  if (hits.length === 1) return hits[0].designId;
  const near = list.slice(0, 5).map((d) => `"${d.name}" (${d.designId})`);
  throw new Error(
    `there's no design "${want}"${hits.length > 1 ? " with one name" : ""}.${near.length ? ` Did you mean ${near.join(", ")}?` : " Call designs to list them."}`,
  );
}

/** A page's id from its id, its name or an @ref, with the pages for messages. */
async function pageIdOf(real, designId, page, refs) {
  const p = String(page).trim();
  if (p.startsWith("@") && refs?.has(p.slice(1))) return refs.get(p.slice(1));
  const { pages } = JSON.parse(await real.call("get_basic_info", { designId }));
  const hit =
    pages.find((x) => x.id === p) ?? pages.find((x) => x.name.toLowerCase() === p.toLowerCase());
  if (hit) return hit.id;
  throw new Error(
    `there's no page "${p}". Pages: ${pages.map((x) => `"${x.name}"`).join(", ")}. Add one with {"op": "page", "create": "${p}"}.`,
  );
}

/** The format a file name implies, as the web app's Import button does. */
const formatOf = (name) =>
  /\.figma\.json$/i.test(name)
    ? "figma"
    : /\.finite$/i.test(name)
      ? "finite"
      : /\.tar$/i.test(name)
        ? "repo"
        : "html";

// ---------------------------------------------------------------- edit ops

const EXAMPLES = {
  artboard: `{"op": "artboard", "name": "Home — mobile", "width": 390, "height": 844, "html": "<header data-name=\\"Nav\\">…</header>", "as": "m"}`,
  html: `{"op": "html", "select": "@m", "html": "<section data-name=\\"Features\\">…</section>", "mode": "append"}`,
  css: `{"op": "css", "css": "#k3x9a2bq { height: 1712px } .btn { border-radius: 999px }", "to": "inline"}`,
  attrs: `{"op": "attrs", "select": ".cta", "set": {"href": "/start", "data-name": "CTA"}}`,
  move: `{"op": "move", "select": "#a1b2c3d4", "to": "#list", "position": "prepend"}`,
  remove: `{"op": "remove", "select": "[data-name=Banner]"}`,
  replace: `{"op": "replace", "find": "#3b82f6", "replace": "#f97316"}`,
  page: `{"op": "page", "create": "Drafts", "as": "d"}`,
  tokens: `{"op": "tokens", "set": {"--brand": "#f97316", "--bg": {"Light": "#ffffff", "Dark": "#0b0b0b"}}, "modes": ["Light", "Dark"]}`,
  import: `{"op": "import", "name": "landing.html", "content": "<!doctype html>…", "page": "Inbox"}`,
};
const KINDS = Object.keys(EXAMPLES);
const ALIASES = {
  create_artboard: "artboard",
  write_html: "html",
  styles: "css",
  update_styles: "css",
  style: "css",
  attributes: "attrs",
  set_attributes: "attrs",
  attr: "attrs",
  delete: "remove",
  delete_nodes: "remove",
  move_nodes: "move",
  duplicate: "move",
  replace_values: "replace",
  pages: "page",
  create_page: "page",
  import_design: "import",
};
const MODES = {
  append: "append",
  beforeend: "append",
  prepend: "prepend",
  afterbegin: "prepend",
  before: "before",
  beforebegin: "before",
  after: "after",
  afterend: "after",
  inner: "inner",
  "replace-children": "inner",
  replace: "replace",
  outer: "replace",
};

const need = (op, kind, keys) => {
  const missing = keys.filter((k) => op[k] == null || (op[k] === "" && k !== "replace"));
  if (missing.length)
    throw new Error(`"${kind}" needs ${missing.join(" and ")}, like ${EXAMPLES[kind]}.`);
};

/** The op's kind, from "op" or, when it's left out, from its keys. */
function kindOf(op) {
  let k = op.op ?? op.type ?? op.kind ?? op.action;
  if (k != null) {
    k = String(k).toLowerCase();
    k = ALIASES[k] ?? k;
    if (!KINDS.includes(k))
      throw new Error(`there's no "${op.op ?? op.type}" op. Ops are ${KINDS.join(", ")}.`);
    return k;
  }
  if ((op.width != null || op.from != null) && op.name != null) return "artboard";
  if (op.content != null || op.contentBase64 != null) return "import";
  if (op.set != null && op.select == null) return "tokens";
  if (op.create != null || op.rename != null) return "page";
  if (op.find != null) return "replace";
  if (op.css != null || op.styles != null) return "css";
  if (op.html != null) return "html";
  if (op.set != null || op.attributes != null) return "attrs";
  if (op.to != null || op.x != null || op.copy != null) return "move";
  throw new Error(`say which op this is with "op": one of ${KINDS.join(", ")}.`);
}

/** Old habits: nodeIds, nodeId or targetId instead of select. */
function selectOf(op) {
  if (op.select != null) return op.select;
  const ids = op.nodeIds ?? op.nodeId ?? op.targetId ?? op.target;
  if (ids == null) return null;
  return [ids]
    .flat()
    .map((x) => (String(x).startsWith("#") || String(x).startsWith("@") ? x : `#${x}`))
    .join(", ");
}

/** Root ids in a real tool's outline: the unindented lines after its first line. */
const rootIds = (text) =>
  text
    .split("\n")
    .slice(1)
    .filter((l) => /^[a-z]/.test(l))
    .map((l) => l.match(/#([a-z0-9]+)/)?.[1])
    .filter(Boolean);

/** One edit call's state: the design, its @refs and what it touched. */
class Edit {
  constructor(real, designId) {
    this.real = real;
    this.designId = designId;
    this.refs = new Map();
    this.touched = new Set();
    this.cache = null;
  }
  async trees() {
    this.cache ??= await loadTrees(this.real, this.designId);
    return this.cache;
  }
  async write(tool, args) {
    this.cache = null;
    return this.real.call(tool, { designId: this.designId, ...args });
  }
  async match(select, what = "select") {
    const sel = selectorText(select, this.refs);
    const ms = matchAll(await this.trees(), sel);
    if (!ms.length)
      throw new Error(
        `${what} "${sel}" matches no element. read with contains or with no select lists what's there.`,
      );
    return ms;
  }
  touch(ms) {
    for (const m of ms) if (m.board) this.touched.add(m.board);
  }
  name(as, id) {
    if (as && id) this.refs.set(String(as).replace(/^@/, ""), id);
  }
}

// ---------------------------------------------------------------- keyed rewrites

// What this agent last read of each node with read as: "html", per design:
// the base of a three-way merge when it writes the node back.
const seenNodes = new Map();
const seenOf = (designId) => {
  if (!seenNodes.has(designId)) seenNodes.set(designId, new Map());
  return seenNodes.get(designId);
};

const styleMap = (el) => {
  const out = {};
  for (const d of String(el.attrs.style ?? "").split(";")) {
    const at = d.indexOf(":");
    if (at > 0)
      out[d.slice(0, at).trim().toLowerCase()] = d
        .slice(at + 1)
        .trim()
        .replace(/\s+/g, " ");
  }
  return out;
};
const attrMap = (el) => {
  const out = {};
  for (const [k, v] of Object.entries(el.attrs)) if (k !== "style" && k !== "data-id") out[k] = v;
  return out;
};
const textOnly = (el) => el.children.every((c) => c.tag === "#text");
const ownText = (el) =>
  RAW.has(el.tag) ? (el.text ?? "") : el.children.map((c) => c.text).join(" ");

/** A node's values as read: style and attributes by name, and its text when it holds only text. */
const snapshot = (el) => ({
  style: styleMap(el),
  attrs: attrMap(el),
  text: textOnly(el) ? ownText(el) : null,
});

function remember(designId, html) {
  const seen = seenOf(designId);
  for (const el of walk(parseHtml(html)))
    if (el.attrs["data-id"]) seen.set(el.attrs["data-id"], snapshot(el));
}

const escapeText = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function outerHtml(n) {
  if (n.tag === "#text") return escapeText(n.text);
  const attrs = Object.entries(n.attrs)
    .map(([k, v]) => ` ${k}="${String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`)
    .join("");
  if (VOID.has(n.tag)) return `<${n.tag}${attrs}>`;
  const inner = RAW.has(n.tag) ? (n.text ?? "") : n.children.map(outerHtml).join("");
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

/**
 * Three-way merge of one value: what the agent read (base), what is there now
 * (theirs) and what the agent wrote (mine). A value the agent didn't change
 * keeps whatever is there now, so another agent's later change survives.
 */
function merge3(base, theirs, mine) {
  if (mine === theirs) return { value: theirs, change: false };
  if (base === undefined) return { value: mine, change: true };
  if (mine === base) return { value: theirs, change: false, kept: theirs !== base };
  if (theirs !== base) return { value: theirs, change: false, conflict: true };
  return { value: mine, change: true };
}

/**
 * Writes html over an element (mode replace) or its children (mode inner) in
 * place, keeping every element whose data-id the html still carries: its id,
 * comment pins and history stay, only changed values are set, and values
 * another agent changed since this agent read them are kept. Returns null
 * when the html carries no ids from there, or moves kept elements to another
 * parent or order, so the op falls back to a plain write with new ids.
 */
async function keyedWrite(e, target, mode, html) {
  const top = parseHtml(html);
  const cur = target.el;
  let pairs;
  if (mode === "replace") {
    const roots = top.children.filter((c) => c.tag !== "#text" || c.text.trim());
    if (roots.length !== 1 || roots[0].attrs["data-id"] !== target.id) return null;
    pairs = [[cur, roots[0]]];
  } else pairs = [[cur, top]];
  const inside = new Map([...walk(cur)].map((n) => [n.attrs["data-id"], n]));
  if (![...walk(top)].some((n) => inside.has(n.attrs["data-id"]))) return null;

  const seen = seenOf(e.designId);
  const plan = { styles: [], attrs: [], texts: [], removes: [], inserts: [] };
  const notes = [];
  const visit = (old, mine, isRoot) => {
    const id = old.attrs["data-id"];
    const base = seen.get(id);
    if (!(isRoot && mode === "inner")) {
      const was = snapshot(old);
      const now = snapshot(mine);
      const styles = {};
      for (const k of new Set([...Object.keys(was.style), ...Object.keys(now.style)])) {
        const r = merge3(
          base ? (base.style[k] ?? null) : undefined,
          was.style[k] ?? null,
          now.style[k] ?? null,
        );
        if (r.change) styles[k] = r.value;
        if (r.kept)
          notes.push(
            `kept ${k}: ${was.style[k] ?? "(none)"} on ${label(old)}, which another agent set after you read it`,
          );
        if (r.conflict)
          notes.push(
            `kept ${k}: ${was.style[k] ?? "(none)"} on ${label(old)}: another agent changed it after you read it, so yours (${now.style[k] ?? "(none)"}) wasn't applied`,
          );
      }
      if (Object.keys(styles).length) plan.styles.push({ nodeIds: [id], styles });
      const attributes = {};
      for (const k of new Set([...Object.keys(was.attrs), ...Object.keys(now.attrs)])) {
        const r = merge3(
          base ? (base.attrs[k] ?? null) : undefined,
          was.attrs[k] ?? null,
          now.attrs[k] ?? null,
        );
        if (r.change) attributes[k] = r.value;
        if (r.conflict)
          notes.push(`kept ${k} on ${label(old)}: another agent changed it after you read it`);
      }
      if (Object.keys(attributes).length) plan.attrs.push({ nodeIds: [id], attributes });
      if (was.text !== null && now.text !== null) {
        const r = merge3(base ? (base.text ?? undefined) : undefined, was.text, now.text);
        if (r.change) plan.texts.push({ nodeId: id, text: r.value });
        if (r.conflict)
          notes.push(`kept the text of ${label(old)}: another agent changed it after you read it`);
        return true;
      }
      if (old.tag !== mine.tag) return false;
    }
    const oldKids = elements(old);
    const newKids = mine.children.filter((c) => c.tag !== "#text" || c.text.trim());
    const mixed = (n) => n.children.some((c) => c.tag === "#text") && elements(n).length;
    if ((mixed(old) || mixed(mine)) && textOf(old) !== textOf(mine)) return false;
    const kept = newKids.filter(
      (k) => k.tag !== "#text" && oldKids.some((o) => o.attrs["data-id"] === k.attrs["data-id"]),
    );
    const order = kept.map((k) =>
      oldKids.findIndex((o) => o.attrs["data-id"] === k.attrs["data-id"]),
    );
    if (order.some((x, i) => i && x < order[i - 1])) return false;
    for (const o of oldKids)
      if (!kept.some((k) => k.attrs["data-id"] === o.attrs["data-id"])) {
        if (newKids.some((k) => k.attrs?.["data-id"] === o.attrs["data-id"])) return false;
        // An element written somewhere else in the html moved: not handled in place.
        if ([...walk(top)].some((n) => n.attrs["data-id"] === o.attrs["data-id"])) return false;
        plan.removes.push(o.attrs["data-id"]);
      }
    for (const [i, k] of newKids.entries()) {
      if (k.tag === "#text") {
        if (!mixed(old)) return false;
        continue;
      }
      if (kept.includes(k)) {
        if (
          !visit(
            oldKids.find((o) => o.attrs["data-id"] === k.attrs["data-id"]),
            k,
            false,
          )
        )
          return false;
      } else {
        if (k.attrs["data-id"] && inside.has(k.attrs["data-id"])) return false;
        const { "data-id": _, ...attrs } = k.attrs;
        plan.inserts.push({ targetId: id, index: i, html: outerHtml({ ...k, attrs }) });
      }
    }
    return true;
  };
  for (const [old, mine] of pairs) if (!visit(old, mine, true)) return null;

  const out = [];
  if (plan.removes.length) out.push(await e.write("delete_nodes", { nodeIds: plan.removes }));
  if (plan.styles.length) out.push(await e.write("update_styles", { updates: plan.styles }));
  if (plan.attrs.length) out.push(await e.write("set_attributes", { updates: plan.attrs }));
  if (plan.texts.length) out.push(await e.write("set_text_content", { updates: plan.texts }));
  for (const ins of plan.inserts.sort((a, b) => a.index - b.index))
    out.push(await e.write("write_html", ins));
  const changed =
    plan.removes.length +
    plan.styles.length +
    plan.attrs.length +
    plan.texts.length +
    plan.inserts.length;
  const head = changed
    ? `Rewrote ${label(cur)} in place: elements that kept their data-id kept their ids, comments and history.`
    : `Nothing changed: ${label(cur)} already matches.`;
  return [head, ...notes.map((n) => `Note: ${n}.`), ...out].join("\n");
}

const OPS = {
  async artboard(op, e) {
    const pageId = op.page != null ? await pageIdOf(e.real, e.designId, op.page, e.refs) : null;
    if (op.from != null) return copyArtboard(op, e, pageId);
    need(op, "artboard", ["name", "width"]);
    const styles = { ...declarations(op.css), ...declarations(op.styles) };
    const text = await e.write("create_artboard", {
      name: op.name,
      width: op.width,
      ...(op.height != null && { height: op.height }),
      ...(op.x != null && { x: op.x }),
      ...(op.y != null && { y: op.y }),
      ...(op.html != null && { html: op.html }),
      ...(op.class != null && { class: op.class }),
      ...(Object.keys(styles).length && { styles }),
      ...(pageId && { pageId }),
    });
    const id = text.match(/artboard #([a-z0-9]+)/)?.[1];
    e.name(op.as, id);
    if (id) e.touched.add(id);
    if (id && op.mode != null)
      await e.write("set_artboard_mode", { artboardIds: [id], mode: String(op.mode) });
    return text;
  },

  async html(op, e) {
    const select = selectOf(op);
    need({ ...op, select }, "html", ["select", "html"]);
    const mode = MODES[String(op.mode ?? "append").toLowerCase()];
    if (!mode)
      throw new Error(
        `mode "${op.mode}" isn't one of append, prepend, before, after, inner, replace.`,
      );
    const ms = await e.match(select);
    if ((mode === "inner" || mode === "replace") && ms.length > 1)
      throw new Error(
        `"${select}" matches ${ms.length} elements; mode ${mode} takes one: ${describeAll(ms)}.`,
      );
    if ((mode === "inner" || mode === "replace") && ms[0].el) {
      const keyed = await keyedWrite(e, ms[0], mode, String(op.html));
      if (keyed != null) {
        e.touch(ms);
        return keyed;
      }
    }
    if (ms.length > 100) throw new Error(`"${select}" matches ${ms.length} elements; at most 100.`);
    const parts = [];
    let first = null;
    for (const m of ms) {
      let args;
      if (mode === "append") args = { targetId: m.id, html: op.html };
      else if (mode === "prepend") args = { targetId: m.id, html: op.html, index: 0 };
      else if (mode === "inner") args = { targetId: m.id, html: op.html, mode: "replace-children" };
      else if (mode === "replace") args = { targetId: m.id, html: op.html, mode: "replace" };
      else {
        const parent = m.el?.parent;
        if (!parent || parent.tag === "#root")
          throw new Error(
            `${m.el ? label(m.el) : `#${m.id}`} is an artboard, so nothing goes ${mode} it. Use an "artboard" op for a new screen.`,
          );
        const index = parent.children.indexOf(m.el) + (mode === "after" ? 1 : 0);
        args = { targetId: parent.attrs["data-id"], html: op.html, index };
      }
      const text = await e.write("write_html", args);
      first ??= rootIds(text)[0];
      const where = m.el ? label(m.el) : `#${m.id}`;
      parts.push(ms.length > 1 || mode !== "append" ? `${mode} ${where}: ${text}` : text);
    }
    e.touch(ms);
    e.name(op.as, first);
    return parts.join("\n");
  },

  async css(op, e) {
    const select = selectOf(op);
    let css = op.css;
    if (css == null && op.styles != null) {
      const d = declarations(op.styles);
      css = Object.entries(d)
        .map(([k, v]) => `${k}: ${v ?? "unset"}`)
        .join("; ");
    }
    need({ ...op, css }, "css", ["css"]);
    css = String(css);
    if (!css.includes("{")) {
      if (!select)
        throw new Error(
          `css takes rules, like "#k3x9a2bq { height: 1712px }", or select plus declarations, like {"op": "css", "select": ".btn", "css": "border-radius: 999px"}.`,
        );
      css = `${selectorText(select, e.refs)} { ${css} }`;
    } else
      css = css.replace(/@([\w-]+)/g, (m, name) => (e.refs.has(name) ? `#${e.refs.get(name)}` : m));
    // With rules, select limits them to inside its matches.
    const scope =
      select && String(op.css ?? "").includes("{")
        ? new Set((await e.match(select)).map((m) => m.el))
        : null;
    const inScope = (m) => {
      for (let n = m.el; n; n = n.parent) if (scope.has(n)) return true;
      return false;
    };
    const to = String(op.to ?? "inline").toLowerCase();
    const patch = parseCss(css);
    if (to === "inline") {
      const updates = [];
      const lines = [];
      for (const n of patch.nodes) {
        if (n.type === "comment") continue;
        if (n.type === "atrule")
          throw new Error(`inline styles can't hold @${n.name}; use to: "style".`);
        let ms = await e.match(n.selector, "css rule");
        if (scope) {
          ms = ms.filter(inScope);
          if (!ms.length)
            throw new Error(
              `css rule "${n.selector}" matches no element inside select "${select}".`,
            );
        }
        const styles = {};
        for (const d of n.nodes)
          if (d.type === "decl")
            styles[d.prop] =
              d.value.trim() === "unset" ? null : d.value + (d.important ? " !important" : "");
        updates.push({ nodeIds: ms.map((m) => m.id), styles });
        e.touch(ms);
        lines.push(`${n.selector} matched ${ms.length}`);
      }
      if (!updates.length) throw new Error(`the css has no rules, like ${EXAMPLES.css}.`);
      return await e.write("update_styles", { updates });
    }
    if (to === "shared" || to === "tokens")
      throw new Error(
        `there's no shared stylesheet. Put values every screen uses in tokens, like ${EXAMPLES.tokens}, and use them as var(--brand); put classes in each artboard's <style> with to: "style".`,
      );
    if (to !== "style") throw new Error(`to "${op.to}" isn't one of inline (default) or style.`);
    const trees = await e.trees();
    let boards = new Set();
    if (select) for (const m of await e.match(select)) boards.add(m.board);
    else
      for (const { rule } of rulesOf(patch))
        for (const m of matchAll(trees, rule.selector, { loose: true })) boards.add(m.board);
    if (!boards.size) {
      if (trees.boards.length === 1) boards.add(trees.boards[0].id);
      else
        throw new Error(
          `no element matches these rules yet, so it's unclear which artboard's <style> block they belong in. Pass select with the artboard, like "select": "#${trees.boards[0]?.id ?? "k3x9a2bq"}".`,
        );
    }
    const parts = [];
    for (const id of boards) {
      const board = trees.boards.find((b) => b.id === id);
      const style = [board.el, ...walk(board.el)].find((n) => n.tag === "style");
      if (style) {
        const { css: next, changes } = mergeSheet(style.text ?? "", patch);
        if (next === (style.text ?? "")) {
          parts.push(`<style> #${style.attrs["data-id"]} in "${board.name}" already had that.`);
          continue;
        }
        await e.write("set_text_content", {
          updates: [{ nodeId: style.attrs["data-id"], text: next }],
        });
        parts.push(`<style> #${style.attrs["data-id"]} in "${board.name}": ${changes.join("; ")}.`);
      } else {
        const text = await e.write("write_html", {
          targetId: id,
          html: `<style>${css}</style>`,
          index: 0,
        });
        parts.push(`New <style> block in "${board.name}": ${text.split("\n")[1] ?? text}`);
      }
      e.touched.add(id);
    }
    parts.push(...cascadeNotes(trees, patch, boards));
    return parts.join("\n");
  },

  async attrs(op, e) {
    const select = selectOf(op);
    const set = op.set ?? op.attributes ?? op.attrs;
    need({ ...op, select, set }, "attrs", ["select", "set"]);
    const ms = await e.match(select);
    e.touch(ms);
    return e.write("set_attributes", {
      updates: [
        {
          nodeIds: ms.map((m) => m.id),
          attributes: typeof set === "string" ? JSON.parse(set) : set,
        },
      ],
    });
  },

  async move(op, e) {
    const select = selectOf(op);
    need({ ...op, select }, "move", ["select"]);
    const ms = await e.match(select);
    e.touch(ms);
    const parts = [];
    if (op.mode !== undefined && op.to == null) {
      const notBoards = ms.filter((m) => m.board !== m.id);
      if (notBoards.length)
        throw new Error(`mode is for artboards, and ${describeAll(notBoards)} isn't one.`);
      parts.push(
        await e.write("set_artboard_mode", {
          artboardIds: ms.map((m) => m.id),
          ...(op.mode != null && { mode: String(op.mode) }),
        }),
      );
      if (op.page == null && op.x == null && op.y == null) return parts.join("\n");
    }
    if (op.page != null && op.to == null) {
      const notBoards = ms.filter((m) => m.board !== m.id);
      if (notBoards.length)
        throw new Error(
          `page moves artboards, and ${describeAll(notBoards)} ${notBoards.length === 1 ? "isn't one" : "aren't"}. Select artboards, like ":root" or "#k3x9a2bq".`,
        );
      const pageId = await pageIdOf(e.real, e.designId, op.page, e.refs);
      parts.push(await e.write("move_to_page", { artboardIds: ms.map((m) => m.id), pageId }));
      if (op.x == null && op.y == null) return parts.join("\n");
    }
    if (op.x != null || op.y != null) {
      const updates = ms.map((m) => {
        const b = e.cache?.boards.find((x) => x.id === m.id);
        return { nodeId: m.id, x: op.x ?? b?.x ?? 0, y: op.y ?? b?.y ?? 0 };
      });
      parts.push(await e.write("set_artboard_position", { updates }));
      if (op.to == null && !op.copy) return parts.join("\n");
    }
    let ids = ms.map((m) => m.id);
    if (op.copy || op.duplicate || String(op.op).toLowerCase() === "duplicate") {
      const text = await e.write("duplicate_nodes", { nodeIds: ids });
      parts.push(text);
      ids = rootIds(text);
      e.name(op.as, ids[0]);
      for (const id of ids) if (/artboard at/.test(text)) e.touched.add(id);
      if (op.to == null) return parts.join("\n");
    } else if (op.to == null)
      throw new Error(
        `"move" needs to (a selector, or "canvas" to make artboards), or x and y for an artboard, like ${EXAMPLES.move}.`,
      );
    if (String(op.to).toLowerCase() === "canvas") {
      parts.push(await e.write("move_nodes", { nodeIds: ids, parentId: null }));
      return parts.join("\n");
    }
    const [target, ...more] = await e.match(op.to, "to");
    if (more.length)
      throw new Error(
        `to "${op.to}" matches ${more.length + 1} elements; it takes one: ${describeAll([target, ...more])}.`,
      );
    const position = MODES[String(op.position ?? "append").toLowerCase()] ?? op.position;
    let args;
    if (position === "append") args = { parentId: target.id };
    else if (position === "prepend") args = { parentId: target.id, index: 0 };
    else if (position === "before" || position === "after") {
      const parent = target.el?.parent;
      if (!parent || parent.tag === "#root")
        throw new Error(
          `${label(target.el)} is an artboard; position ${position} needs an element inside one.`,
        );
      args = {
        parentId: parent.attrs["data-id"],
        index: parent.children.indexOf(target.el) + (position === "after" ? 1 : 0),
      };
    } else
      throw new Error(`position "${op.position}" isn't one of append, prepend, before, after.`);
    if (op.index != null && position === "append") args.index = op.index;
    e.touch([target]);
    parts.push(await e.write("move_nodes", { nodeIds: ids, ...args }));
    return parts.join("\n");
  },

  async remove(op, e) {
    const select = selectOf(op);
    need({ ...op, select }, "remove", ["select"]);
    const ms = await e.match(select);
    // Matches inside other matches mean select is broader than meant, like
    // :has(...) matching every ancestor: removing them would take the outer ones.
    const inside = (m) => ms.some((o) => o !== m && o.el && isAncestor(o.el, m.el));
    const outer = ms.filter((m) => m.el && ms.some((o) => o !== m && isAncestor(m.el, o.el)));
    if (ms.some(inside))
      throw new Error(
        `"${select}" matches ${ms.length} elements nested inside each other, so it would remove ${describeAll(outer)} with everything in ${outer.length === 1 ? "it" : "them"}. Narrow select to the elements you mean, like ":has(> h2:contains("…"))" for the element holding a heading.`,
      );
    for (const m of ms) if (m.board && m.board !== m.id) e.touched.add(m.board);
    return e.write("delete_nodes", { nodeIds: ms.map((m) => m.id) });
  },

  async replace(op, e) {
    need(op, "replace", ["find", "replace"]);
    const select = selectOf(op) ?? op.within;
    const extra = {
      ...(op.includeText != null && { includeText: op.includeText }),
      ...(op.all != null && { all: op.all }),
    };
    const parts = [];
    const trees = await e.trees();
    if (select) {
      const ms = await e.match(select);
      for (const m of ms)
        parts.push(
          await e.write("replace_values", {
            find: op.find,
            replace: op.replace,
            within: m.id,
            ...extra,
          }),
        );
      e.touch(ms);
      return parts.join("\n");
    }
    const text = await e.write("replace_values", { find: op.find, replace: op.replace, ...extra });
    parts.push(text);
    for (const id of text.match(/#[a-z0-9]{8}\b/g) ?? []) {
      const el = trees.byId.get(id.slice(1));
      if (el) e.touched.add(el.board);
    }
    const t = await tokensOf(e.real, e.designId);
    const set = {};
    for (const [name, mode, value] of tokenValues(t)) {
      const { css, n } = replaceInCss(value, String(op.find), String(op.replace));
      if (!n) continue;
      if (mode == null) set[name] = css;
      else set[name] = { ...(set[name] ?? t.tokens[name]), [mode]: css };
    }
    const names = Object.keys(set);
    if (names.length) {
      await e.write("set_tokens", { tokens: set });
      parts.push(`Tokens: replaced in ${names.join(", ")}.`);
      for (const b of trees.boards.slice(0, 10)) e.touched.add(b.id);
    }
    return parts.join("\n");
  },

  async tokens(op, e) {
    const set = typeof op.set === "string" ? JSON.parse(op.set) : (op.set ?? op.tokens);
    if (set == null && op.modes == null)
      throw new Error(`"tokens" needs set (and maybe modes), like ${EXAMPLES.tokens}.`);
    const text = await e.write("set_tokens", {
      tokens: set ?? {},
      ...(op.modes != null && { modes: [op.modes].flat() }),
    });
    for (const b of (await e.trees()).boards.slice(0, 10)) e.touched.add(b.id);
    return text;
  },

  async page(op, e) {
    if (op.create != null || (op.name != null && op.rename == null && op.remove == null)) {
      const name = String(op.create ?? op.name);
      const text = await e.write("create_page", { name });
      const id = text.match(/pageId "?([a-z0-9]+)"?/i)?.[1] ?? text.match(/\b([a-z0-9]{8})\b/)?.[1];
      e.name(op.as, id);
      return text;
    }
    if (op.rename != null) {
      need(op, "page", ["name"]);
      const pageId = await pageIdOf(e.real, e.designId, op.rename, e.refs);
      await e.write("rename_page", { pageId, name: op.name });
      return `Renamed page "${op.rename}" to "${op.name}".`;
    }
    if (op.remove != null) {
      const pageId = await pageIdOf(e.real, e.designId, op.remove, e.refs);
      return e.write("delete_page", { pageId });
    }
    throw new Error(
      `"page" takes create, rename (with name) or remove, like ${EXAMPLES.page}, {"op": "page", "rename": "Drafts", "name": "Archive"} or {"op": "page", "remove": "Drafts"}.`,
    );
  },

  async import(op, e) {
    if (op.content == null && op.contentBase64 == null)
      throw new Error(
        `"import" needs the file as content (text) or contentBase64 (bytes), like ${EXAMPLES.import}. Finite can't read files on your machine, so read the file and pass its text.`,
      );
    const pageId = op.page != null ? await pageIdOf(e.real, e.designId, op.page, e.refs) : null;
    const name = op.name ?? op.file ?? op.path;
    const text = await e.write("import_design", {
      format: op.format ?? formatOf(String(name ?? "")),
      ...(op.content != null && { content: op.content }),
      ...(op.contentBase64 != null && { contentBase64: op.contentBase64 }),
      ...(name != null && { name: String(name).split("/").pop() }),
      ...(pageId && { pageId }),
      ...(op.strict != null && { strict: op.strict }),
    });
    const ids = text.match(/#[a-z0-9]{8}\b/g) ?? [];
    for (const id of ids.slice(0, 10)) e.touched.add(id.slice(1));
    e.name(op.as, ids[0]?.slice(1));
    return text;
  },
};

/** An artboard op with from: a copy of another artboard, renamed, resized and moved. */
async function copyArtboard(op, e, pageId) {
  const [src, ...more] = await e.match(op.from, "from");
  if (more.length || src.board !== src.id)
    throw new Error(
      `from takes one artboard, like "from": "#k3x9a2bq"; "${op.from}" matches ${more.length ? `${more.length + 1} elements` : "an element inside one"}.`,
    );
  const text = await e.write("duplicate_nodes", { nodeIds: [src.id] });
  const id = rootIds(text)[0] ?? text.match(/#([a-z0-9]{8})\b/)?.[1];
  if (!id) throw new Error(`couldn't copy ${label(src.el)}: ${text}`);
  const parts = [`Copied ${label(src.el)} as #${id}.`];
  if (op.name != null) await e.write("rename_nodes", { updates: [{ nodeId: id, name: op.name }] });
  const styles = { ...declarations(op.css), ...declarations(op.styles) };
  if (op.width != null) styles.width = `${op.width}px`;
  if (op.height != null) styles.height = `${op.height}px`;
  if (Object.keys(styles).length)
    await e.write("update_styles", { updates: [{ nodeIds: [id], styles }] });
  if (pageId) await e.write("move_to_page", { artboardIds: [id], pageId });
  if (op.x != null || op.y != null)
    await e.write("set_artboard_position", {
      updates: [{ nodeId: id, x: op.x ?? 0, y: op.y ?? 0 }],
    });
  if (op.html != null) await e.write("write_html", { targetId: id, html: op.html });
  e.name(op.as, id);
  e.touched.add(id);
  parts.push(await e.real.call("get_tree_summary", { designId: e.designId, nodeId: id, depth: 2 }));
  return parts.join("\n");
}

/** The ops of an edit call: ops (a list, one op or a JSON string), or one op flat. */
function opsOf(a) {
  let ops = a.ops;
  if (typeof ops === "string") {
    try {
      ops = JSON.parse(ops);
    } catch {
      throw new Error(
        `ops isn't valid JSON. Pass a list of ops, like {"ops": [${EXAMPLES.replace}]}.`,
      );
    }
  }
  if (ops == null) {
    const flat = { ...a };
    for (const k of ["designId", "status", "check", "ops"]) delete flat[k];
    if (!Object.keys(flat).length) {
      if (a.status != null) return [];
      throw new Error(
        `pass ops, or one op flat, like {"designId": "…", ${EXAMPLES.replace.slice(1)}.`,
      );
    }
    ops = [flat];
  }
  return [ops].flat();
}

// Per design: how many real undo steps each of the agent's edits made.
const stacks = new Map();
const stackOf = (id) => {
  if (!stacks.has(id)) stacks.set(id, { undo: [], redo: [] });
  return stacks.get(id);
};
const historyLength = async (real, designId) =>
  JSON.parse(await real.call("get_history", { designId })).undo.length;

async function layoutCheck(real, designId, boards) {
  const out = [];
  const list = [...boards].slice(0, 10);
  for (const id of list) {
    const r = await real.callRaw("get_layout", { designId, nodeId: id, depth: 0 });
    if (r.isError) {
      out.push(
        `Layout check of #${id} failed: ${retool(r.content.map((c) => c.text ?? "").join(" "))}`,
      );
      continue;
    }
    const text = r.content.map((c) => c.text ?? "").join("\n");
    const at = text.indexOf("Layout:");
    if (at < 0) continue;
    const name = text.match(/^\w+ "([^"]*)" #/)?.[1];
    const check = retool(text.slice(at));
    out.push(list.length > 1 ? `Artboard${name ? ` "${name}"` : ""} #${id}: ${check}` : check);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- read

async function overview(real, designId, depth, pageId) {
  const info = JSON.parse(await real.call("get_basic_info", { designId }));
  const me = process.env.FINITE_AGENT;
  const others = (info.agentsWorking ?? []).filter((a) => a.name !== me);
  const n = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const lines = [
    `Design "${info.name}" (designId "${info.designId}"): ${n(info.artboardCount, "artboard")}, ${n(info.nodeCount, "node")}, ${n(info.openComments, "open comment")}, ${n(info.tokenCount ?? 0, "token")}.`,
  ];
  if (info.pages?.length > 1 || pageId)
    lines.push(
      `Pages: ${info.pages.map((p) => `"${p.name}" (${p.id}, ${n(info.artboards.filter((b) => b.pageId === p.id).length, "artboard")})`).join(", ")}.`,
    );
  for (const a of others)
    lines.push(
      `${a.name} is working on ${a.nodeIds.map((i) => `#${i}`).join(", ")}${a.status ? `: "${a.status}"` : ""}. Edits never wait for each other, and rewriting html you read keeps values others changed since.`,
    );
  if (info.openComments) lines.push(`Open comments: call comments to read them.`);
  if (!info.artboardCount)
    return lines.concat(`No artboards yet. Add one with edit: ${EXAMPLES.artboard}`).join("\n");
  const pageName = (id) => info.pages?.find((p) => p.id === id)?.name ?? id;
  if (pageId || info.pages?.length > 1) {
    const parts = [];
    for (const p of info.pages.filter((x) => !pageId || x.id === pageId)) {
      const boards = info.artboards.filter((b) => b.pageId === p.id);
      const trees = [];
      for (const b of boards)
        trees.push(
          await real.call("get_tree_summary", {
            designId,
            nodeId: b.id,
            ...(depth != null && { depth }),
          }),
        );
      parts.push(`Page "${pageName(p.id)}":\n${trees.join("\n") || "(no artboards)"}`);
    }
    return `${lines.join("\n")}\n\n${parts.join("\n\n")}`;
  }
  const tree = await real.call("get_tree_summary", { designId, ...(depth != null && { depth }) });
  return `${lines.join("\n")}\n\n${tree}`;
}

async function search(real, designId, contains, within) {
  const scopes = within?.length ? within : [null];
  const sections = [];
  for (const [key, what] of [
    ["style", "styles (inline and <style> blocks)"],
    ["text", "text"],
    ["attribute", "attributes"],
    ["name", "layer names"],
  ]) {
    const found = [];
    for (const w of scopes) {
      const r = await real.callRaw("find_nodes", {
        designId,
        [key]: contains,
        ...(w && { within: w }),
      });
      const t = r.content.map((c) => c.text ?? "").join("\n");
      if (r.isError) throw new Error(t);
      if (!t.startsWith("No elements match")) found.push(t);
    }
    if (found.length) sections.push(`In ${what}: ${found.join("\n")}`);
  }
  if (!within?.length) {
    const color = parseColor(contains);
    const hits = tokenValues(await tokensOf(real, designId)).filter(([name, , v]) =>
      color
        ? (v.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []).some(
            (m) => parseColor(m)?.rgb.join() === color.rgb.join(),
          )
        : `${name} ${v}`.toLowerCase().includes(contains.toLowerCase()),
    );
    if (hits.length)
      sections.push(
        `In tokens:\n${hits.map(([n, m, v]) => `  ${n}${m ? ` (${m})` : ""}: ${v}`).join("\n")}`,
      );
  }
  if (!sections.length)
    return `Nothing ${within?.length ? "in the selection" : "in the design"} contains "${contains}": not in styles, <style> blocks, text, attributes, layer names${within?.length ? "" : " or tokens"}.`;
  return retool(sections.join("\n\n"));
}

async function cssView(real, designId, trees, ms) {
  if (!ms) {
    const t = await tokensOf(real, designId);
    const blocks = [];
    for (const b of trees.boards)
      for (const s of [...walk(b.el)].filter((n) => n.tag === "style")) {
        const rules = rulesOf(parseCssSafe(s.text ?? "")).length;
        blocks.push(
          `  <style> #${s.attrs["data-id"]} in "${b.name}" #${b.id}: ${rules} rule${rules === 1 ? "" : "s"}`,
        );
      }
    return [
      tokenValues(t).length
        ? `Tokens (CSS variables every artboard can use as var(--name); modes: ${t.modes.join(", ")}):\n${JSON.stringify(t.tokens, null, 2)}${t.artboardModes ? `\nArtboards in another mode: ${JSON.stringify(t.artboardModes)}` : ""}`
        : `This design has no tokens. Add some with ${EXAMPLES.tokens}.`,
      blocks.length
        ? `<style> blocks (read one with select and as: "html"):\n${blocks.join("\n")}`
        : "No <style> blocks.",
    ].join("\n\n");
  }
  const sheets = [];
  for (const b of trees.boards)
    for (const s of [...walk(b.el)].filter((n) => n.tag === "style"))
      sheets.push({
        origin: `<style> #${s.attrs["data-id"]}`,
        sheet: parseCssSafe(s.text ?? ""),
        board: b.id,
      });
  const out = [];
  for (const m of ms.slice(0, 20)) {
    if (!m.el) continue;
    const lines = [`${label(m.el)}`, `  inline: ${m.el.attrs.style ?? "(none)"}`];
    for (const { origin, sheet, board } of sheets) {
      if (board && board !== m.board) continue;
      for (const { rule, context } of rulesOf(sheet)) {
        let hit = false;
        try {
          hit = parseSelector(rule.selector).some((s) =>
            matchAt(m.el, s, s.compounds.length - 1, true),
          );
        } catch {}
        if (hit) lines.push(`  ${origin}: ${context}${rule.toString().replace(/\s+/g, " ")}`);
      }
    }
    const inl = inlineProps(m.el);
    if (inl.length) lines.push(`  Inline styles beat sheet rules for: ${inl.join(", ")}.`);
    out.push(lines.join("\n"));
  }
  if (ms.length > 20) out.push(`Showing 20 of ${ms.length} matches. Narrow select for the rest.`);
  return out.join("\n\n");
}
function parseCssSafe(t) {
  try {
    return postcss.parse(t);
  } catch {
    return postcss.parse("");
  }
}

// ---------------------------------------------------------------- tools

const SELECT = {
  type: ["string", "array"],
  items: { type: "string" },
  description:
    'A CSS selector: #k3x9a2bq (a node id), .card, button, [data-name="Hero"] h1, :root (artboards), :contains("Sign in"). A list of selectors works too.',
};

const EDIT_DESCRIPTION = `Make changes to a design. One edit call is one transaction: its ops run in order, all or nothing (if one fails, nothing changes and the error names it), and undo reverses the whole call as one step. Pass ops as a list, or one op flat at the top level: {"designId": "…", "op": "replace", "find": "#3b82f6", "replace": "#f97316"}.

Ops, each addressed with select, a CSS selector: #k3x9a2bq (a node id), .card, button, [data-name=Hero] h1, :root (every artboard), :contains("text"):

${EXAMPLES.artboard}
  A new screen with its first sections. desktop 1440x900, tablet 768x1024, mobile 390x844. Omit x and y to place it right of the others; omit height to grow with the content. css (declarations) and class style the artboard itself. page: a page's name or id (default the first); mode: the mode its tokens come from, like "Dark". from: "#k3x9a2bq" starts it as a copy of that artboard, with the given name and size, so a mobile version keeps the content and you only restyle it.
${EXAMPLES.html}
  mode: append (default, last child), prepend (first child), before or after (a sibling), inner (replace the children), replace (replace the element). append and the others act on every match; inner and replace take one. Use inner on an element to change its text. With inner or replace, elements that keep the data-id from read's html are updated in place: they keep their ids, comment pins and history, and a value another agent changed since you read it is kept, and named in the result.
${EXAMPLES.css}
  css is a stylesheet; each rule's selector picks elements. to: "inline" (default) sets the declarations in each match's style attribute (so #id { height: … } resizes an artboard); "style" merges the rules into the matching artboard's <style> block (use it for classes, :hover, @media, @keyframes). Values every screen shares go in tokens. Rules merge: a declaration replaces the same property, prop: unset removes it, an empty rule .x {} removes the rule. Or pass select and plain declarations: {"op": "css", "select": ".btn", "css": "border-radius: 999px"}. With rules, select limits them to inside its matches (with to: "style", it picks the artboard).
${EXAMPLES.attrs}
  Sets attributes on every match; null removes one. data-name is the layer name. data-id can't change; style goes through a css op.
${EXAMPLES.move}
  to: a selector of one element, or "canvas" to make artboards. position: append (default), prepend, before, after, relative to to. copy: true moves copies instead (without to, a copy lands right after its original; copied artboards go into free space). For an artboard, x and y set its canvas position.
${EXAMPLES.remove}
  Deletes every match with everything inside it.
${EXAMPLES.replace}
  A value everywhere: inline styles, attributes, <style> blocks, <script> code and token values. A color matches in any notation, and tints keep their alpha. includeText: true also replaces visible text (a product name, a typo). select limits it to matches. replace "" deletes it.
${EXAMPLES.page}
  Pages hold artboards; people see one page at a time. create, {"rename": "Drafts", "name": "Archive"} or {"remove": "Drafts"} (deletes the page and its artboards). Put artboards on a page with the artboard op's page, or {"op": "move", "select": "#k3x9a2bq", "page": "Drafts"}.
${EXAMPLES.tokens}
  Tokens are CSS variables every artboard can use as var(--brand). Give a token one value, a value per mode, or null to delete it; tokens you don't pass stay. modes names the design's modes in order: the first renames the first mode, more add modes. A mode without a value uses the first mode's. An artboard renders in one mode: the artboard op's mode, or {"op": "move", "select": "#k3x9a2bq", "mode": "Dark"}.
${EXAMPLES.import}
  Adds a file as new artboards: an .html page, a .finite bundle, a .figma.json from the Finite Figma plugin, or a repo .tar (contentBase64). Pass the file's text as content (Finite can't read your files). Scripts, handlers and embeds are dropped; the result lists what didn't convert exactly.

"as": "m" names what an op creates (an artboard, the first root of html, the first copy of a move, a page); later ops in the same call use "@m" in select or page.

status: a few words shown to people watching ("Making the mobile version").
A layout check of the artboards the edit touched follows every result: content cut off by the artboard's edge, text overflowing its box or overlapping other text, with the css op that fixes an artboard's height. check: false skips it.
dryRun: true reports what the ops would change, and changes nothing. Use it before a broad replace or remove.

Returns one numbered section per op: the nodes each changed or created, with their ids.

Example, a mobile copy in one call:
{"designId": "…", "status": "Mobile version", "ops": [
  {"op": "artboard", "name": "Landing — mobile", "width": 390, "height": 844, "html": "<header data-name=\\"Nav\\" style=\\"…\\">…</header>", "as": "m"},
  {"op": "html", "select": "@m", "html": "<section data-name=\\"Features\\" style=\\"…\\">…</section>"},
  {"op": "html", "select": "@m", "html": "<footer data-name=\\"Footer\\">…</footer>"}]}`;

const READ_DESCRIPTION = `Look at a design, as text.

- No select: an overview (pages, artboards, open comments, who else is working, how many tokens), then an outline of every artboard: one line per element with its tag, layer name, #id, size and text. Start here. page: "Inbox" shows only that page's artboards, here and with select.
- select (a CSS selector: #k3x9a2bq, .card, button, [data-name="Hero"] h1, :root for artboards, :contains("Sign in")) with as:
  "outline" (default): the outline under each match. depth sets how deep (default 4).
  "html": each match's HTML with inline styles; every element carries data-id. depth limits it.
  "css": the CSS that applies to each match: its inline style, then each matching rule from its artboard's <style> blocks, and which properties inline styles override.
  "jsx": each match as JSX to paste into a React codebase, with style objects, or Tailwind classes with tailwind: true.
- export: "figma" returns the design (or select's artboard) as a file's text: "html", "finite" (a bundle that imports back exactly), "repo" (a tar of text files for git), "figma" (for the Finite Figma plugin) or "jsx", with what didn't convert exactly. Save the text to a file yourself.
- as: "css" without select: the design's tokens and modes, and a list of every <style> block.
- contains: "#3b82f6" searches instead: elements whose styles (inline or in <style> blocks), text, attributes or layer name contain it, plus matching tokenss. A color matches in any notation. With select, it searches inside the matches. Use it instead of reading whole artboards, before and after a change.

designId takes the design's id or its exact name.

Examples: {"designId": "…"} · {"designId": "…", "select": "[data-name=Hero]", "as": "html"} · {"designId": "…", "contains": "Clould"} · {"designId": "…", "select": ".btn", "as": "css"} · {"designId": "…", "export": "figma"}`;

/** Rewords errors and text results from every tool into this surface's words. */
function reworded(tools) {
  for (const tool of Object.values(tools)) {
    const run = tool.run;
    tool.run = async (a, real) => {
      try {
        if (a.designId != null) a = { ...a, designId: await designIdOf(real, a.designId) };
        const out = await run(a, real);
        return typeof out === "string" ? retool(out) : out;
      } catch (error) {
        throw new Error(retool(error.message));
      }
    };
  }
  return tools;
}

export default {
  instructions: `Finite is a design canvas for agents. A design holds artboards: fixed-size frames on an infinite canvas, made of plain HTML and CSS. People watch live, move, resize and delete things too, and steer you by pinning comments.

There are six tools. Each one's description has its full grammar and examples, so load them all at once.

- designs: find a design (query), create one (create: "Name"), rename one, or delete one for good (delete).
- read: look at a design. With no select, an overview (pages, artboards, open comments, who is working) and every artboard's outline with ids. select is a CSS selector, where #k3x9a2bq is a node's id; as: "outline", "html", "css" or "jsx". contains: "#3b82f6" searches styles, text, attributes, <style> blocks and shared CSS. export: "figma" (or html, finite, repo, jsx) returns a file's text to save.
- edit: every change. Its ops run in order as one transaction: all or nothing, one undo step. Ops: artboard, html, css, attrs, move, remove, replace, tokens, page, import. Each result ends with a layout check. status: "…" shows people what you're doing; dryRun: true previews.
- render: an image of what select matches (every artboard by default), or output: "layout" for each element's box as text.
- comments: open comments; wait: 60 blocks until a new one arrives; reply: [{commentId, message, resolve: true}].
- undo: reverses your own last edit calls; redo: true redoes.

Every tool but designs takes a designId: the design's id or exact name. Other agents may edit the same design, so re-read before changing nodes you didn't create.

Workflow: designs, then read, then edit. A new screen is one artboard op holding its first sections (desktop 1440x900, tablet 768x1024, mobile 390x844), then html ops for the rest; from: "#id" starts it as a copy of another artboard. Fix what the layout check reports, and render to see it. Pages keep drafts or flows apart: a page op makes one, and the artboard op's page puts a screen on it. Import a file with an import op, passing its text. To change a value everywhere (a brand color, in any notation), use one replace op. Put values several screens share (colors, fonts, spacing) in tokens with a tokens op, and use them as var(--brand); modes like Light and Dark give each token a value per mode, and an artboard's mode picks one.

HTML: inline styles or <style> blocks with classes. Prefer flexbox and gap. Name layers with data-name="Header". box-sizing is border-box. <img src="https://…"> and inline <svg> work. Artboards are white flex columns with overflow hidden, so children shrink unless they have flex-shrink: 0. A <style> or <script> only affects its own artboard. Scripts run sandboxed: inline only, no network, addEventListener (on* attributes are dropped). render waits about 3 seconds after load.

Comments are user requests pinned to an element. When read shows open comments: call comments, make the change, check it, then reply saying what you changed, with resolve: true. Your reply links your edits to that artboard since the thread's last message. If a comment is unclear, ask in a reply and leave it open.

Long results end with a note saying how to get the rest. Errors say what to do instead.`,

  drop: "all",

  tools: reworded({
    designs: {
      description: `List, create, rename or delete designs (canvases).

- {} or {"query": "Acme"}: designs whose name contains query (or whose id starts with it), most recently edited first, with id, name, artboard count and last edit. limit (default 50, at most 200).
- {"create": "Checkout flow"}: a new, empty design. Returns its designId.
- {"designId": "…", "rename": "New name"}: renames it.
- {"delete": "…"}: deletes that design (its id or exact name) for good, with its pages, artboards, comments and history. It can't be undone. To delete only an artboard, use edit's remove op.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Part of a design's name, or the start of its id.",
          },
          limit: { type: "integer" },
          create: { type: "string", description: "Create a design with this name." },
          designId: { type: "string", description: "With rename: the design to rename." },
          rename: { type: "string", description: "The new name for designId." },
          delete: {
            type: "string",
            description: "A design's id or exact name to delete permanently.",
          },
        },
      },
      annotations: { readOnlyHint: false },
      async run(a, real) {
        if (a.create) return retool(await real.call("create_design", { name: a.create }));
        if (a.delete != null) {
          const designId = await designIdOf(real, a.delete);
          await real.call("delete_design", { designId });
          return `Deleted design ${designId} permanently.`;
        }
        if (a.rename != null) {
          if (!a.designId)
            throw new Error(`rename needs designId, like {"designId": "…", "rename": "New name"}.`);
          await real.call("rename_design", { designId: a.designId, name: a.rename });
          return `Renamed the design to "${a.rename}".`;
        }
        return real.call("list_designs", {
          ...(a.query != null && { query: a.query }),
          ...(a.limit != null && { limit: a.limit }),
        });
      },
    },

    read: {
      description: READ_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          select: SELECT,
          as: {
            type: "string",
            enum: ["outline", "html", "css", "jsx"],
            description: 'What to show for select: "outline" (default), "html", "css" or "jsx".',
          },
          tailwind: { type: "boolean", description: 'With as: "jsx", Tailwind classes.' },
          page: { type: "string", description: "Only this page's artboards: its name or id." },
          export: {
            type: "string",
            enum: ["html", "finite", "repo", "figma", "jsx"],
            description: "Return the design, or select's artboard, as a file in this format.",
          },
          contains: {
            type: "string",
            description: 'Search for this text or value, like "#3b82f6" or "Sign in".',
          },
          depth: {
            type: "integer",
            description: "How many levels below each match (or each artboard) to show.",
          },
        },
        required: ["designId"],
      },
      annotations: { readOnlyHint: true },
      async run(a, real) {
        const designId = a.designId;
        const as = a.as ?? a.view;
        const pageId = a.page != null ? await pageIdOf(real, designId, a.page) : null;
        const trees = a.select != null || as === "css" ? await loadTrees(real, designId) : null;
        let ms = null;
        if (a.select != null) {
          const sel = selectorText(a.select);
          ms = matchAll(trees, sel);
          if (pageId) {
            const on = new Set(trees.boards.filter((b) => b.pageId === pageId).map((b) => b.id));
            ms = ms.filter((m) => on.has(m.board));
          }
          if (!ms.length)
            throw new Error(
              `"${sel}" matches no element${pageId ? ` on page "${a.page}"` : ""}. read with no select shows the outline with every id.`,
            );
        }
        const format = a.export ?? (as === "file" ? a.format : null);
        if (format != null) {
          const boards = [...new Set((ms ?? []).map((m) => m.board))];
          if (boards.length > 1)
            throw new Error(
              `export takes the whole design, or one artboard; "${a.select}" is on ${boards.length}. Pass one artboard, or no select.`,
            );
          if (String(format) === "jsx" && !boards.length)
            throw new Error(`export "jsx" takes one artboard: pass select, like "#k3x9a2bq".`);
          return real.call("export_design", {
            designId,
            format: String(format),
            ...(boards[0] && { artboardId: boards[0] }),
          });
        }
        if (as === "jsx") {
          if (!ms)
            throw new Error(`as: "jsx" needs select, like {"select": "#k3x9a2bq", "as": "jsx"}.`);
          const parts = [];
          for (const m of ms.slice(0, 10))
            parts.push(
              await real.call("get_jsx", {
                designId,
                nodeId: m.id,
                ...(a.tailwind != null && { tailwind: a.tailwind }),
              }),
            );
          if (ms.length > 10) parts.push(`Showing 10 of ${ms.length} matches. Narrow select.`);
          return parts.join("\n\n");
        }
        if (a.contains != null && a.contains !== "")
          return search(
            real,
            designId,
            String(a.contains),
            ms?.map((m) => m.id),
          );
        if (as === "css") return cssView(real, designId, trees, ms);
        if (!ms) {
          if (as === "html")
            throw new Error(
              `as: "html" needs select, like {"select": ":root", "as": "html"} for every artboard.`,
            );
          return overview(real, designId, a.depth, pageId);
        }
        const shown = ms.slice(0, 20);
        const parts = [];
        for (const [i, m] of shown.entries()) {
          const board = trees.boards.find((b) => b.id === m.board);
          const where =
            board && board.id !== m.id ? ` · artboard "${board.name}" #${board.id}` : "";
          const head = ms.length > 1 ? `<!-- ${i + 1} of ${ms.length}${where} -->\n` : "";
          const text =
            as === "html"
              ? await real.call("get_html", {
                  designId,
                  nodeId: m.id,
                  ...(a.depth != null && { depth: a.depth }),
                })
              : await real.call("get_tree_summary", {
                  designId,
                  nodeId: m.id,
                  ...(a.depth != null && { depth: a.depth }),
                });
          if (as === "html") remember(designId, text);
          parts.push(head + retool(text).trimEnd());
        }
        if (ms.length > shown.length)
          parts.push(`Showing 20 of ${ms.length} matches. Narrow select for the rest.`);
        return parts.join("\n\n");
      },
    },

    edit: {
      description: EDIT_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          ops: {
            type: "array",
            items: { type: "object" },
            description: `The changes, in order: ${KINDS.join(", ")}. See the description for each op's fields. One op can go at the top level instead.`,
          },
          op: {
            type: "string",
            description: "For one op passed flat, with its fields at the top level.",
          },
          status: {
            type: "string",
            description: 'A few words shown to people watching, like "Restyling pricing".',
          },
          check: {
            type: "boolean",
            description:
              "A layout check of the artboards this edit touched follows the result. false skips it.",
          },
          dryRun: {
            type: "boolean",
            description: "Report what the ops would change, then change nothing.",
          },
        },
        required: ["designId"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      async run(a, real) {
        const { designId } = a;
        const ops = opsOf(a);
        const e = new Edit(real, designId);
        const start = await historyLength(real, designId);
        const sections = [];
        let heuristic = 0;
        for (const [i, raw] of ops.entries()) {
          let kind = "op";
          try {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              throw new Error(`each op is an object, like ${EXAMPLES.css}.`);
            kind = kindOf(raw);
            const text = await OPS[kind](raw, e);
            if (!/^Nothing changed|^Found no /.test(text)) heuristic++;
            sections.push(`${i + 1}. ${kind}: ${retool(text).trimEnd()}`);
          } catch (error) {
            const now = await historyLength(real, designId).catch(() => start);
            const applied = now === 200 && start === 200 ? heuristic : now - start;
            let undone = "";
            if (applied > 0) {
              await real.call("undo", { designId, steps: applied }).catch(() => {});
              undone = i
                ? ` The ${i === 1 ? "op" : `${i} ops`} before it ${i === 1 ? "was" : "were"} rolled back.`
                : "";
            }
            const msg = retool(error.message).replace(/\.?$/, ".");
            throw new Error(
              `op ${i + 1}${kind === "op" ? "" : ` (${kind})`}: ${msg} Nothing was changed.${undone}`,
            );
          }
        }
        const end = await historyLength(real, designId);
        const steps = end === 200 && start === 200 ? heuristic : end - start;
        if (steps > 0) {
          const s = stackOf(designId);
          s.undo.push(steps);
          s.redo = [];
        }
        if (a.status != null) {
          const ids = [...e.touched];
          if (a.status === "") await real.call("finish_working_on_nodes", { designId });
          else if (ids.length)
            await real.call("start_working_on_nodes", { designId, nodeIds: ids, status: a.status });
          else if (!ops.length) {
            const info = JSON.parse(await real.call("get_basic_info", { designId }));
            const all = info.artboards.map((b) => b.id).slice(0, 10);
            if (all.length)
              await real.call("start_working_on_nodes", {
                designId,
                nodeIds: all,
                status: a.status,
              });
          }
        }
        const head = !ops.length
          ? a.status
            ? `People now see "${a.status}".`
            : "No ops, so nothing changed."
          : steps > 0
            ? `Changed the design in one step (${ops.length} op${ops.length === 1 ? "" : "s"}); undo reverses all of it.`
            : `Nothing changed: the design already looked like that.`;
        const out = [head, ...sections];
        if (a.check !== false && e.touched.size && !a.dryRun)
          out.push(await layoutCheck(real, designId, e.touched));
        if (a.dryRun && steps > 0) {
          await real.call("undo", { designId, steps });
          stackOf(designId).undo.pop();
          out[0] = `Dry run: nothing was changed. Without dryRun, this edit would make ${ops.length} op${ops.length === 1 ? "" : "s"} as one step:`;
        }
        return out.join("\n");
      },
    },

    render: {
      description: `Render what select matches to check how it looks. Each image is cropped to its element's box; with no select, every artboard (up to 10). A whole artboard's image comes with a layout check naming anything cut off by its edge and text that overflows its box, with the edit that fixes the artboard's height.

output: "layout" returns text instead of an image: each element's box in px from its artboard's top-left corner (x,y width×height), where its text sits when that's much smaller than its box, then the layout check (cut-off, overflowing and overlapping text). Use it to place things over content, like pins or badges, and to check a layout cheaply.

select: a CSS selector (#k3x9a2bq, [data-name=Hero], :root for every artboard), at most 10 matches. padding adds CSS pixels around each image; scale (0.25 to 3) helps read small text; revealOverflow shows content past the artboard's edge; settleMs (default 3000, at most 10000) waits longer for animations. depth (layout only, default 4).

Examples: {"designId": "…", "select": "#m0b1l3aa"} · {"designId": "…", "select": ".card", "padding": 16} · {"designId": "…", "output": "layout"}`,
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          select: SELECT,
          output: { type: "string", enum: ["image", "layout"] },
          padding: { type: "number" },
          scale: { type: "number" },
          revealOverflow: { type: "boolean" },
          settleMs: { type: "integer" },
          depth: { type: "integer" },
        },
        required: ["designId"],
      },
      annotations: { readOnlyHint: true },
      async run(a, real) {
        const { designId } = a;
        let ids = null;
        if (a.select != null) {
          const sel = selectorText(a.select);
          const ms = matchAll(await loadTrees(real, designId), sel);
          if (!ms.length)
            throw new Error(`"${sel}" matches no element. read shows the outline with every id.`);
          if (ms.length > 10)
            throw new Error(
              `"${sel}" matches ${ms.length} elements; one render takes at most 10. Narrow select: ${describeAll(ms)}.`,
            );
          ids = ms.map((m) => m.id);
        }
        const fix = (r) => ({
          ...r,
          content: r.content.map((c) => (c.type === "text" ? { ...c, text: retool(c.text) } : c)),
        });
        if ((a.output ?? "image") === "layout") {
          const parts = [];
          for (const id of ids ?? [null]) {
            const r = await real.callRaw("get_layout", {
              designId,
              ...(id && { nodeId: id }),
              ...(a.depth != null && { depth: a.depth }),
            });
            const t = retool(r.content.map((c) => c.text ?? "").join("\n"));
            if (r.isError) throw new Error(t);
            parts.push(t.trimEnd());
          }
          return parts.join("\n\n");
        }
        const r = await real.callRaw("get_screenshot", {
          designId,
          ...(ids && { nodeIds: ids }),
          ...(a.padding != null && { padding: a.padding }),
          ...(a.scale != null && { scale: a.scale }),
          ...(a.revealOverflow != null && { revealOverflow: a.revealOverflow }),
          ...(a.settleMs != null && { settleMs: a.settleMs }),
        });
        return fix(r);
      },
    },

    comments: {
      description: `The comments people pinned to a design, and your replies to them.

- {"designId": "…"}: open comments, oldest first: what was asked, the artboard, the element (its select and HTML), and the thread so far. includeResolved: true adds resolved ones; offset pages through a long list.
- {"designId": "…", "wait": 60}: blocks until a comment or reply is waiting for an agent (open, with a person's message last), then returns those. Returns at once if some already are, or says none arrived after wait seconds (at most 300). Loop on it to keep taking feedback.
- {"designId": "…", "reply": [{"commentId": "…", "message": "Made it an underlined link.", "resolve": true}]}: replies, one or several at once. Say what you changed, with resolve: true, or ask a question and leave it open. A reply links your edits to the comment's artboard since the thread's last message.`,
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          wait: {
            type: ["integer", "boolean"],
            description: "Seconds to wait for a new comment (true is 60).",
          },
          reply: {
            type: "array",
            items: {
              type: "object",
              properties: {
                commentId: { type: "string" },
                message: { type: "string" },
                resolve: { type: "boolean" },
              },
              required: ["commentId", "message"],
            },
          },
          includeResolved: { type: "boolean" },
          offset: { type: "integer" },
        },
        required: ["designId"],
      },
      annotations: { readOnlyHint: false },
      async run(a, real) {
        const { designId } = a;
        if (a.reply != null) {
          const list = [a.reply].flat();
          const out = [];
          for (const [i, r] of list.entries()) {
            if (!r?.commentId || !r?.message)
              throw new Error(
                `reply ${i + 1} needs commentId and message, like {"reply": [{"commentId": "…", "message": "Made it a link.", "resolve": true}]}.${out.length ? ` Replies before it were sent:\n${out.join("\n")}` : ""}`,
              );
            const text = await real.call("reply_to_comment", {
              designId,
              commentId: r.commentId,
              message: r.message,
              ...(r.resolve != null && { resolve: r.resolve }),
            });
            out.push(list.length > 1 ? `${r.commentId}: ${text}` : text);
          }
          return retool(out.join("\n"));
        }
        const text =
          a.wait != null && a.wait !== false
            ? await real.call("wait_for_comments", {
                designId,
                timeoutSeconds: a.wait === true ? 60 : a.wait,
              })
            : await real.call("get_comments", {
                designId,
                ...(a.includeResolved != null && { includeResolved: a.includeResolved }),
                ...(a.offset != null && { offset: a.offset }),
              });
        try {
          const list = JSON.parse(text);
          if (Array.isArray(list))
            return JSON.stringify(
              list.map(({ nodeId, alsoSelected, ...c }) => ({
                ...c,
                ...(nodeId && { select: `#${nodeId}` }),
                ...(alsoSelected?.length && {
                  alsoSelected: alsoSelected.map((x) =>
                    x?.nodeId ? { ...x, select: `#${x.nodeId}` } : x,
                  ),
                }),
              })),
              null,
              2,
            );
        } catch {}
        return retool(text);
      },
    },

    undo: {
      description: `Undo your own most recent edit calls on a design: each edit call is one step, whatever it contained. Other agents' changes are never undone, and steps whose nodes someone else deleted are skipped. redo: true redoes edits you undid instead. steps: how many (default 1).

Examples: {"designId": "…"} · {"designId": "…", "steps": 2} · {"designId": "…", "redo": true}`,
      inputSchema: {
        type: "object",
        properties: {
          designId: { type: "string" },
          steps: { type: "integer" },
          redo: { type: "boolean" },
        },
        required: ["designId"],
      },
      annotations: { readOnlyHint: false },
      async run(a, real) {
        const { designId } = a;
        const s = stackOf(designId);
        const [from, to] = a.redo ? [s.redo, s.undo] : [s.undo, s.redo];
        const asked = Math.max(1, a.steps ?? 1);
        // Edits made before this mock tracked them count one real step each.
        const n = from.length ? Math.min(asked, from.length) : asked;
        const moved = from.length ? from.splice(-n).reverse() : [];
        const realSteps = moved.length ? moved.reduce((x, y) => x + y, 0) : n;
        const text = await real.call(a.redo ? "redo" : "undo", { designId, steps: realSteps });
        if (text.startsWith("Nothing to")) return text;
        to.push(...moved);
        const verb = a.redo ? "Redid" : "Undid";
        const labels = text.replace(/^(Undid|Redid):\s*/, "");
        return `${verb} ${n === 1 ? "your last edit" : `your last ${n} edits`} (${labels}).`;
      },
    },
  }),
};
