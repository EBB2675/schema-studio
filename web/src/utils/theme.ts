export type Theme = "dark" | "light";

export const initialTheme = (stored: string | null | undefined, lightMode: boolean): Theme => {
  if (stored === "dark" || stored === "light") return stored;
  return lightMode ? "light" : "dark";
};
