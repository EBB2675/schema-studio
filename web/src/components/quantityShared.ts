export type QuantityFormData = {
  quantityName: string;
  dtype: string;
  docstring: string;
  // bam-masterdata properties and vocabulary terms: the openBIS code, label,
  // target class (OBJECT, CONTROLLEDVOCABULARY) and whether it is mandatory.
  code?: string;
  label?: string;
  range?: string;
  mandatory?: boolean;
};

export type EditDtype = {
  name: string;
  // How the graph shows a quantity of this type.
  display: string;
  // The type needs a target class (bam-masterdata OBJECT and CONTROLLEDVOCABULARY).
  needs_range?: boolean;
};

// What a schema profile lets the user edit (`edit_rules` of /schema/profiles).
export type EditRules = {
  name: string;
  dtypes: EditDtype[];
  // New classes, properties and terms are named by an openBIS code (bam-masterdata).
  codes: boolean;
  term_code_limit?: number;
};

// NOMAD's editable types, shown as NOMAD shows them. Profiles send their own
// rules; these are used until they arrive (and in Dev Mode, which lists none).
export const NOMAD_EDIT_RULES: EditRules = {
  name: "nomad",
  codes: false,
  dtypes: [
    { name: "bool", display: "m_bool(bool)" },
    { name: "str", display: "m_str(str)" },
    { name: "datetime", display: "Datetime" },
    { name: "int", display: "m_int32(int)" },
    { name: "float", display: "m_float64(float)" },
    { name: "int32", display: "m_int32(int32)" },
    { name: "int64", display: "m_int64(int64)" },
    { name: "float32", display: "m_float32(float32)" },
    { name: "float64", display: "m_float64(float64)" },
  ],
};

export const SUPPORTED_DTYPES = NOMAD_EDIT_RULES.dtypes.map((dtype) => dtype.name);

export const VOCAB_TERM = "VOCAB_TERM";

// The editable type a quantity has, from what the graph shows ("" if it is not one of them).
export const dtypeNameFor = (rules: EditRules, shown?: string | null): string => {
  if (!shown) return "";
  const bare = shown.replace(/\[.*\]$/, "");
  const match = rules.dtypes.find((dtype) => dtype.display === shown || dtype.name === shown || dtype.name === bare);
  return match?.name ?? "";
};

export const parseEditRules = (value: unknown): EditRules | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !Array.isArray(raw.dtypes)) return undefined;
  const dtypes = raw.dtypes
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.name === "string")
    .map((item) => ({
      name: String(item.name),
      display: typeof item.display === "string" ? item.display : String(item.name),
      needs_range: item.needs_range === true,
    }));
  return {
    name: raw.name,
    dtypes,
    codes: raw.codes === true,
    term_code_limit: typeof raw.term_code_limit === "number" ? raw.term_code_limit : undefined,
  };
};

// The attribute name NOMAD convention gives a subsection holding a class: MyThing -> my_thing.
export const subsectionName = (className: string): string =>
  className
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
