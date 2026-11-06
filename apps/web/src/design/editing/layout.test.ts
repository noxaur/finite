import { describe, expect, it } from "vite-plus/test";
import { layoutOf, layoutStyles } from "./layout";

describe("layout", () => {
  it("round-trips the layout kind", () => {
    for (const kind of ["block", "column", "row", "grid"] as const) {
      const styles = layoutStyles(kind);
      expect(layoutOf(styles.display ?? "block", styles["flex-direction"] ?? "row")).toBe(kind);
    }
  });

  it("reads inline variants and non-layout displays", () => {
    expect(layoutOf("inline-flex", "column-reverse")).toBe("column");
    expect(layoutOf("inline-grid", "row")).toBe("grid");
    expect(layoutOf("none", "row")).toBe("block");
  });
});
