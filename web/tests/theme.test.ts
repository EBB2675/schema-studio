import { describe, expect, it } from "vitest";
import { initialTheme } from "../src/utils/theme";

describe("initialTheme", () => {
  it("keeps a stored dark theme ", () => {
    expect(initialTheme("dark")).toBe("dark");
  });

  it("keeps a stored light theme ", () => {
    expect(initialTheme("light")).toBe("light");
    expect(initialTheme("light")).toBe("light");
  });

  it("falls back to the default theme when nothing valid is stored", () => {
    for (const stored of [null, undefined, "", "blue"]) {
      expect(initialTheme(stored)).toBe("light");
      expect(initialTheme(stored)).toBe("light");
    }
  });
});
