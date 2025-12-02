export type QuantityFormData = {
  quantityName: string;
  dtype: string;
  docstring: string;
};

// Keep this list in sync with `api/main.py`.
export const SUPPORTED_DTYPES = [
  // Booleans / strings / datetime
  "bool",
  "str",
  "datetime",
  // Generic numbers
  "int",
  "float",
  // NumPy-style integers
  "int32",
  "int64",
  "np.int32",
  "np.int64",
  // NumPy-style floats
  "float32",
  "float64",
  "np.float32",
  "np.float64",
] as const;
