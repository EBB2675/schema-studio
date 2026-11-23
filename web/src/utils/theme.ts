export type Theme = "dark" | "light";

export const initialTheme = (stored: string | null | undefined): Theme => {
  if (stored === "dark" || stored === "light") return stored;
  return "light";
};
