/**
 * Whether an attribute is safe to set: no event handlers, no `srcdoc`, and
 * no script URL anywhere in the value (SVG animation can set an `href` from
 * a list like `values="0;javascript:…"`). The same rules as the Rust
 * `html::is_safe_attr`, checked against `crates/design/fixtures/attributes.json`.
 */
export const isSafeAttr = (name: string, value: string) => {
  const lower = name.toLowerCase();
  // Browsers ignore whitespace and control characters inside a URL scheme.
  // eslint-disable-next-line no-control-regex
  const url = value.replace(/[\s\u0000-\u001f\u007f-\u009f]/g, "").toLowerCase();
  return (
    !lower.startsWith("on") &&
    lower !== "srcdoc" &&
    !url.includes("javascript:") &&
    !url.includes("vbscript:")
  );
};
