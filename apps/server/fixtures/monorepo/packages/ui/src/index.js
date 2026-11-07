import { createElement } from "react";

export function Badge({ children }) {
  return createElement(
    "span",
    { style: { padding: "2px 8px", borderRadius: 999, background: "#95ced7" } },
    children,
  );
}
