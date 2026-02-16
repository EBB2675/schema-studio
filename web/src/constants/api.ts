import { LIGHT_MODE } from "./defaults";

export const API_VERSION = "2025-01-05";
export const API_VERSION_HEADER = "X-Schema-UML-Version";
export const API_FEATURE_HEADER = "X-Schema-UML-Features";

const CORE_FEATURE_FLAGS = ["empty-canvas", "editable-graph"];

export const DEFAULT_FEATURE_FLAGS = LIGHT_MODE
  ? CORE_FEATURE_FLAGS
  : [...CORE_FEATURE_FLAGS, "branch-diff"];
