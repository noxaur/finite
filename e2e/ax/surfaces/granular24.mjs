// granular24: the "24 normalised tools, CSS written as CSS" redesign
// (scratchpad design/design.md, sketch.rs, instructions.md), mocked over the
// real server so agents can try it before any Rust changes.
//
//   node e2e/ax/run.mjs --task restyle --runs 1 --label g24 --surface e2e/ax/surfaces/granular24.mjs
//
// Every tool is answered by real tools. What the real server can't do is
// approximated in JS here:
//
// - write_css parses CSS in JS (rules, @-blocks, `prop: unset`) and matches
//   selectors against get_html output parsed in JS (tag, *, #id, .class,
//   [attr], [attr=|~=|^=|$=|*=v], and the combinators " ", >, +, ~; no
//   pseudo-classes). `#id` means a node id (data-id) or an id attribute.
//   Inline: one update_styles call. Style: merged in JS, then one
//   set_text_content (plus a write_html when an artboard has no <style>
//   yet, a second undo step). Shared: get_shared_css, merge, set_shared_css.
//   The cascade note compares inline style property names with the rule's.
//   Elements that get_html cuts off on a very large artboard aren't matched.
// - check: true runs get_layout on the touched artboards after the edit and
//   appends its "Layout:" block. status calls start_working_on_nodes after
//   the edit. Neither runs under the edit's lock, as the proposal would.
// - Edits that the proposal makes one call (set_attributes with data-name and
//   other attributes, move_nodes mixing x/y with reparenting, replace_values
//   reaching shared CSS, reply_to_comment with updates) are several real
//   calls here, so they can be several undo steps.
// - replace_values on the shared CSS matches hex and rgb()/rgba() colors in
//   any of those notations, keeping each use's alpha, or plain text otherwise.
//   find_nodes searches the shared CSS the same way, for its `style` filter.
// - get_tree_summary's header line comes from get_basic_info. offset pages
//   through what the real outline returned (it is cut at 60,000 bytes).
// - get_html depth 0 is the real depth-0 HTML plus a line from get_node_info
//   (parent, artboard, child ids).
// - undo/redo name the next step from get_history.
// - Missing: structuredContent (Claude Code shows only text blocks, and the
//   checks read the real server), argument aliases being hidden from the
//   schema's `required` (fields with aliases aren't listed as required, and
//   the run checks them), registry-derived undo labels (real labels are kept).
import { idAfter } from "../../mcp.mjs";

const LIMIT = 60_000;

// ───────────── shared vocabulary helpers ─────────────

const NODE_IDS = {
  type: ["array", "string"],
  items: { type: "string" },
  description: "One node id or a list.",
};
const DESIGN = {
  type: "string",
  description: "The design (canvas) id, from list_designs or create_design.",
};
const STATUS = {
  type: "string",
  description: 'Short note shown to people watching, like "Restyling pricing". Optional.',
};
const CHECK = {
  type: ["boolean", "string"],
  description:
    "true: append a layout check of the touched artboards (cut-off content, text overflow, overlapping text).",
};
const edit = (props) => ({ designId: DESIGN, ...props, status: STATUS, check: CHECK });
const schema = (properties, required = ["designId"]) => ({ type: "object", properties, required });

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const bad = (msg) => new Error(`failed to deserialize parameters: ${msg}`);

/** Lenient: JSON in a string, or a lone value where a list is expected. */
function list(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        return list(JSON.parse(t));
      } catch {}
    }
    return t.split(/\s*,\s*/).filter(Boolean);
  }
  return Array.isArray(v) ? v.flat().map(String) : [String(v)];
}
const obj = (v) => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
};
const bool = (v) => v === true || v === 1 || v === "true" || v === "1";
const num = (v) => (v === undefined || v === null || v === "" ? undefined : Number(v));
/** The first of these keys present in `a`. */
const pick = (a, ...keys) => {
  for (const k of keys) if (a[k] !== undefined) return a[k];
  return undefined;
};
const ids = (a) => list(pick(a, "nodeIds", "nodeId", "ids", "id", "node"));

/** Batch<T>: the flat form, `updates`, or both. */
function batch(a, itemKeys, example) {
  let items = [];
  if (a.updates !== undefined) {
    const u = obj(a.updates);
    items = Array.isArray(u) ? u.map(obj) : [u];
  }
  if (itemKeys.some((k) => a[k] !== undefined)) {
    const flat = {};
    for (const [k, v] of Object.entries(a))
      if (!["designId", "updates", "status", "check"].includes(k)) flat[k] = v;
    items.push(flat);
  }
  if (!items.length) throw bad(`pass a change like ${example} or updates: [${example}]`);
  return items;
}

// ───────────── reply wording ─────────────

/** Real replies name tools this surface doesn't have; these say what to use instead. */
function words(text) {
  return String(text)
    .replace(
      /update_styles \{"updates": \[\{"nodeIds": \["([a-z0-9]+)"\], "styles": \{"([\w-]+)": "([^"]+)"\}\}\]\}/g,
      (_, id, prop, value) => `write_css {"css": "#${id} { ${prop}: ${value} }"}`,
    )
    .replaceAll("Next: write_html into it.", "Next: add_html into it.")
    .replaceAll(`use mode "replace-children" instead`, "use replace_html with contents: true")
    .replaceAll(
      "use update_styles to change inline styles",
      "use write_css to change inline styles",
    )
    .replaceAll("get_children without a nodeId", "get_tree_summary with depth 1 and offset")
    .replaceAll("get_children", "get_tree_summary with depth 1")
    .replaceAll("get_basic_info", "get_tree_summary")
    .replaceAll("get_node_info", "get_html with depth 0")
    .replaceAll("get_shared_css", "get_css")
    .replaceAll("set_shared_css", 'write_css with to: "shared"')
    .replaceAll("update_styles", "write_css")
    .replaceAll("write_html", "add_html")
    .replaceAll("rename_nodes", "set_attributes with data-name")
    .replaceAll("set_artboard_position", "move_nodes with x and y")
    .replaceAll("start_working_on_nodes", "status on an edit")
    .replaceAll("find_placement", "create_artboard");
}

/** One error shape: `<what>. <instead>.`, with the shared not-found hint. */
function errorText(message, designId) {
  let text = words(message);
  const m = text.match(/^node "([^"]*)" not found$/);
  if (m)
    text =
      m[1] === designId
        ? `node "${m[1]}" not found. "${m[1]}" is the designId; pass an artboard's id (get_tree_summary lists them).`
        : m[1].startsWith("#")
          ? `node "${m[1]}" not found. Pass ids without the "#", like "${m[1].slice(1)}".`
          : `node "${m[1]}" not found. Call get_tree_summary to list ids.`;
  return text;
}

const reply = (payload, ...notes) => ({
  content: [payload, ...notes.filter(Boolean)].map((t) => ({ type: "text", text: String(t) })),
});

/** Wraps a tool's run: argument errors and real-server errors read in this surface's words. */
const tool = (def) => ({
  ...def,
  async run(a, real) {
    try {
      const out = await def.run(a, real);
      if (typeof out === "string") return reply(words(out));
      return {
        ...out,
        content: out.content.map((c) => (c.type === "text" ? { ...c, text: words(c.text) } : c)),
      };
    } catch (error) {
      throw new Error(errorText(error.message, a.designId));
    }
  },
});

// ───────────── reading the design ─────────────

const info = async (real, designId) => JSON.parse(await real.call("get_basic_info", { designId }));

async function nodeInfo(real, designId, nodeIds) {
  if (!nodeIds.length) return [];
  const out = [];
  for (let i = 0; i < nodeIds.length; i += 100)
    out.push(
      ...JSON.parse(
        (
          await real.call("get_node_info", { designId, nodeIds: nodeIds.slice(i, i + 100) })
        ).replace(/\n\n[A-Z][^\n]*$/, ""),
      ),
    );
  return out;
}

/** The artboards these nodes are in (unknown ids are skipped). */
async function artboardsOf(real, designId, nodeIds) {
  const unique = [...new Set(nodeIds)].slice(0, 200);
  const found = await nodeInfo(real, designId, unique).catch(() => []);
  return [...new Set(found.filter((n) => !n.error).map((n) => n.artboardId ?? n.id))];
}

/** Node ids an edit reply names. */
const idsIn = (text) => [...String(text).matchAll(/#([a-z0-9]{8})\b/g)].map((m) => m[1]);

/** status and check: the parts of every edit that run after the commit. */
async function after(real, a, out, touched) {
  const notes = [];
  const boards = touched.length ? await artboardsOf(real, a.designId, touched) : [];
  if (a.status) {
    let nodeIds = boards;
    if (!nodeIds.length) nodeIds = (await info(real, a.designId)).artboards.map((b) => b.id);
    if (nodeIds.length)
      await real
        .call("start_working_on_nodes", {
          designId: a.designId,
          nodeIds: nodeIds.slice(0, 100),
          status: String(a.status),
        })
        .catch(() => {});
  }
  if (bool(a.check)) {
    if (!boards.length)
      notes.push("Layout: no artboard was touched, so there was nothing to check.");
    for (const board of boards.slice(0, 6)) {
      const layout = await real
        .call("get_layout", { designId: a.designId, nodeId: board })
        .catch((e) => `Layout: couldn't check #${board}: ${e.message}`);
      const at = layout.indexOf("Layout:");
      const block = (at >= 0 ? layout.slice(at) : layout).trim();
      notes.push(boards.length > 1 ? `#${board} ${block}` : block);
    }
    if (boards.length > 6)
      notes.push(`Checked the first 6 of ${boards.length} artboards; get_layout checks the rest.`);
  }
  return reply(out, ...notes);
}

// A small HTML reader for get_html output: elements with tag, attributes, parent and children.
const VOID = new Set("area base br col embed hr img input link meta source track wbr".split(" "));
const RAW = new Set(["style", "script", "textarea", "title"]);
const decode = (s) =>
  s
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

function parseHtml(html, artboard) {
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  const all = [];
  let cur = root;
  const re =
    /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      let n = cur;
      while (n !== root && n.tag !== tag) n = n.parent;
      if (n !== root) cur = n.parent;
      continue;
    }
    if (!m[2]) continue;
    const tag = m[2].toLowerCase();
    const attrs = {};
    for (const a of m[3].matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))
      attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    const el = { tag, attrs, children: [], parent: cur, artboard, text: "" };
    cur.children.push(el);
    all.push(el);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      const stop = end < 0 ? html.length : end;
      el.text = html.slice(re.lastIndex, stop);
      re.lastIndex = stop;
      const close = html.indexOf(">", stop);
      re.lastIndex = close < 0 ? html.length : close + 1;
    } else if (!m[4] && !VOID.has(tag)) cur = el;
  }
  return all;
}

