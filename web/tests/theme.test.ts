import { describe, expect, it } from "vitest";
import { initialTheme } from "../src/utils/theme";

describe("initialTheme", () => {
  it("keeps a stored dark theme when light mode is on", () => {
    expect(initialTheme("dark", true)).toBe("dark");
  });

  it("keeps a stored light theme in both modes", () => {
    expect(initialTheme("light", true)).toBe("light");
    expect(initialTheme("light", false)).toBe("light");
  });

  it("falls back to the mode default when nothing valid is stored", () => {
    for (const stored of [null, undefined, "", "blue"]) {
      expect(initialTheme(stored, true)).toBe("light");
      expect(initialTheme(stored, false)).toBe("dark");
    }
  });
});
