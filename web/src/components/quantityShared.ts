export type QuantityFormData = {
  quantityName: string;
  dtype: string;
  docstring: string;
};

export const SUPPORTED_DTYPES = ["bool", "datetime", "float", "int", "str"] as const;