const inlineStyles = (el) => {
  const out = {};
  for (const [p, v] of declarations(el.attrs.style ?? "")) out[p] = v;
  return out;
};

/** Every artboard's elements, read with get_html. */
async function readDesign(real, designId, boardIds) {
  const boards = boardIds ?? (await info(real, designId)).artboards.map((b) => b.id);
  const elements = [];
  for (const id of boards) {
    const html = await real.call("get_html", { designId, nodeId: id, maxValueLength: 200_000 });
    elements.push(...parseHtml(html, id));
  }
  return elements.filter((e) => e.attrs["data-id"]);
}

// ───────────── selectors ─────────────

/** Parses one complex selector into [{combinator, compound}], or throws for what it can't match. */
function parseSelector(sel) {
  const parts = [];
  let i = 0;
  let comb = " ";
  const s = sel.trim();
  const ident = () => {
    const m = s.slice(i).match(/^(?:\\.|[\w-])+/);
    if (!m) throw new Error(`can't read the selector "${sel}"`);
    i += m[0].length;
    return m[0].replace(/\\(.)/g, "$1");
  };
  while (i < s.length) {
    const c = { tag: null, ids: [], classes: [], attrs: [] };
    let any = false;
    while (i < s.length && !/[\s>+~]/.test(s[i])) {
      any = true;
      const ch = s[i];
      if (ch === "*") i++;
      else if (ch === "#") (i++, c.ids.push(ident()));
      else if (ch === ".") (i++, c.classes.push(ident()));
      else if (ch === "[") {
        const end = s.indexOf("]", i);
        if (end < 0) throw new Error(`can't read the selector "${sel}"`);
        const m = s
          .slice(i + 1, end)
          .match(
            /^\s*([\w:-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))\s*(i)?)?\s*$/,
          );
        if (!m) throw new Error(`can't read the selector "${sel}"`);
        c.attrs.push({
          name: m[1].toLowerCase(),
          op: m[2],
          value: m[3] ?? m[4] ?? m[5],
          ci: !!m[6],
        });
        i = end + 1;
      } else if (ch === ":") {
        throw new Error(`pseudo`);
      } else c.tag = ident().toLowerCase();
    }
    if (!any) throw new Error(`can't read the selector "${sel}"`);
    parts.push({ comb, c });
    const m = s.slice(i).match(/^\s*([>+~])?\s*/);
    comb = m[1] ?? " ";
    i += m[0].length;
  }
  return parts;
}

function matchCompound(el, c) {
  if (!el || el.tag === "#root") return false;
  if (c.tag && el.tag !== c.tag) return false;
  for (const id of c.ids) if (el.attrs["data-id"] !== id && el.attrs.id !== id) return false;
  const classes = (el.attrs.class ?? "").split(/\s+/);
  for (const k of c.classes) if (!classes.includes(k)) return false;
  for (const a of c.attrs) {
    let v = a.name === "data-name" ? el.attrs["data-name"] : el.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    let want = a.value;
    if (a.ci) ((v = v.toLowerCase()), (want = want.toLowerCase()));
    const ok = {
      "=": v === want,
      "~=": v.split(/\s+/).includes(want),
      "^=": v.startsWith(want),
      "$=": v.endsWith(want),
      "*=": v.includes(want),
      "|=": v === want || v.startsWith(want + "-"),
    }[a.op];
    if (!ok) return false;
  }
  return true;
}

function matchParts(el, parts, i) {
  if (!matchCompound(el, parts[i].c)) return false;
  if (i === 0) return true;
  const comb = parts[i].comb;
  if (comb === ">") return matchParts(el.parent, parts, i - 1);
  if (comb === " ") {
    for (let p = el.parent; p && p.tag !== "#root"; p = p.parent)
      if (matchParts(p, parts, i - 1)) return true;
    return false;
  }
  const sibs = el.parent.children;
  const at = sibs.indexOf(el);
  if (comb === "+") return at > 0 && matchParts(sibs[at - 1], parts, i - 1);
  for (let j = at - 1; j >= 0; j--) if (matchParts(sibs[j], parts, i - 1)) return true;
  return false;
}

const splitTop = (text, sep) => {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
};

/** Elements a selector list matches, or null when it uses pseudo-classes. */
function select(elements, selector) {
  const lists = [];
  for (const one of splitTop(selector, ",")) {
    try {
      lists.push(parseSelector(one));
    } catch (e) {
      if (e.message === "pseudo") return null;
      throw e;
    }
  }
  return elements.filter((el) => lists.some((parts) => matchParts(el, parts, parts.length - 1)));
}
const hasPseudo = (selector) => /:/.test(selector.replace(/\[[^\]]*\]/g, ""));

// ───────────── CSS ─────────────

/** Declarations in a block body, as [prop, value] pairs. */
function declarations(body) {
  const out = [];
  for (const part of splitTop(body.replace(/\/\*[\s\S]*?\*\//g, ""), ";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    let prop = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (!prop || !value) continue;
    if (!prop.startsWith("--")) prop = prop.toLowerCase();
    out.push([prop, value]);
  }
  return out;
}

/** A stylesheet as items: rules {selector, decls, raw} and @-blocks {prelude, body, raw}. */
function parseSheet(text) {
  const items = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (i >= n) break;
    const start = i;
    let quote = null;
    while (i < n) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{" || ch === ";") break;
      i++;
    }
    const prelude = text.slice(start, i).trim();
    if (i >= n || text[i] === ";") {
      if (prelude) items.push({ statement: true, prelude, raw: text.slice(start, i + 1).trim() });
      i++;
      continue;
    }
    let depth = 0;
    const open = i;
    for (; i < n; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) break;
    }
    const body = text.slice(open + 1, i);
    const raw = text.slice(start, i + 1).trim();
    i++;
    if (prelude.startsWith("@")) items.push({ prelude, body, raw });
    else items.push({ selector: prelude, decls: declarations(body), raw });
  }
  return items;
}

