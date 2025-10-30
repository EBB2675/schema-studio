from pathlib import Path
import os

# Where to keep a bare clone + worktrees
DATA_DIR = Path(os.getenv("SCHEMA_UML_DATA_DIR", Path(__file__).resolve().parent / "_data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

# Local path or remote URL to your nomad-simulations repo
NOMAD_SIM_REPO = os.getenv("NOMAD_SIM_REPO", str(Path.home() / "src/nomad-simulations"))

# Python module you extract from (can be overridden per request)
DEFAULT_PACKAGE = os.getenv("SCHEMA_UML_PACKAGE", "nomad_simulations.model_method")

EXTRACTOR_ENTRY = os.getenv("SCHEMA_UML_EXTRACTOR", "extractor.graph_builder:build_graph")