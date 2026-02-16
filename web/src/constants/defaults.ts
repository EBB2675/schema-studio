export const DEFAULT_API = import.meta.env.VITE_API_BASE ?? "http://localhost:5179";
export const DEFAULT_PACKAGE = import.meta.env.VITE_DEFAULT_PACKAGE ?? "nomad_simulations.schema_packages.model_method";
export const DEFAULT_NAMESPACE =
  import.meta.env.VITE_DEFAULT_NAMESPACE ??
  "nomad_simulations.schema_packages";
export const DEFAULT_ROOT = import.meta.env.VITE_DEFAULT_ROOT ?? "ModelMethod";
export const LIGHT_MODE = (import.meta.env.VITE_LIGHT_MODE ?? "false").toLowerCase() === "true";
export const DEFAULT_BRANCH = LIGHT_MODE ? "develop" : (import.meta.env.VITE_DEFAULT_BRANCH ?? "develop");

export const WORKSPACE_PRESETS = [
  {
    label: "nomad-simulations",
    namespace: "nomad_simulations.schema_packages",
    branch: "develop",
    pkg: "nomad_simulations.schema_packages.model_method",
    root: "ModelMethod",
  },
];