const keyOf = (s) =>
  s
    .replace(/\s+/g, " ")
    .replace(/\s*([,>+~])\s*/g, "$1")
    .trim();
const NESTED = /^@(media|supports|container|layer|document)\b/i;
const ruleText = (r) => `${r.selector} { ${r.decls.map(([p, v]) => `${p}: ${v}`).join("; ")} }`;

/** Merges `incoming` rules into `sheet`: declarations merge, `unset` removes one, `{}` removes a rule. */
function mergeSheet(sheetText, incoming) {
  const items = parseSheet(sheetText);
  let changed = 0;
  for (const add of incoming) {
    if (add.statement) {
      if (!items.some((it) => it.statement && it.raw === add.raw)) (items.unshift(add), changed++);
      continue;
    }
    if (add.prelude !== undefined) {
      const at = items.findLastIndex(
        (it) =>
          !it.statement && it.prelude !== undefined && keyOf(it.prelude) === keyOf(add.prelude),
      );
      if (NESTED.test(add.prelude) && at >= 0) {
        const body = mergeSheet(items[at].body, parseSheet(add.body));
        if (body.changed) {
          items[at] = {
            ...items[at],
            body: body.text,
            raw: `${items[at].prelude} {\n${indent(body.text)}\n}`,
          };
          changed++;
        }
      } else if (at >= 0) {
        if (items[at].raw !== add.raw) ((items[at] = add), changed++);
      } else if (add.body.trim()) (items.push(add), changed++);
      continue;
    }
    const at = items.findLastIndex(
      (it) => it.selector !== undefined && keyOf(it.selector) === keyOf(add.selector),
    );
    if (!add.decls.length) {
      if (at >= 0) (items.splice(at, 1), changed++);
      continue;
    }
    const rule =
      at >= 0
        ? { ...items[at], decls: [...items[at].decls] }
        : { selector: add.selector.trim(), decls: [] };
    let touched = false;
    for (const [p, v] of add.decls) {
      const j = rule.decls.findIndex(([q]) => q === p);
      if (/^unset$/i.test(v)) {
        if (j >= 0) (rule.decls.splice(j, 1), (touched = true));
      } else if (j >= 0) {
        if (rule.decls[j][1] !== v) ((rule.decls[j] = [p, v]), (touched = true));
      } else (rule.decls.push([p, v]), (touched = true));
    }
    if (!touched) continue;
    changed++;
    if (!rule.decls.length) {
      if (at >= 0) items.splice(at, 1);
      continue;
    }
    rule.raw = ruleText(rule);
    if (at >= 0) items[at] = rule;
    else items.push(rule);
  }
  return { text: items.map((it) => it.raw).join("\n"), changed, rules: items.length };
}
const indent = (t) =>
  t
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");

/** The rules in a sheet that select elements, including those inside @media. */
const flatRules = (items) =>
  items.flatMap((it) =>
    it.selector !== undefined
      ? [it]
      : it.prelude && NESTED.test(it.prelude)
        ? flatRules(parseSheet(it.body))
        : [],
  );

const overlapsProp = (a, b) => a === b || a.startsWith(b + "-") || b.startsWith(a + "-");

/** Inline styles that beat a rule just written into a sheet. */
function cascadeNote(elements, items) {
  const beaten = new Map();
  for (const rule of flatRules(items)) {
    if (hasPseudo(rule.selector)) continue;
    let matched;
    try {
      matched = select(elements, rule.selector) ?? [];
    } catch {
      continue;
    }
    for (const el of matched) {
      const inline = Object.keys(inlineStyles(el));
      for (const [p, v] of rule.decls) {
        if (/^unset$/i.test(v) || p.startsWith("--")) continue;
        const hit = inline.find((q) => overlapsProp(p, q));
        if (!hit) continue;
        const key = hit;
        if (!beaten.has(key)) beaten.set(key, new Set());
        beaten.get(key).add(el.attrs["data-id"]);
      }
    }
  }
  const notes = [];
  for (const [prop, set] of beaten) {
    const list = [...set];
    const shown = list.slice(0, 12).map((id) => `#${id}`);
    notes.push(
      `${list.length} element${list.length === 1 ? "" : "s"} set ${prop} inline, which beats this rule: ${shown.join(", ")}${list.length > 12 ? ` and ${list.length - 12} more` : ""}. ` +
        `To clear them: write_css {"css": "${shown.join(", ")} { ${prop}: unset }"}`,
    );
  }
  return notes.join("\n") || null;
}

// ───────────── colors, for shared CSS search and replace ─────────────

function parseColor(s) {
  const t = s.trim().toLowerCase();
  let m = t.match(/^#([0-9a-f]{3,8})$/);
  if (m && [3, 4, 6, 8].includes(m[1].length)) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = t.match(
    /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/,
  );
  if (m) {
    const ch = (v) =>
      v.endsWith("%") ? Math.round(parseFloat(v) * 2.55) : Math.round(parseFloat(v));
    const a =
      m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]), a };
  }
  return null;
}
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;
const sameRgb = (x, y) => x.r === y.r && x.g === y.g && x.b === y.b;

/** Replaces `find` in CSS text: colors in any notation (keeping each use's alpha), else text. */
function replaceInCss(css, find, replace) {
  const want = parseColor(find);
  const changes = [];
  let text;
  if (want) {
    const to = parseColor(replace);
    text = css.replace(COLOR_RE, (use) => {
      const c = parseColor(use);
      if (!c || !sameRgb(c, want) || (want.a !== 1 && Math.abs(c.a - want.a) > 0.01)) return use;
      const out =
        c.a < 1 && to && want.a === 1
          ? `rgba(${to.r}, ${to.g}, ${to.b}, ${+c.a.toFixed(3)})`
          : replace;
      changes.push([use, out]);
      return out;
    });
  } else {
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    text = css.replace(re, (use) => (changes.push([use, replace]), replace));
  }
  return { text, changes };
}

/** Shared CSS declarations a find_nodes `style` filter matches. */
function searchCss(css, style) {
  const want = parseColor(style);
  const lines = [];
  for (const rule of flatRules(parseSheet(css))) {
    const hits = rule.decls.filter(([p, v]) => {
      const decl = `${p}: ${v}`;
      if (decl.toLowerCase().includes(style.toLowerCase())) return true;
      return (
        want &&
        (v.match(COLOR_RE) ?? []).some((u) => {
          const c = parseColor(u);
          return c && sameRgb(c, want);
        })
      );
    });
    if (hits.length || rule.selector.toLowerCase().includes(style.toLowerCase()))
      lines.push(`  ${rule.selector}${hits.map(([p, v]) => `\n    ${p}: ${v}`).join("")}`);
  }
  return lines;
}

const sharedCss = async (real, designId) => {
  const css = await real.call("get_shared_css", { designId });
  return css === "This design has no shared CSS." ? "" : css;
};

// ───────────── the tools ─────────────

/** Splits get_html's trailing notes from the HTML into their own blocks. */
function splitNotes(text) {
  const at = text.search(/\n\n(?=[A-Z0-9])/);
  if (at < 0) return [text];
  return [
    text.slice(0, at),
    ...text
      .slice(at + 2)
      .split("\n")
      .filter(Boolean),
  ];
}

