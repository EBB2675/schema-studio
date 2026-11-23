export const DEFAULT_API = "/";
export const DEFAULT_PACKAGE = import.meta.env.VITE_DEFAULT_PACKAGE ?? "nomad_simulations.schema_packages.model_method";
export const DEFAULT_NAMESPACE =
  import.meta.env.VITE_DEFAULT_NAMESPACE ??
  "nomad_simulations.schema_packages";
export const DEFAULT_OVERVIEW_NAMESPACE =
  import.meta.env.VITE_DEFAULT_OVERVIEW_NAMESPACE ??
  "nomad_simulations.schema_packages,nomad_measurements,bam_masterdata.datamodel.v0,bam_masterdata.datamodel.v1";
export const DEFAULT_ROOT = import.meta.env.VITE_DEFAULT_ROOT ?? "ModelMethod";
export const DEFAULT_BRANCH = import.meta.env.VITE_DEFAULT_BRANCH ?? "develop";

export const WORKSPACE_PRESETS = [
  {
    key: "nomad-simulations",
    label: "nomad-simulations",
    namespace: "nomad_simulations.schema_packages",
    branch: "develop",
    pkg: "nomad_simulations.schema_packages.model_method",
    root: "ModelMethod",
  },
  {
    key: "nomad-measurements",
    label: "nomad-measurements",
    namespace: "nomad_measurements",
    branch: "main",
    pkg: "nomad_measurements.xrd.schema",
    root: "ELNXRayDiffraction",
  },
  // bam-masterdata's two datamodels are separate schemas from one package.
  {
    key: "bam-masterdata-v0",
    label: "bam-masterdata v0",
    namespace: "bam_masterdata.datamodel.v0",
    branch: "main",
    pkg: "bam_masterdata.datamodel.v0.object_types",
    root: "SearchQuery",
  },
  {
    key: "bam-masterdata-v1",
    label: "bam-masterdata v1",
    namespace: "bam_masterdata.datamodel.v1",
    branch: "computation-schema-draft",
    pkg: "bam_masterdata.datamodel.v1.base_objects",
    root: "Root",
    // Read from a draft branch, not a release.
    draft: true,
  },
];
