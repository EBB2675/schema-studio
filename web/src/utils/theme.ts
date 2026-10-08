export type Theme = "dark" | "light";

export const initialTheme = (stored: string | null | undefined, staticMode: boolean): Theme => {
  if (stored === "dark" || stored === "light") return stored;
  return staticMode ? "light" : "dark";
};