const tools = {
  list_designs: tool({
    description:
      "List designs, most recently edited first. Pass query to find one by name (case-insensitive part of it).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the design's name." },
        limit: { type: "integer", description: "At most this many. Default 50." },
      },
    },
    annotations: { readOnlyHint: true },
    run: (a, real) => real.call("list_designs", a),
  }),

  create_design: tool({
    description:
      "Create an empty design and return its designId. Add screens with create_artboard.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    run: (a, real) => real.call("create_design", { name: a.name }),
  }),

  rename_design: tool({
    description: "Rename a design.",
    inputSchema: schema({ designId: DESIGN, name: { type: "string" } }, ["designId", "name"]),
    run: (a, real) => real.call("rename_design", { designId: a.designId, name: a.name }),
  }),

  get_tree_summary: tool({
    description:
      "Orient: a header line (artboards, nodes, open comments, shared CSS size, who is working), then one line per node with its id. nodeIds zooms in; depth 1 with offset pages through children.",
    inputSchema: schema({
      designId: DESIGN,
      nodeIds: { ...NODE_IDS, description: "Nodes to outline. Omit for every artboard." },
      depth: { type: "integer", description: "Levels below each node. Default 4." },
      offset: {
        type: "integer",
        description: "Skip this many outline lines (the cut-off note says what to pass).",
      },
    }),
    annotations: { readOnlyHint: true },
    async run(a, real) {
      const nodeIds = ids(a);
      const depth = num(a.depth);
      let body;
      const notes = [];
      let header = null;
      if (!nodeIds?.length) {
        const i = await info(real, a.designId);
        const n = (k, w) => `${k.toLocaleString("en-US")} ${w}${k === 1 ? "" : "s"}`;
        header =
          `${i.name}: ${n(i.artboardCount, "artboard")}, ${n(i.nodeCount, "node")}, ${n(i.openComments, "open comment")}, ` +
          `shared CSS ${i.sharedCssChars.toLocaleString("en-US")} chars.`;
        const working = (i.agentsWorking ?? []).map(
          (p) =>
            `${p.name} on ${p.nodeIds.map((x) => `#${x}`).join(", ")}${p.status ? ` (${p.status})` : ""}`,
        );
        if (working.length) header += ` Working now: ${working.join("; ")}.`;
        body = await real.call("get_tree_summary", {
          designId: a.designId,
          ...(depth !== undefined && { depth }),
        });
      } else {
        const parts = [];
        const missing = [];
        for (const id of nodeIds) {
          try {
            parts.push(
              await real.call("get_tree_summary", {
                designId: a.designId,
                nodeId: id,
                ...(depth !== undefined && { depth }),
              }),
            );
          } catch (e) {
            if (/not found/.test(e.message)) missing.push(id);
            else throw e;
          }
        }
        if (!parts.length) throw new Error(`node "${missing[0]}" not found`);
        if (missing.length)
          notes.push(`Not found: ${missing.join(", ")}. Call get_tree_summary to list ids.`);
        body = parts.join("\n");
      }
      // The real outline's own cut-off note goes in a block of its own.
      const lines = body.replace(/\n+$/, "").split("\n");
      const cut = lines.findIndex((l) => l.startsWith("… cut off"));
      if (cut >= 0) notes.push(lines.splice(cut).join(" "));
      const offset = num(a.offset) ?? 0;
      let shown = lines.slice(offset);
      let bytes = 0;
      const end = shown.findIndex((l) => (bytes += Buffer.byteLength(l) + 1) > LIMIT);
      if (end >= 0 || offset) {
        const stop = end >= 0 ? end : shown.length;
        shown = shown.slice(0, stop);
        notes.unshift(
          `Showing lines ${offset + 1}-${offset + stop} of ${lines.length}.${offset + stop < lines.length ? ` Pass offset ${offset + stop} for the rest.` : ""}`,
        );
      }
      return reply([header, shown.join("\n")].filter(Boolean).join("\n"), ...notes);
    },
  }),

  get_html: tool({
    description:
      "A node's markup with data-id on every element and styles inline. depth 0 is the node alone (tag, styles, attributes, parent, child ids). Several nodeIds give one section each.",
    inputSchema: schema({
      designId: DESIGN,
      nodeIds: NODE_IDS,
      depth: {
        type: "integer",
        description: "Levels of children to include. Default: as deep as fits. 0 = the node alone.",
      },
      includeStyles: { type: "boolean", description: "Inline styles. Default true." },
      includeStylesheets: {
        type: "boolean",
        description: "Also the <style> blocks that style it from elsewhere in the artboard.",
      },
    }),
    annotations: { readOnlyHint: true },
    async run(a, real) {
      const nodeIds = ids(a);
      if (!nodeIds?.length) throw bad("missing field `nodeIds`");
      const depth = num(a.depth);
      const sections = [];
      const notes = new Set();
      const missing = [];
      for (const id of nodeIds) {
        const args = { designId: a.designId, nodeId: id };
        if (depth !== undefined) args.depth = depth;
        for (const k of ["includeStyles", "includeStylesheets"])
          if (a[k] !== undefined) args[k] = bool(a[k]);
        let text;
        try {
          text = await real.call("get_html", args);
        } catch (e) {
          if (/not found/.test(e.message)) {
            missing.push(id);
            continue;
          }
          throw e;
        }
        const [html, ...rest] = splitNotes(text);
        let section = html;
        if (depth === 0) {
          const [n] = await nodeInfo(real, a.designId, [id]);
          if (n && !n.error) {
            const kids = n.childIds ?? [];
            section += `\n<!-- ${n.type} #${n.id}; parent ${n.parentId ? `#${n.parentId}` : "none (artboard)"}; artboard #${n.artboardId}${n.text != null ? `; text "${n.text}"` : ""}; ${n.childCount} children${kids.length ? `: ${kids.map((k) => `#${k}`).join(", ")}` : ""} -->`;
          }
          rest.splice(0, rest.length, ...rest.filter((r) => !r.startsWith("This shows 0 levels")));
        }
        sections.push(nodeIds.length > 1 ? `<!-- #${id} -->\n${section}` : section);
        rest.forEach((r) => notes.add(r));
      }
      if (!sections.length) throw new Error(`node "${missing[0]}" not found`);
      if (missing.length)
        notes.add(`Not found: ${missing.join(", ")}. Call get_tree_summary to list ids.`);
      let payload = sections.join("\n");
      if (Buffer.byteLength(payload) > LIMIT) {
        payload = payload.slice(0, LIMIT);
        notes.add("Cut off at 60,000 bytes. Ask for fewer nodeIds, or a smaller depth.");
      }
      return reply(payload, ...notes);
    },
  }),

  get_layout: tool({
    description:
      "Where elements rendered, as text: each element's box relative to its artboard, plus content cut off by the artboard's edge, text overflowing its box and overlapping text. Omit nodeIds for every artboard (first 10).",
    inputSchema: schema({
      designId: DESIGN,
      nodeIds: {
        ...NODE_IDS,
        description: "Artboards or nodes. Omit for every artboard (first 10).",
      },
      depth: { type: "integer", description: "Levels below each node. Default 4." },
    }),
    annotations: { readOnlyHint: true },
    async run(a, real) {
      const nodeIds = ids(a) ?? [];
      const depth = num(a.depth);
      const base = { designId: a.designId, ...(depth !== undefined && { depth }) };
      if (!nodeIds.length) return real.call("get_layout", base);
      const parts = [];
      for (const id of nodeIds.slice(0, 10))
        parts.push(await real.call("get_layout", { ...base, nodeId: id }));
      const note =
        nodeIds.length > 10
          ? `Showing the first 10 of ${nodeIds.length} nodes; ask for the rest in another call.`
          : null;
      return reply(parts.join("\n"), note);
    },
  }),

  get_screenshot: tool({
    description:
      "A picture of artboards or nodes. A whole artboard's shot ends with a layout check. A node's shot is cropped to it: add padding, or scale 2, for small text. nodeIds takes up to 10; omit for every artboard.",
    inputSchema: schema({
      designId: DESIGN,
      nodeIds: {
        ...NODE_IDS,
        description: "Up to 10 artboards or nodes. Omit for every artboard.",
      },
      region: {
        type: "object",
        description: "Canvas region instead of nodes: {x, y, width, height}.",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          width: { type: "number" },
          height: { type: "number" },
        },
      },
      padding: { type: "number", description: "Pixels around a node's shot. Default 0." },
      scale: { type: "number", description: "0.25 to 3. Default 1." },
      format: { type: "string", enum: ["png", "jpeg", "webp"] },
      quality: { type: "integer", description: "jpeg/webp quality. Default 80." },
      hide: { ...NODE_IDS, description: "Nodes to hide in the shot." },
      highlight: { ...NODE_IDS, description: "Nodes to outline in the shot." },
      transparent: { type: "boolean" },
      revealOverflow: { type: "boolean", description: "Show content past the artboard's edge." },
    }),
    annotations: { readOnlyHint: true },
    async run(a, real) {
      const args = { designId: a.designId };
      const nodeIds = ids(a);
      if (nodeIds?.length) args.nodeIds = nodeIds;
      const hide = list(pick(a, "hide", "hideNodeIds"));
      const highlight = list(pick(a, "highlight", "highlightNodeIds"));
      if (hide) args.hideNodeIds = hide;
      if (highlight) args.highlightNodeIds = highlight;
      for (const k of ["padding", "scale", "quality"]) if (a[k] !== undefined) args[k] = num(a[k]);
      for (const k of ["transparent", "revealOverflow"])
        if (a[k] !== undefined) args[k] = bool(a[k]);
      if (a.format) args.format = a.format;
      if (a.region) args.region = obj(a.region);
      const result = await real.callRaw("get_screenshot", args);
      if (result.isError) throw new Error(result.content.map((c) => c.text ?? "").join("\n"));
      return result;
    },
  }),

  find_nodes: tool({
    description:
      "Find elements by text, layer name, tag, CSS (style also matches <style> rules, the shared CSS, and a color in any notation) or attribute. Every filter you pass must match. within limits it to a subtree.",
    inputSchema: schema({
      designId: DESIGN,
      within: { type: "string", description: "Only search inside this node." },
      text: { type: "string" },
      name: { type: "string", description: "Layer name (data-name)." },
      tag: { type: "string" },
      style: {
        type: "string",
        description: 'A CSS property, value or declaration, like "#3b82f6" or "border-radius".',
      },
      attribute: { type: "string", description: 'An attribute name or name="value".' },
    }),
    annotations: { readOnlyHint: true },
    async run(a, real) {
      const args = { designId: a.designId };
      for (const k of ["within", "text", "name", "tag", "style", "attribute"])
        if (a[k] !== undefined && a[k] !== "") args[k] = String(a[k]);
      const text = await real.call("find_nodes", args);
      if (/^node "[^"]*" not found$/.test(text.trim())) throw new Error(text.trim());
      let shared = null;
      if (args.style && !args.within && !args.text && !args.name && !args.tag && !args.attribute) {
        const lines = searchCss(await sharedCss(real, a.designId), args.style);
        if (lines.length) shared = `Shared CSS (every artboard):\n${lines.join("\n")}`;
      }
      return reply(text, shared);
    },
  }),

  get_css: tool({
    description:
      "Read CSS. Without nodeIds: the shared CSS every artboard uses, and a line per artboard <style> block. With nodeIds (artboards or <style> nodes): those <style> blocks' CSS.",
    inputSchema: schema({
      designId: DESIGN,
      nodeIds: { ...NODE_IDS, description: "Artboards or <style> nodes. Optional." },
    }),
    annotations: { readOnlyHint: true },
    async run(a, real) {
      const nodeIds = ids(a);
      if (nodeIds?.length) {
        const found = await nodeInfo(real, a.designId, nodeIds);
        const missing = found.filter((n) => n.error).map((n) => n.id);
        if (missing.length === found.length) throw new Error(`node "${missing[0]}" not found`);
        const boards = [...new Set(found.filter((n) => !n.error).map((n) => n.artboardId ?? n.id))];
        const elements = await readDesign(real, a.designId, boards);
        const wanted = new Set(found.filter((n) => !n.error && n.tag === "style").map((n) => n.id));
        const out = [];
        for (const el of elements) {
          if (el.tag !== "style") continue;
          const id = el.attrs["data-id"];
          if (wanted.size ? wanted.has(id) : boards.includes(el.artboard))
            out.push(`/* <style> #${id} in artboard #${el.artboard} */\n${el.text.trim()}`);
        }
        return reply(
          out.join("\n\n") || "No <style> blocks there.",
          missing.length ? `Not found: ${missing.join(", ")}.` : null,
        );
      }
      const css = await sharedCss(real, a.designId);
      const elements = await readDesign(real, a.designId);
      const blocks = elements
        .filter((e) => e.tag === "style")
        .map(
          (e) =>
            `  #${e.attrs["data-id"]} in artboard #${e.artboard}: ${plural(flatRules(parseSheet(e.text)).length, "rule")}, ${e.text.length} chars`,
        );
      return reply(
        css ? `Shared CSS:\n${css}` : "This design has no shared CSS.",
        blocks.length
          ? `<style> blocks (get_css with their ids reads them):\n${blocks.join("\n")}`
          : "No artboard has a <style> block.",
      );
    },
  }),

  create_artboard: tool({
    description:
      "New screen: a fixed-size frame, with its first section in html. Without x and y it goes right of the others. Sizes: desktop 1440x900, tablet 768x1024, mobile 390x844.",
    inputSchema: schema(
      edit({
        name: { type: "string" },
        width: { type: ["number", "string"], description: "px" },
        height: { type: ["number", "string"], description: "px" },
        x: {
          type: ["number", "string"],
          description: "Canvas position. Optional; a lone x or y keeps the other free.",
        },
        y: { type: ["number", "string"] },
        class: { type: "string", description: "Class on the artboard element, for <style> rules." },
        styles: {
          type: ["object", "string"],
          description: 'Extra inline styles, like {"background": "#0b0b0b"}.',
        },
        html: { type: "string", description: "The first section." },
      }),
      ["designId", "name", "width", "height"],
    ),
    async run(a, real) {
      const args = {
        designId: a.designId,
        name: a.name,
        width: num(a.width),
        height: num(a.height),
      };
      let x = num(a.x);
      let y = num(a.y);
      if ((x === undefined) !== (y === undefined)) {
        const free = JSON.parse(
          await real.call("find_placement", {
            designId: a.designId,
            width: args.width,
            height: args.height,
          }),
        );
        x ??= free.x;
        y ??= free.y;
      }
      if (x !== undefined) Object.assign(args, { x, y });
      if (a.class) args.class = a.class;
      if (a.styles) args.styles = obj(a.styles);
      if (a.html) args.html = a.html;
      const out = await real.call("create_artboard", args);
      return after(real, a, out, [idAfter(out, "artboard")]);
    },
  }),

  add_html: tool({
    description:
      "Add HTML into a container (an artboard or any element), last by default or at index. Build a screen one section per call. Returns outlines of what it added.",
    inputSchema: schema(
      edit({
        parentId: { type: "string", description: "The container to add into." },
        html: { type: "string" },
        index: {
          type: ["integer", "string"],
          description: "Position among the children; default last. 0 = first.",
        },
      }),
      ["designId", "html"],
    ),
    async run(a, real) {
      const parent = pick(a, "parentId", "targetId", "nodeId", "id");
      if (!parent) throw bad("missing field `parentId`");
      const args = { designId: a.designId, targetId: String(parent), html: a.html, mode: "append" };
      if (a.index !== undefined) args.index = num(a.index);
      const out = await real.call("write_html", args);
      return after(
        real,
        a,
        out.replace(/^Wrote (\d+) root node\(s\):/, `Added $1 root node(s) to #${parent}:`),
        [String(parent)],
      );
    },
  }),

  replace_html: tool({
    description:
      "Rewrite a node with new HTML, or only what's inside it with contents: true (implied on an artboard). The replaced nodes get new ids.",
    inputSchema: schema(
      edit({
        nodeId: { type: "string" },
        html: { type: "string" },
        contents: {
          type: ["boolean", "string"],
          description: "true: keep the node, replace its children.",
        },
      }),
      ["designId", "html"],
    ),
    async run(a, real) {
      let id = pick(a, "nodeId", "targetId", "id", "nodeIds");
      if (Array.isArray(id) || (typeof id === "string" && id.startsWith("["))) id = list(id)[0];
      if (!id) throw bad("missing field `nodeId`");
      const boards = await artboardsOf(real, a.designId, [id]);
      const base = { designId: a.designId, targetId: id, html: a.html };
      let inside = bool(a.contents);
      let out;
      try {
        out = await real.call("write_html", {
          ...base,
          mode: inside ? "replace-children" : "replace",
        });
      } catch (e) {
        if (!/can't replace an artboard/.test(e.message)) throw e;
        inside = true;
        out = await real.call("write_html", { ...base, mode: "replace-children" });
      }
      out = out.replace(
        /^Wrote (\d+) root node\(s\):/,
        inside
          ? `Replaced the contents of #${id} with $1 root node(s):`
          : `Replaced #${id} with $1 root node(s):`,
      );
      return after(real, a, out, boards);
    },
  }),

  write_css: tool({
    description:
      'Every CSS write. css is a stylesheet. to "inline" (default) sets each rule\'s declarations on the elements it matches; "style" merges rules into the artboard\'s <style> block; "shared" into the CSS every artboard uses. prop: unset removes one.',
    inputSchema: schema(
      edit({
        css: {
          type: ["string", "object"],
          description:
            'A stylesheet, like "#k3x9a2bq { height: 1712px }" or ".btn { border-radius: 999px }". An empty rule ".x {}" removes that rule from a sheet. Also accepted: a {"prop": "value"} map with nodeIds.',
        },
        to: { type: "string", enum: ["inline", "style", "shared"], description: "Default inline." },
        nodeIds: {
          ...NODE_IDS,
          description:
            'to "style": which artboards\' <style> blocks (default: every artboard a rule matches in). With a css map: the nodes.',
        },
        replace: {
          type: ["boolean", "string"],
          description: "style/shared only: replace the whole sheet instead of merging.",
        },
      }),
    ),
    async run(a, real) {
      const designId = a.designId;
      let css = obj(pick(a, "css", "rules", "stylesheet", "styles"));
      let nodeIds = ids(a);
      // The old update_styles shapes: {nodeIds, styles: {...}} or updates: [{nodeIds, styles}].
      let updates = null;
      if (css && typeof css === "object" && !Array.isArray(css)) {
        if (!nodeIds?.length)
          throw bad(
            'a {"prop": "value"} map needs nodeIds; or write it as CSS, like "#id { prop: value }"',
          );
        updates = [{ nodeIds, styles: css }];
      } else if (css === undefined && a.updates !== undefined) {
        const u = obj(a.updates);
        updates = (Array.isArray(u) ? u : [u]).map((x) => {
          const o = obj(x);
          return { nodeIds: ids(o), styles: obj(o.styles) };
        });
      }
      if (updates) {
        for (const u of updates)
          for (const [k, v] of Object.entries(u.styles ?? {}))
            if (typeof v === "string" && /^unset$/i.test(v)) u.styles[k] = null;
        const out = await real.call("update_styles", { designId, updates });
        return after(
          real,
          a,
          out,
          updates.flatMap((u) => u.nodeIds ?? []),
        );
      }
      if (typeof css !== "string" || !css.trim()) throw bad("missing field `css`");
      if (/<\/?style/i.test(css)) throw new Error("Pass the CSS alone, without <style> tags.");
      const to = String(pick(a, "to", "target", "into") ?? "inline").toLowerCase();
      if (!["inline", "style", "shared"].includes(to))
        throw bad(`invalid value for \`to\`: expected one of inline, style, shared`);
      const items = parseSheet(css);
      if (!items.length)
        throw new Error(`No CSS rules in css. Pass rules like "#id { prop: value }".`);
      const replace = bool(a.replace);

      if (to === "inline") {
        const elements = await readDesign(real, designId);
        const byRule = [];
        const notes = [];
        for (const it of items) {
          if (it.selector === undefined)
            throw new Error(
              `inline styles can't hold ${it.prelude.split(/\s/)[0]}; use to: "style" or "shared"`,
            );
          if (hasPseudo(it.selector)) {
            const p = it.selector.replace(/\[[^\]]*\]/g, "").match(/::?[\w-]+/)[0];
            throw new Error(`inline styles can't hold ${p}; use to: "style" or "shared"`);
          }
          const matched = select(elements, it.selector);
          if (!matched.length)
            throw new Error(
              `No element matches "${it.selector.trim()}", so nothing was changed. find_nodes or get_tree_summary shows ids, names and classes.`,
            );
          const styles = {};
          for (const [p, v] of it.decls) styles[p] = /^unset$/i.test(v) ? null : v;
          if (!Object.keys(styles).length) continue;
          byRule.push({ nodeIds: matched.map((e) => e.attrs["data-id"]), styles });
          if (!/^\s*#[\w-]+\s*(,\s*#[\w-]+\s*)*$/.test(it.selector))
            notes.push(
              `"${it.selector.trim()}" matched ${matched.length} element${matched.length === 1 ? "" : "s"}; inline styles won't reach elements added later. For a rule that sticks, use to: "style" or "shared".`,
            );
        }
        if (!byRule.length) throw new Error("The css has no declarations to set.");
        const out = await real.call("update_styles", { designId, updates: byRule });
        const result = await after(
          real,
          a,
          out,
          byRule.flatMap((u) => u.nodeIds),
        );
        result.content.splice(1, 0, ...notes.map((t) => ({ type: "text", text: t })));
        return result;
      }

      if (to === "shared") {
        const before = await sharedCss(real, designId);
        const merged = replace
          ? {
              text: css.trim(),
              changed: before.trim() === css.trim() ? 0 : 1,
              rules: parseSheet(css).length,
            }
          : mergeSheet(before, items);
        if (!merged.changed) return reply("Nothing changed: the shared CSS already said that.");
        if (merged.text.length > 100_000)
          throw new Error("The shared CSS would be over 100,000 characters.");
        await real.call("set_shared_css", { designId, css: merged.text });
        const elements = await readDesign(real, designId).catch(() => []);
        const out = replace
          ? `Replaced the shared CSS (${merged.rules} rule${merged.rules === 1 ? "" : "s"}). Every artboard in the design uses it.`
          : `Merged ${items.length} rule${items.length === 1 ? "" : "s"} into the shared CSS (${merged.rules} in all). Every artboard in the design uses it.`;
        const result = await after(
          real,
          a,
          out,
          bool(a.check) ? [...new Set(elements.map((e) => e.artboard))] : [],
        );
        const note = cascadeNote(elements, items);
        if (note) result.content.splice(1, 0, { type: "text", text: note });
        return result;
      }

      // to: "style"
      let boards;
      const elementsAll = await readDesign(real, designId);
      if (nodeIds?.length) {
        const found = await nodeInfo(real, designId, nodeIds);
        const missing = found.find((n) => n.error);
        if (missing) throw new Error(`node "${missing.id}" not found`);
        boards = [...new Set(found.map((n) => n.artboardId ?? n.id))];
      } else {
        const set = new Set();
        for (const rule of flatRules(items)) {
          let matched = null;
          try {
            const plain = rule.selector.replace(/::?[\w-]+(\([^)]*\))?/g, "");
            matched = select(elementsAll, plain.trim() || "*");
          } catch {}
          for (const el of matched ?? []) set.add(el.artboard);
        }
        boards = [...set];
        if (!boards.length) {
          const all = [...new Set(elementsAll.map((e) => e.artboard))];
          if (all.length === 1) boards = all;
          else
            throw new Error(
              "No element matches these rules in any artboard. Pass nodeIds with the artboard whose <style> block should get them.",
            );
        }
      }
      const keys = new Set(items.map((it) => keyOf(it.selector ?? it.prelude)));
      const textUpdates = [];
      const created = [];
      let mergedRules = 0;
      for (const board of boards) {
        const styles = elementsAll.filter((e) => e.artboard === board && e.tag === "style");
        const target =
          styles.find((s) =>
            parseSheet(s.text).some((it) => keys.has(keyOf(it.selector ?? it.prelude ?? ""))),
          ) ?? styles[0];
        if (!target) {
          const sheet = replace ? css.trim() : mergeSheet("", items).text;
          if (!sheet) continue;
          const out = await real.call("write_html", {
            designId,
            targetId: board,
            html: `<style>${sheet}</style>`,
            mode: "append",
            index: 0,
          });
          created.push(
            `Added a <style> block to artboard #${board}: ${idsIn(out)[0] ? `#${idsIn(out)[0]}` : ""}`.trim(),
          );
          continue;
        }
        const merged = replace
          ? { text: css.trim(), changed: target.text.trim() === css.trim() ? 0 : 1 }
          : mergeSheet(target.text, items);
        if (!merged.changed) continue;
        mergedRules += merged.changed;
        textUpdates.push({ nodeId: target.attrs["data-id"], text: merged.text });
      }
      if (!textUpdates.length && !created.length)
        return reply("Nothing changed: the <style> blocks already said that.");
      const lines = [...created];
      if (textUpdates.length) {
        await real.call("set_text_content", { designId, updates: textUpdates });
        lines.push(
          `${replace ? "Replaced" : `Merged ${items.length} rule${items.length === 1 ? "" : "s"} into`} the <style> block${textUpdates.length === 1 ? "" : "s"} ` +
            textUpdates
              .map(
                (u) =>
                  `#${u.nodeId} (artboard #${elementsAll.find((e) => e.attrs["data-id"] === u.nodeId).artboard})`,
              )
              .join(", ") +
            ".",
        );
      }
      const result = await after(real, a, lines.join("\n"), boards);
      const note = cascadeNote(
        elementsAll.filter((e) => boards.includes(e.artboard)),
        items,
      );
      if (note) result.content.splice(1, 0, { type: "text", text: note });
      return result;
    },
  }),

  set_attributes: tool({
    description:
      "Set or remove attributes (null removes): class, href, src, alt, data-name for the layer name. One change flat ({nodeIds, attributes}) or several in updates. Not style: use write_css.",
    inputSchema: schema(
      edit({
        nodeIds: NODE_IDS,
        attributes: {
          type: ["object", "string"],
          description: '{"class": "btn", "href": null, "data-name": "Header"}',
        },
        updates: {
          type: ["array", "string"],
          description: "Several changes: [{nodeIds, attributes}].",
        },
      }),
    ),
    async run(a, real) {
      const items = batch(
        a,
        ["nodeIds", "nodeId", "id", "attributes"],
        '{"nodeIds": ["<id>"], "attributes": {"class": "btn"}}',
      );
      const attrs = [];
      const renames = [];
      for (const it of items) {
        const nodeIds = ids(it);
        const map = obj(it.attributes);
        if (!nodeIds?.length || !map || typeof map !== "object")
          throw bad(
            'each change needs nodeIds and attributes, like {"nodeIds": ["<id>"], "attributes": {"class": "btn"}}',
          );
        const rest = {};
        for (const [k, v] of Object.entries(map)) {
          if (k.toLowerCase() === "data-name")
            for (const id of nodeIds) renames.push({ nodeId: id, name: v });
          else rest[k] = v;
        }
        if (Object.keys(rest).length) attrs.push({ nodeIds, attributes: rest });
      }
      const outs = [];
      if (attrs.length)
        outs.push(await real.call("set_attributes", { designId: a.designId, updates: attrs }));
      if (renames.length)
        outs.push(await real.call("rename_nodes", { designId: a.designId, updates: renames }));
      return after(real, a, outs.join("\n"), [
        ...attrs.flatMap((x) => x.nodeIds),
        ...renames.map((r) => r.nodeId),
      ]);
    },
  }),

  set_text_content: tool({
    description:
      "Replace a node's text, or a <script>'s code. One change flat ({nodeId, text}) or several in updates. For a <style> block use write_css.",
    inputSchema: schema(
      edit({
        nodeId: { type: "string" },
        text: { type: "string" },
        updates: { type: ["array", "string"], description: "Several changes: [{nodeId, text}]." },
      }),
    ),
    async run(a, real) {
      const items = batch(
        a,
        ["nodeId", "id", "nodeIds", "text"],
        '{"nodeId": "<id>", "text": "New text"}',
      ).map((it) => {
        const id = ids(it)?.[0];
        if (!id || typeof it.text !== "string")
          throw bad(
            'each change needs nodeId and text, like {"nodeId": "<id>", "text": "New text"}',
          );
        return { nodeId: id, text: it.text };
      });
      const found = await nodeInfo(
        real,
        a.designId,
        items.map((i) => i.nodeId),
      );
      const missing = found.find((n) => n.error);
      if (missing) throw new Error(`node "${missing.id}" not found`);
      if (found.some((n) => n.tag === "style"))
        throw new Error(
          'To change a <style> block use write_css with to: "style" (replace: true for the whole sheet).',
        );
      const out = await real.call("set_text_content", { designId: a.designId, updates: items });
      return after(
        real,
        a,
        out,
        items.map((i) => i.nodeId),
      );
    },
  }),

  move_nodes: tool({
    description:
      "Move nodes into parentId at index (null parentId makes them artboards), reorder in place with index alone, or place artboards on the canvas with x and y. Several different moves go in updates.",
    inputSchema: schema(
      edit({
        nodeIds: NODE_IDS,
        parentId: {
          type: ["string", "null"],
          description: "Destination container. null = make them artboards.",
        },
        index: {
          type: ["integer", "string"],
          description: "Position among the new siblings; default last.",
        },
        x: { type: ["number", "string"], description: "Artboards only: canvas position." },
        y: { type: ["number", "string"] },
        updates: {
          type: ["array", "string"],
          description: "Several moves: [{nodeIds, parentId?, index?, x?, y?}].",
        },
      }),
    ),
    async run(a, real) {
      const items = batch(
        a,
        ["nodeIds", "nodeId", "id", "parentId", "index", "x", "y"],
        '{"nodeIds": ["<id>"], "parentId": "<id>"}',
      );
      const positions = [];
      const outs = [];
      const touched = [];
      for (const it of items) {
        const nodeIds = ids(it);
        if (!nodeIds?.length) throw bad("missing field `nodeIds`");
        const place = it.x !== undefined || it.y !== undefined;
        const reparent = it.parentId !== undefined || it.index !== undefined;
        if (place && reparent)
          throw new Error(
            "Pass parentId/index to reparent, or x/y to place an artboard, not both.",
          );
        if (!place && !reparent)
          throw bad("pass parentId and index to move nodes, or x and y to place artboards");
        touched.push(...nodeIds);
        if (place) {
          let x = num(it.x);
          let y = num(it.y);
          if (x === undefined || y === undefined) {
            const found = await nodeInfo(real, a.designId, nodeIds);
            for (const n of found) {
              if (n.error) throw new Error(`node "${n.id}" not found`);
              positions.push({ nodeId: n.id, x: x ?? n.x, y: y ?? n.y });
            }
          } else for (const id of nodeIds) positions.push({ nodeId: id, x, y });
        } else {
          let parentId = it.parentId;
          if (parentId === undefined) {
            const [n] = await nodeInfo(real, a.designId, [nodeIds[0]]);
            if (n.error) throw new Error(`node "${n.id}" not found`);
            parentId = n.parentId;
          }
          if (parentId) touched.push(parentId);
          const args = { designId: a.designId, nodeIds, parentId };
          if (it.index !== undefined) args.index = num(it.index);
          outs.push(await real.call("move_nodes", args));
        }
      }
      if (positions.length)
        outs.push(
          await real.call("set_artboard_position", { designId: a.designId, updates: positions }),
        );
      return after(real, a, outs.join("\n"), touched);
    },
  }),

  duplicate_nodes: tool({
    description:
      "Copy nodes, right after each original (copied artboards go in free space, for example to start a mobile variant). Returns the copies' outlines with their new ids.",
    inputSchema: schema(edit({ nodeIds: NODE_IDS })),
    async run(a, real) {
      const nodeIds = ids(a);
      if (!nodeIds?.length) throw bad("missing field `nodeIds`");
      const out = await real.call("duplicate_nodes", { designId: a.designId, nodeIds });
      return after(real, a, out, idsIn(out));
    },
  }),

  delete_nodes: tool({
    description: "Delete nodes and everything inside them. The result names each deleted node.",
    inputSchema: schema(edit({ nodeIds: NODE_IDS })),
    annotations: { destructiveHint: true },
    async run(a, real) {
      const nodeIds = ids(a);
      if (!nodeIds?.length) throw bad("missing field `nodeIds`");
      const boards = await artboardsOf(real, a.designId, nodeIds);
      const named = [];
      for (const id of nodeIds.slice(0, 12)) {
        const line = await real
          .call("get_tree_summary", { designId: a.designId, nodeId: id, depth: 0 })
          .catch(() => null);
        if (line) named.push(line.split("\n")[0]);
      }
      const out = await real.call("delete_nodes", { designId: a.designId, nodeIds });
      const remaining = (await info(real, a.designId)).artboards.map((b) => b.id);
      const more = nodeIds.length > 12 ? `\n… and ${nodeIds.length - 12} more` : "";
      return after(
        real,
        a,
        `${out.replace(/\.$/, ":")}\n${named.join("\n")}${more}`,
        boards.filter((b) => remaining.includes(b)),
      );
    },
  }),

  replace_values: tool({
    description:
      "Change a value everywhere in one call: inline styles, attributes, <style> blocks and the shared CSS (text too with includeText). Colors match in any notation and keep each use's alpha. Preview with find_nodes.",
    inputSchema: schema(
      edit({
        find: { type: "string" },
        replace: { type: "string" },
        within: {
          type: "string",
          description: "Only inside this node (then the shared CSS is left alone).",
        },
        includeText: {
          type: ["boolean", "string"],
          description: "Also replace in text. Default false.",
        },
      }),
      ["designId", "find", "replace"],
    ),
    async run(a, real) {
      if (!a.find) throw new Error("find can't be empty. Pass the value to replace.");
      const args = { designId: a.designId, find: a.find, replace: a.replace };
      if (a.within) args.within = a.within;
      if (a.includeText !== undefined) args.includeText = bool(a.includeText);
      let out = await real.call("replace_values", args);
      const touched = idsIn(out);
      if (!a.within) {
        const css = await sharedCss(real, a.designId);
        const { text, changes } = css ? replaceInCss(css, a.find, a.replace) : { changes: [] };
        if (changes.length) {
          await real.call("set_shared_css", { designId: a.designId, css: text });
          const block = `shared CSS: ${changes.length} use${changes.length === 1 ? "" : "s"}\n${changes.map(([o, n]) => `  ${o} → ${n}`).join("\n")}`;
          out = out.startsWith("Found no ") ? block : `${out}\n${block}`;
        }
      }
      return after(real, a, out, touched);
    },
  }),

  undo: tool({
    description:
      "Undo your own last calls (one call per step), skipping steps whose nodes someone else deleted. The result names the next step.",
    inputSchema: schema({
      designId: DESIGN,
      steps: { type: ["integer", "string"], description: "Default 1." },
    }),
    run: (a, real) => step(a, real, "undo"),
  }),

  redo: tool({
    description: "Redo calls you undid, one call per step.",
    inputSchema: schema({
      designId: DESIGN,
      steps: { type: ["integer", "string"], description: "Default 1." },
    }),
    run: (a, real) => step(a, real, "redo"),
  }),

  get_comments: tool({
    description:
      "Open comments (user requests pinned to an artboard and usually an element), oldest first, with the element's HTML. includeResolved for all of them.",
    inputSchema: schema({
      designId: DESIGN,
      includeResolved: { type: "boolean" },
      offset: { type: "integer", description: "Skip this many (the note says what to pass)." },
    }),
    annotations: { readOnlyHint: true },
    run: (a, real) => real.call("get_comments", a),
  }),

  wait_for_comments: tool({
    description:
      "Block until a comment needs you (new, or a user replied), then return those comments. Loop on it to keep taking feedback.",
    inputSchema: schema({
      designId: DESIGN,
      timeoutSeconds: { type: "integer", description: "1 to 300. Default 60." },
    }),
    annotations: { readOnlyHint: true },
    run: (a, real) => real.call("wait_for_comments", a),
  }),

  reply_to_comment: tool({
    description:
      "Reply to a comment; resolve: true resolves it, false reopens it. Your reply links your edits to its artboard since the thread's last message. Several replies go in updates.",
    inputSchema: schema({
      designId: DESIGN,
      commentId: { type: "string" },
      message: { type: "string" },
      resolve: {
        type: ["boolean", "string"],
        description: "true resolves, false reopens, omit leaves it as is.",
      },
      updates: {
        type: ["array", "string"],
        description: "Several replies: [{commentId, message, resolve?}].",
      },
    }),
    async run(a, real) {
      const items = batch(
        a,
        ["commentId", "message", "resolve"],
        '{"commentId": "<id>", "message": "Done: …", "resolve": true}',
      );
      const outs = [];
      let failed = 0;
      for (const it of items) {
        const commentId = pick(it, "commentId", "id", "comment");
        if (!commentId || typeof it.message !== "string")
          throw bad("each reply needs commentId and message");
        const args = { designId: a.designId, commentId, message: it.message };
        if (it.resolve !== undefined && it.resolve !== null) args.resolve = bool(it.resolve);
        try {
          const out = await real.call("reply_to_comment", args);
          outs.push(items.length > 1 ? `${commentId}: ${out}` : out);
        } catch (e) {
          failed++;
          if (items.length === 1) throw e;
          outs.push(`${commentId}: ${e.message}`);
        }
      }
      if (failed === items.length) throw new Error(outs.join("\n"));
      return outs.join("\n");
    },
  }),
};

