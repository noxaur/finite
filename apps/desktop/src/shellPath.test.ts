import { describe, expect, it } from "vite-plus/test";
import { loginShellPath, mergePath, parseShellPath } from "./shellPath.js";

describe("parseShellPath", () => {
  it("finds the PATH between the markers, whatever the shell printed around it", () => {
    expect(
      parseShellPath(
        "Last login: today\n__FINITE_PATH__/opt/homebrew/bin:/usr/bin__FINITE_PATH__\n",
      ),
    ).toBe("/opt/homebrew/bin:/usr/bin");
    expect(parseShellPath("no markers")).toBeUndefined();
    expect(parseShellPath("__FINITE_PATH____FINITE_PATH__")).toBeUndefined();
  });
});

describe("mergePath", () => {
  it("puts the login shell's entries first and keeps the rest once", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:")).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });
});

describe("loginShellPath", () => {
  it.skipIf(process.platform === "win32")("asks the login shell", async () => {
    const path = await loginShellPath("/only/this");
    expect(path.split(":")).toContain("/only/this");
    expect(path.split(":")).toContain("/usr/bin");
  });
});