async function step(a, real, which) {
  const args = { designId: a.designId };
  if (a.steps !== undefined) args.steps = num(a.steps);
  const out = (await real.call(which, args)).replace(/\.$/, "");
  if (out.startsWith("Nothing to")) return out + ".";
  const history = JSON.parse(await real.call("get_history", { designId: a.designId }));
  const next = history[which][0];
  return `${out}. ${next ? `Next ${which}: ${next}.` : `Nothing left to ${which}.`}`;
}

const instructions = `Finite is a design canvas for agents. A design (a canvas) holds artboards: fixed-size frames on an infinite canvas, containing ordinary HTML and CSS. People watch live and can't edit, so all changes come from agents. They steer you by pinning comments.

Every tool except list_designs and create_design takes designId. Node ids are always nodeIds (one id or a list). Other agents may edit the same design, so re-read before touching nodes you didn't create.

Workflow:

1. Pick a design with list_designs (query finds one by name), or create_design.
2. Orient with get_tree_summary: counts, open comments, who is working, then one line per node with its id. Pass nodeIds to zoom in; get_html gives a node's markup.
3. New screen: create_artboard with its first section in html (desktop 1440x900, tablet 768x1024, mobile 390x844). Without x and y it goes right of the others.
4. Add the rest one section at a time with add_html (parentId, html). replace_html rewrites a node, or only its contents with contents: true.
5. Pass check: true to any edit to get a layout check in its result: content cut off by the artboard's edge, text overflowing its box or overlapping other text.
6. Look with get_screenshot (a node's shot is cropped to it; add padding, or scale 2, for small text; nodeIds takes up to 10). get_layout lists rendered boxes as text, to place pins over content.
7. Style with write_css: css is a stylesheet. to "inline" (default) sets each rule's declarations on the elements it matches, like "#k3x9a2bq { height: 1712px }"; "style" merges rules into the artboard's <style> block; "shared" into the CSS every artboard uses. prop: unset removes a declaration.
8. Other edits: set_attributes (class, href, data-name for the layer name), set_text_content, move_nodes (parentId and index; x and y for artboards), duplicate_nodes, delete_nodes. Each edit lists the nodes it changed.
9. To change a value everywhere (a brand color, a font), use replace_values: it covers inline styles, <style> blocks and shared CSS, and colors match in any notation. find_nodes finds elements by text, name, tag, CSS or attribute. Use them instead of reading whole artboards.

Shared styles: put CSS variables (--brand) and classes used on several screens (.btn, .top-bar) in the shared CSS once, with write_css to "shared", not in each artboard. get_css reads it.

HTML: inline styles, or <style> blocks with classes. Prefer flexbox and gap. Name layers with data-name="Header". box-sizing is border-box. Images use <img src="https://...">; inline <svg> works. Artboards default to a white flex column with overflow hidden, so children shrink unless they have flex-shrink: 0. Resize an artboard with write_css on its width or height.

Motion: a <style> or <script> only affects its own artboard, so select by class or id, not html or body. Use @keyframes, transitions and :hover. For pointer effects, use a <script> with addEventListener (on* attributes are dropped). Scripts run sandboxed: inline only, no network. get_screenshot captures about 3 seconds after load.

Comments are user requests pinned to an artboard, usually to an element. Call get_comments, make the change, check it, then reply_to_comment with what you changed and resolve: true. Your reply links your edits to that artboard since the thread's last message. If a comment is unclear, ask in a reply and leave it open. Loop on wait_for_comments to keep taking feedback.

Add status ("Restyling pricing") to any edit to show people what you're doing.

Long results end with a note saying how to get the rest. Errors say what to do instead. undo and redo reverse only your own calls, one call per step.`;

export default { instructions, drop: "all", tools };
