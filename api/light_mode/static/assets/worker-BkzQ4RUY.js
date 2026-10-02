var f=`"""What the static site asks Python for, answered with \`core\` (runs in the browser with Pyodide).

The static site has no server: its web worker loads the snapshot files of the
site into \`add_snapshot\` and sends each request to \`handle\` as JSON text,
getting JSON text back. Stored edits live in the browser and come with each
request. The answers are those of the Light Mode server for the same snapshot
and edits.

Standard library only, like \`core\`; YAML needs PyYAML.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from . import core, edits, graph

_SNAPSHOTS: dict[str, dict[str, Any]] = {}
_KEEP = 12


class Failure(Exception):
    """An answer with an HTTP status, as the server would give it."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def has_snapshot(path: str) -> bool:
    return path in _SNAPSHOTS


def add_snapshot(path: str, text: str) -> None:
    """Keep a snapshot file of the site by its path; the oldest go when there are too many."""
    _SNAPSHOTS.pop(path, None)
    _SNAPSHOTS[path] = json.loads(text)
    while len(_SNAPSHOTS) > _KEEP:
        _SNAPSHOTS.pop(next(iter(_SNAPSHOTS)))


def _snapshot(path: str) -> dict[str, Any]:
    try:
        return _SNAPSHOTS[path]
    except KeyError:
        raise Failure(500, f"Snapshot not loaded: {path}") from None


def _profile(request: Mapping[str, Any]) -> core.Profile:
    profile = request["profile"]
    return core.Profile(profile["key"], profile["default_base_namespace"], profile.get("edit_rule_set") or "nomad")


def _state(request: Mapping[str, Any], stored=None) -> core.Edited:
    return core.edited(
        _profile(request), _snapshot(request["snapshot"]), request["package"],
        request.get("stored") or () if stored is None else stored,
    )


def _graph(state: core.Edited, request: Mapping[str, Any], root: str | None) -> dict[str, Any]:
    flags = dict(request.get("flags") or {})
    flags["root"] = root
    try:
        return core.build_graph(state, request["package"], empty=bool(request.get("empty")), **flags)
    except graph.RootNotFound as exc:
        raise Failure(400, f"ValueError: {exc}") from exc


def graph_of(request: Mapping[str, Any]) -> dict[str, Any]:
    """\`GET /schema\`: the module's graph with the stored edits."""
    return _graph(_state(request), request, (request.get("flags") or {}).get("root"))


def sections(request: Mapping[str, Any]) -> list[str]:
    """\`GET /roots\`: the roots the module offers with the stored edits."""
    return sorted(core.section_names(_state(request), request["package"]))


def usage(request: Mapping[str, Any]) -> list[dict[str, Any]]:
    """\`GET /usage\`: the code that acts on a section, from the module's snapshot or else the profile's."""
    section_id = request["section_id"]
    if request.get("stored"):
        section_id = core.usage_source(_state(request), section_id)
        if section_id is None:
            return []
    snapshots = [_snapshot(path) for path in request["usage_snapshots"]]
    return core.usage_entries(snapshots, section_id)


def add_edits(request: Mapping[str, Any]) -> dict[str, Any]:
    """\`POST /schema/edits\`: check the new edits, build the graph with them, and return them ready to store.

    \`ids\` and \`created_at\` come from the browser's edit store; nothing is
    stored here. All edits apply or none (a 400 names the reason).
    """
    package = request["package"]
    stored = request.get("stored") or []
    try:
        prepared = core.prepare(_state(request), package, request.get("edits") or [])
        root = core.root_after(_state(request), package, prepared, (request.get("flags") or {}).get("root"))
    except edits.EditError as exc:
        raise Failure(400, f"{exc.detail or exc} ({exc.reason})") from exc
    result = _graph(_state(request, [*stored, *prepared]), request, root)
    profile = request["profile"]["key"]
    saved = [
        {"id": edit_id, "profile": profile, "package": edit.get("package") or package, "commit": edit.get("commit"),
         "op": edit["op"], "target": edit["target"], "payload": edit.get("payload") or {},
         "created_at": request.get("created_at")}
        for edit_id, edit in zip(request["ids"], prepared)
    ]
    return core.with_stored(result, prepared, saved)


def linkml_yaml(request: Mapping[str, Any]) -> str:
    """\`GET /schema/linkml\`: the module's schema as LinkML YAML, with the stored edits."""
    if not request.get("stored"):
        return core.snapshot_yaml(_snapshot(request["snapshot"]))
    return core.edited_yaml(_state(request))


_HANDLERS = {
    "graph": graph_of,
    "sections": sections,
    "usage": usage,
    "add_edits": add_edits,
    "linkml_yaml": linkml_yaml,
}


def handle(text: str) -> str:
    """One request (\`{"op": ..., ...}\`) as JSON text; the answer as \`{"ok": ...}\` or \`{"error": ..., "status": ...}\`."""
    request = json.loads(text)
    try:
        return json.dumps({"ok": _HANDLERS[request["op"]](request)})
    except Failure as exc:
        return json.dumps({"error": exc.detail, "status": exc.status})
    except Exception as exc:  # an answer the page can show, not a dead worker
        return json.dumps({"error": f"{type(exc).__name__}: {exc}", "status": 500})
`,h=`"""Edits replayed onto a snapshot, and what the app reads from the result: graph, roots, usage, YAML.

Plain data in and out, standard library only (PyYAML for the YAML, imported
only when YAML is asked for), so the server and the static site in the
browser run the same code. The caller hands
in the snapshot; loading it (from the cache, a git worktree or a file of the
site) is not done here.

\`profile\` is anything with the attributes \`key\`, \`default_base_namespace\` and
\`edit_rules\` (the server's \`SchemaProfile\`, or \`Profile\` below).

An edit is stored under the module that owns its target: the module of the
class it changes (a new class: the module it is added to). Every module's
graph replays all of the profile's edits in the order they were made, so a
class shows the same edits wherever it appears; an edit stored under another
module that does not apply to this module's snapshot (its target is not
there) is skipped silently, and only the module's own edits are reported as
conflicts.

The empty canvas uses a module that does not exist
(\`<base namespace>.custom_schema\`); it starts from the whole profile's schema,
so new classes can build on existing ones, and its graph shows only the
classes the edits added there.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, NamedTuple

from . import edits as edit_ops
from . import graph

SCRATCH_SUFFIX = ".custom_schema"


class Profile(NamedTuple):
    """The profile facts the core needs (the static site has no \`SchemaProfile\`)."""

    key: str
    default_base_namespace: str
    edit_rules: str = "nomad"


class Edited:
    """A snapshot's schema with edits replayed onto it."""

    def __init__(
        self,
        profile: Any,
        snapshot: dict[str, Any],
        schema: dict[str, Any],
        applied: list[Mapping[str, Any]],
        conflicts: list[dict[str, Any]],
        commit: str | None,
    ) -> None:
        self.profile = profile
        self.snapshot = snapshot
        self.schema = schema
        self.applied = applied
        self.conflicts = conflicts
        self.commit = commit


def is_scratch(package: str) -> bool:
    return package.endswith(SCRATCH_SUFFIX)


def snapshot_scope(profile: Any, package: str) -> str:
    """The snapshot a module's graph is built from: its own, or the whole profile's for the empty canvas."""
    return profile.default_base_namespace if is_scratch(package) else package


def snapshot_commit(snapshot: Mapping[str, Any]) -> str | None:
    """The schema commit a snapshot was read from (its package version if not installed from git)."""
    source = snapshot.get("source") or {}
    return source.get("commit") or source.get("version")


def _own(edit: Mapping[str, Any], package: str) -> bool:
    return edit.get("package") in (None, package)


def edited(
    profile: Any,
    snapshot: dict[str, Any],
    package: str,
    stored: Sequence[Mapping[str, Any]] = (),
    *,
    commit: str | None = None,
) -> Edited:
    """The snapshot with the profile's edits replayed; conflicts are the module's own."""
    commit = commit or snapshot_commit(snapshot)
    schema, applied, conflicts = edit_ops.apply_edits(snapshot["linkml"], stored, rules=profile.edit_rules, commit=commit)
    conflicts = [conflict for conflict in conflicts if _own(conflict["edit"], package)]
    return Edited(profile, snapshot, schema, applied, conflicts, commit)


def module_view(state: Edited, package: str, empty: bool = False) -> dict[str, Any]:
    """The extraction document the graph reads; the empty canvas binds nothing of the source."""
    extraction = state.snapshot["extraction"]
    if empty or is_scratch(package):
        # Only what the edits added to this module; nothing the source module binds.
        extraction = {**extraction, "modules": []}
    return extraction


def build_graph(state: Edited, package: str, *, empty: bool = False, **flags: Any) -> dict[str, Any]:
    """The module's graph from the edited schema, with \`applied_edits\` and \`edit_conflicts\` when there are any.

    Raises \`graph.RootNotFound\` for a root the module does not offer.
    """
    root = flags.get("root") or None
    result = graph.build_graph(state.schema, module_view(state, package, empty), package, **{**flags, "root": root})
    result["root"] = flags.get("root")
    if state.applied:
        result["applied_edits"] = list(state.applied)
    if state.conflicts:
        result["edit_conflicts"] = state.conflicts
    return result


def section_names(state: Edited, package: str) -> list[str]:
    """The roots a module offers, edits included."""
    return graph.section_names(state.schema, module_view(state, package), package)


def usage_source(state: Edited, section_id: str) -> str | None:
    """The class whose usage a section shows: its source class when renamed; None for a class only the edits have."""
    cls = (state.schema.get("classes") or {}).get(section_id)
    if cls is None:
        return section_id
    if graph.annotation(cls, edit_ops.ADDED) == "true":
        return None  # no code acts on a class that only the edits have
    return graph.source_class_id(section_id, cls)


def usage_entries(snapshots: Sequence[Mapping[str, Any]], section_id: str) -> list[dict[str, Any]]:
    """Usage of a section from the first snapshot that holds it (the module's, then the profile's)."""
    for snapshot in snapshots:
        entries = graph.usage_entries(snapshot["extraction"], section_id)
        if entries is not None:
            return entries
    return []


def owner(state: Edited, edit: Mapping[str, Any], package: str) -> str:
    """The module an edit is stored under: the module of the class it changes, else the module shown.

    Classes outside the profile's namespace (NOMAD base sections from
    nomad-lab) belong to no module of the profile; their edits stay with the
    module they were made in.
    """
    if edit["op"] == "add_class":
        return package
    classes = state.schema.get("classes") or {}
    name = edit["target"]
    if name not in classes:
        enum = (state.schema.get("enums") or {}).get(name) or {}
        vocabulary = graph.annotation(enum, "source_vocabulary_class")
        # A NOMAD enum is named after its quantity: \`<class>.<attribute>\`.
        name = vocabulary if vocabulary in classes else name.rpartition(".")[0]
    cls = classes.get(name)
    if cls is None:
        return package
    module = graph.class_module(name, cls)
    namespace = state.profile.default_base_namespace
    return module if module == namespace or module.startswith(f"{namespace}.") else package


def prepare(state: Edited, package: str, requests: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """New edits (\`op\`, \`target\`, \`payload\`), checked in order on top of the replayed ones; raises \`EditError\`.

    All of them apply or none: an error in one leaves nothing to store. Each
    edit gets the module it is to be stored under (\`package\`). \`state\` is
    changed: its schema ends up with the new edits applied.
    """
    schema = state.schema
    prepared = []
    for request in requests:
        edit = edit_ops.prepare_edit(
            schema, str(request.get("op") or ""), str(request.get("target") or ""), request.get("payload") or {},
            rules=state.profile.edit_rules, package=package, profile=state.profile.key, commit=state.commit,
        )
        edit["package"] = owner(state, edit, package)
        edit_ops.apply_edit(schema, edit, rules=state.profile.edit_rules)
        prepared.append(edit)
    return prepared


def root_after(state: Edited, package: str, prepared: Sequence[Mapping[str, Any]], root: str | None) -> str | None:
    """The root a graph can use once new edits apply: renamed with its class, or none when the class is gone.

    \`state\` is the schema before the new edits.
    """
    if not root:
        return root
    view = module_view(state, package)
    _, before = graph.entry_points(state.schema, view, package)
    after_schema, _, _ = edit_ops.apply_edits(state.schema, prepared, rules=state.profile.edit_rules)
    _, after = graph.entry_points(after_schema, view, package)
    if root in after:
        return root
    target = before.get(root)
    for edit in prepared:
        if edit["op"] == "rename_class" and edit["target"] == target:
            target = f"{target.rpartition('.')[0]}.{edit['payload']['new_name']}"
    return next((name for name, cls in after.items() if cls == target), None)


def with_stored(
    result: dict[str, Any], prepared: Sequence[Mapping[str, Any]], saved: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """A graph built with edits before they were stored, showing them as stored (with their ids)."""
    stored_as = {id(edit): stored for edit, stored in zip(prepared, saved)}
    if "applied_edits" in result:
        result["applied_edits"] = [stored_as.get(id(edit), edit) for edit in result["applied_edits"]]
    for conflict in result.get("edit_conflicts") or ():
        conflict["edit"] = stored_as.get(id(conflict["edit"]), conflict["edit"])
    result["persisted_edits"] = list(saved)
    return result


def snapshot_yaml(snapshot: Mapping[str, Any]) -> str:
    """The snapshot's schema as converted, as LinkML YAML."""
    from .linkml_yaml import dump_yaml

    return dump_yaml(
        snapshot["linkml"], profile=snapshot["profile"], source=snapshot["source"], tools=snapshot["tools"],
        report=snapshot["report"],
    )


def edited_yaml(state: Edited) -> str:
    """The edited schema as LinkML YAML; marked as edited when an edit applied."""
    from .linkml_yaml import dump_yaml

    snapshot = state.snapshot
    return dump_yaml(
        state.schema, profile=snapshot["profile"], source=snapshot["source"], tools=snapshot["tools"],
        edited=bool(state.applied), report=snapshot["report"],
    )
`,y=`"""Edit operations on a LinkML schema held as plain JSON data.

Plain data in and out, standard library only, so the same code can run in the
browser. Where edits are stored (SQLite on the server, browser storage in
static mode) is not decided here: an edit is a plain dict, and replaying a
list of them onto the freshly converted schema gives the edited schema, which
the graph adapter and the YAML export then read.

An edit:

    {"op": "add_attribute", "target": "<class or enum name>", "payload": {...},
     "profile": "nomad-simulations", "commit": "<schema commit it was made on>"}

plus whatever its store adds (\`id\`, \`package\`, times). \`prepare_edit\` checks a
new edit against the current schema and the profile's rules and fills in
everything it derives (the id of a new class, an attribute name derived from a
code, the value a \`set_*\` edit replaces), so replaying it later needs nothing
but the stored edit.

Operations (\`target\` is a class name unless noted):

- \`add_class\` (target: the new class's name, \`<module>.<Name>\`):
  \`is_a\`, \`description\`; bam-masterdata also \`code\`, \`description_de\`;
- \`rename_class\`: \`new_name\`; references (bases, ranges, the class's
  vocabulary enum) follow, and the class keeps its source id in the
  annotation \`source_class\`, so its module bindings, methods and usage stay;
- \`remove_class\`: refused while anything still refers to the class;
- \`add_attribute\`: NOMAD \`name\`, \`kind\` (\`quantity\` with \`dtype\`, or
  \`subsection\` with \`range\` and \`multivalued\`), \`description\`;
  bam-masterdata \`code\`, \`data_type\`, \`range\` (the object type or vocabulary
  class of an OBJECT or CONTROLLEDVOCABULARY property), \`mandatory\`, \`label\`,
  \`section\`, \`description\`, \`description_de\`, optional \`name\`;
- \`rename_attribute\`: \`attribute\`, \`new_name\`;
- \`remove_attribute\`: \`attribute\`;
- \`set_range\`: \`attribute\` and the same type fields as \`add_attribute\`;
- \`set_description\`: \`description\` (and \`description_de\` for
  bam-masterdata) of the class, of its \`attribute\`, or of an enum \`value\`;
- \`set_required\`: \`attribute\`, \`required\`;
- \`add_enum_value\`, \`remove_enum_value\` (target: an enum, or a
  bam-masterdata vocabulary class): \`value\`; bam-masterdata terms also
  \`label\`, \`description\`, optional \`name\` (the Python name).

Attributes are edited on the class that declares them; on a class that
inherits them they are read-only. New elements get the annotations extracted
ones have (source facts, display values, ids) and \`edit_added\`, so the graph
shows them the same way.
"""
from __future__ import annotations

import copy
import json
import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any, NamedTuple

OPS = (
    "add_class", "rename_class", "remove_class",
    "add_attribute", "rename_attribute", "remove_attribute",
    "set_range", "set_description", "set_required",
    "add_enum_value", "remove_enum_value",
)
SET_OPS = ("set_range", "set_description", "set_required")
ADDED = "edit_added"

_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# bam-masterdata: uppercase segments separated by dots; \`$\` marks codes native to openBIS.
_BAM_CODE = re.compile(r"^[A-Z0-9_]+(\\.[A-Z0-9_]+)*$")
BAM_TERM_CODE_LIMIT = 50


class EditError(ValueError):
    """An edit that cannot be applied to the schema; \`reason\` is a short machine-readable word."""

    def __init__(self, reason: str, detail: str) -> None:
        super().__init__(detail)
        self.reason = reason
        self.detail = detail


# -------- profile rules --------

def _nomad_type(kind: str, data: str) -> str:
    """The extractor's text for a NOMAD datatype (\`range.name\`, annotation \`source_type\`)."""
    return json.dumps({"type_data": data, "type_kind": kind}, sort_keys=True)


# Editable NOMAD dtypes: the name offered, the NOMAD type, its LinkML range and
# the text NOMAD shows for it (what the extractor puts in \`display_dtype\`).
NOMAD_DTYPES: dict[str, dict[str, str]] = {
    name: {"source_type": _nomad_type(kind, data), "range": linkml, "display": display}
    for name, kind, data, linkml, display in (
        ("bool", "python", "bool", "boolean", "m_bool(bool)"),
        ("str", "python", "str", "string", "m_str(str)"),
        ("datetime", "custom", "nomad.metainfo.data_type.Datetime", "datetime", "Datetime"),
        ("int", "python", "int", "integer", "m_int32(int)"),
        ("float", "python", "float", "float", "m_float64(float)"),
        ("int32", "numpy", "int32", "integer", "m_int32(int32)"),
        ("int64", "numpy", "int64", "integer", "m_int64(int64)"),
        ("float32", "numpy", "float32", "float", "m_float32(float32)"),
        ("float64", "numpy", "float64", "double", "m_float64(float64)"),
    )
}

# openBIS data types and their LinkML ranges, as the bam-masterdata converter maps them.
BAM_DATA_TYPES: dict[str, str | None] = {
    "BOOLEAN": "boolean",
    "CONTROLLEDVOCABULARY": None,
    "DATE": "date",
    "HYPERLINK": "uri",
    "INTEGER": "integer",
    "MULTILINE_VARCHAR": "string",
    "OBJECT": None,
    "REAL": "double",
    "SAMPLE": None,
    "TIMESTAMP": "datetime",
    "VARCHAR": "string",
    "XML": None,
}

RULE_SETS = ("nomad", "bam-masterdata")


def rules_summary(rules: str) -> dict[str, Any]:
    """What a client needs to offer edits for a rule set: the type choices and which fields are asked for."""
    if rules == "nomad":
        return {
            "name": rules,
            "attribute_kinds": ["quantity", "subsection"],
            "dtypes": [{"name": name, "display": spec["display"]} for name, spec in NOMAD_DTYPES.items()],
            "codes": False,
        }
    if rules == "bam-masterdata":
        return {
            "name": rules,
            "attribute_kinds": ["property"],
            "dtypes": [{"name": name, "display": name, "needs_range": name in ("OBJECT", "CONTROLLEDVOCABULARY")}
                       for name in BAM_DATA_TYPES],
            "codes": True,
            "term_code_limit": BAM_TERM_CODE_LIMIT,
        }
    raise EditError("invalid", f"unknown edit rules {rules!r}")


def bam_class_name(code: str) -> str:
    """The class name bam-masterdata derives from an object type code (\`code_to_class_name\`)."""
    return "".join(part.capitalize() for part in code.lstrip("$").rsplit(".")[-1].split("_"))


def bam_attribute_name(code: str) -> str:
    """The Python name bam-masterdata gives a property or term in nearly every case: the code in lower case."""
    return code.lstrip("$").lower().replace(".", "_")


# -------- plain-data helpers --------

def annotation(element: Mapping[str, Any], tag: str) -> str | None:
    value = (element.get("annotations") or {}).get(tag)
    if isinstance(value, Mapping):
        value = value.get("value")
    return None if value is None else str(value)


def _json_annotation(element: Mapping[str, Any], tag: str) -> Any:
    text = annotation(element, tag)
    return None if text is None else json.loads(text)


def _set_annotation(element: dict[str, Any], tag: str, value: Any) -> None:
    annotations = element.setdefault("annotations", {})
    if value is None:
        annotations.pop(tag, None)
        if not annotations:
            element.pop("annotations")
    else:
        annotations[tag] = value


def _json_text(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False)


def _segment(segment: str) -> str:
    return segment.replace("%", "%25").replace(".", "%2E")


def _element_id(schema: Mapping[str, Any], *segments: str) -> str | None:
    """\`<prefix>:<segment>.<segment>\`, as the converters build \`class_uri\` and \`slot_uri\`."""
    prefix = schema.get("default_prefix")
    return f"{prefix}:" + ".".join(_segment(segment) for segment in segments) if prefix else None


def _text(payload: Mapping[str, Any], key: str) -> str | None:
    value = payload.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise EditError("invalid", f"{key} must be text")
    return value.strip() or None


def _required_text(payload: Mapping[str, Any], key: str) -> str:
    value = _text(payload, key)
    if not value:
        raise EditError("invalid", f"{key} is required")
    return value


def _identifier(value: str, what: str) -> str:
    if not _IDENTIFIER.match(value):
        raise EditError("invalid", f"{what} {value!r} is not a valid name (letters, digits and _, not starting with a digit)")
    return value


def _bam_code(value: str, what: str) -> str:
    if not _BAM_CODE.match(value):
        raise EditError(
            "invalid",
            f"{what} {value!r} must be upper case letters, digits and _, in segments separated by dots"
            " (codes starting with $ are reserved for openBIS)",
        )
    return value


def _title(name: str, cls: Mapping[str, Any]) -> str:
    return cls.get("title") or name.rpartition(".")[2]


def _module(name: str, cls: Mapping[str, Any]) -> str:
    title = cls.get("title")
    if title and name.endswith(f".{title}"):
        return name[: -len(title) - 1]
    return name.rpartition(".")[0]


def _classes(schema: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    return schema.setdefault("classes", {})


def _class(schema: Mapping[str, Any], name: str) -> dict[str, Any]:
    cls = (schema.get("classes") or {}).get(name)
    if cls is None:
        raise EditError("not_found", f"class {name!r} is not in the schema")
    return cls


def _ancestors(classes: Mapping[str, Mapping[str, Any]], name: str) -> list[str]:
    """Every base of a class (through \`is_a\` and \`mixins\`), nearest first, the class itself excluded."""
    found: list[str] = []
    pending = [name]
    while pending:
        current = classes.get(pending.pop(0)) or {}
        for base in [current.get("is_a"), *(current.get("mixins") or [])]:
            if base and base in classes and base not in found and base != name:
                found.append(base)
                pending.append(base)
    return found


def _inherited_from(classes: Mapping[str, Mapping[str, Any]], name: str, attribute: str) -> str | None:
    for ancestor in _ancestors(classes, name):
        if attribute in (classes[ancestor].get("attributes") or {}):
            return ancestor
    return None


def _declared(schema: Mapping[str, Any], name: str, attribute: str) -> dict[str, Any]:
    """An attribute the class declares itself; an inherited one is edited on its declaring class."""
    classes = schema.get("classes") or {}
    cls = _class(schema, name)
    slot = (cls.get("attributes") or {}).get(attribute)
    if slot is not None:
        return slot
    owner = _inherited_from(classes, name, attribute)
    if owner is not None:
        raise EditError("inherited", f"{attribute!r} is inherited from {_title(owner, classes[owner])}; edit it there")
    raise EditError("not_found", f"{_title(name, cls)} has no attribute {attribute!r}")


class Reference(NamedTuple):
    """A use of a class or enum: as a base of \`owner\`, as the range of \`owner.attribute\`, or as an enum's base."""

    owner: str
    kind: str  # "base", "range" or "enum_base"
    attribute: str | None = None

    def describe(self, schema: Mapping[str, Any]) -> str:
        if self.kind == "enum_base":
            return f"enum {self.owner} inherits from it"
        cls = (schema.get("classes") or {}).get(self.owner) or {}
        title = _title(self.owner, cls)
        return f"{title} inherits from it" if self.kind == "base" else f"{title}.{self.attribute} refers to it"


def _references(schema: Mapping[str, Any], target: str) -> list[Reference]:
    """Where a class or enum is used: bases and attribute ranges of every class, and enum bases."""
    found = []
    for name, cls in (schema.get("classes") or {}).items():
        if cls.get("is_a") == target or target in (cls.get("mixins") or []):
            found.append(Reference(name, "base"))
        for attribute, slot in (cls.get("attributes") or {}).items():
            if slot.get("range") == target:
                found.append(Reference(name, "range", attribute))
    for name, enum in (schema.get("enums") or {}).items():
        if target in (enum.get("inherits") or []):
            found.append(Reference(name, "enum_base"))
    return found


def _vocabulary_enum(schema: Mapping[str, Any], target: str) -> str:
    """The enum an enum edit targets: the enum itself, or a bam-masterdata vocabulary class's enum."""
    enums = schema.get("enums") or {}
    if target in enums:
        return target
    cls = (schema.get("classes") or {}).get(target)
    enum_name = annotation(cls, "source_vocabulary_enum") if cls else None
    if enum_name in enums:
        return enum_name
    if cls is not None:
        raise EditError("invalid", f"{_title(target, cls)} is not a vocabulary")
    raise EditError("not_found", f"enum {target!r} is not in the schema")


def _is_vocabulary(cls: Mapping[str, Any]) -> bool:
    if annotation(cls, "source_vocabulary_enum"):
        return True
    source = _json_annotation(cls, "source_annotations") or {}
    return source.get("entity_kind") == "VocabularyTypeDef"


# -------- attribute types --------

def _nomad_type_fields(schema: Mapping[str, Any], kind: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    """Range, annotations and multivalued of a NOMAD quantity or subsection."""
    if kind == "quantity":
        dtype = _required_text(payload, "dtype")
        spec = NOMAD_DTYPES.get(dtype)
        if spec is None:
            raise EditError("invalid", f"unsupported dtype {dtype!r}; supported: {', '.join(NOMAD_DTYPES)}")
        return {
            "range": spec["range"],
            "annotations": {
                "source_range": _json_text({"kind": "datatype", "name": spec["source_type"]}),
                "source_type": spec["source_type"],
                "display_dtype": spec["display"],
            },
        }
    if kind == "subsection":
        target = _required_text(payload, "range")
        if target not in (schema.get("classes") or {}):
            raise EditError("not_found", f"subsection target {target!r} is not a class of the schema")
        multivalued = bool(payload.get("multivalued"))
        return {
            "range": target,
            "multivalued": multivalued,
            "annotations": {
                "source_range": _json_text({"kind": "class", "name": target}),
                "display_card": "0..*" if multivalued else "0..1",
            },
        }
    raise EditError("invalid", f"unsupported attribute kind {kind!r}; supported: quantity, subsection")


def _bam_type_fields(schema: Mapping[str, Any], payload: Mapping[str, Any]) -> dict[str, Any]:
    """Range, annotations and openBIS facts of a bam-masterdata property."""
    data_type = _required_text(payload, "data_type")
    if data_type not in BAM_DATA_TYPES:
        raise EditError("invalid", f"unsupported data type {data_type!r}; supported: {', '.join(BAM_DATA_TYPES)}")
    classes = schema.get("classes") or {}
    facts: dict[str, Any] = {"data_type": data_type}
    fields: dict[str, Any] = {"annotations": {}}
    if data_type in ("OBJECT", "CONTROLLEDVOCABULARY"):
        target = _required_text(payload, "range")
        if target not in classes:
            raise EditError("not_found", f"{data_type} target {target!r} is not a class of the schema")
        target_class = classes[target]
        code = annotation(target_class, "source_entity_code")
        if data_type == "CONTROLLEDVOCABULARY":
            enum_name = annotation(target_class, "source_vocabulary_enum")
            if not enum_name or enum_name not in (schema.get("enums") or {}):
                raise EditError("invalid", f"{_title(target, target_class)} is not a vocabulary")
            fields["range"] = enum_name
            source_range = {"kind": "enum", "name": enum_name}
            facts["vocabulary_code"] = code
        else:
            if _is_vocabulary(target_class):
                raise EditError("invalid", f"{_title(target, target_class)} is a vocabulary, not an object type")
            fields["range"] = target
            source_range = {"kind": "class", "name": target}
            facts["object_code"] = code
        if not code:
            raise EditError("invalid", f"{_title(target, target_class)} has no openBIS code")
        fields["annotations"]["display_dtype"] = f"{data_type}[{code}]"
    else:
        source_range = {"kind": "datatype", "name": data_type}
        if BAM_DATA_TYPES[data_type]:
            fields["range"] = BAM_DATA_TYPES[data_type]
        fields["annotations"]["source_type"] = data_type
        fields["annotations"]["display_dtype"] = data_type
    fields["annotations"]["source_range"] = _json_text(source_range)
    fields["facts"] = facts
    return fields


def _apply_type_fields(slot: dict[str, Any], fields: Mapping[str, Any]) -> None:
    """Replace a slot's type: range, multivalued and the annotations that describe the type."""
    for key in ("range", "multivalued"):
        slot.pop(key, None)
        if key in fields:
            slot[key] = fields[key]
    for tag in ("source_range", "source_type", "display_dtype"):
        _set_annotation(slot, tag, fields["annotations"].get(tag))
    if "display_card" in fields["annotations"]:
        _set_annotation(slot, "display_card", fields["annotations"]["display_card"])
    if "facts" in fields:
        source = _json_annotation(slot, "source_annotations") or {}
        for key in ("data_type", "vocabulary_code", "object_code"):
            source.pop(key, None)
        source.update({key: value for key, value in fields["facts"].items() if value is not None})
        _set_annotation(slot, "source_annotations", _json_text(source))


def _property_codes(schema: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Every bam-masterdata property code in use, with the openBIS facts of its first use."""
    found: dict[str, dict[str, Any]] = {}
    for cls in (schema.get("classes") or {}).values():
        for slot in (cls.get("attributes") or {}).values():
            code = annotation(slot, "source_property_code")
            if code and code not in found:
                found[code] = _json_annotation(slot, "source_annotations") or {}
    return found


def _check_property_code(schema: Mapping[str, Any], code: str, facts: Mapping[str, Any]) -> None:
    """A property code names one openBIS property type: reusing it must keep its type and target."""
    used = _property_codes(schema).get(code)
    if used is None:
        return
    for key in ("data_type", "vocabulary_code", "object_code"):
        if used.get(key) != facts.get(key):
            stated = used.get(key) or "none"
            raise EditError("invalid", f"property code {code} is already used with {key} {stated}")


# -------- preparing an edit --------

def _current_value(schema: Mapping[str, Any], op: str, target: str, payload: Mapping[str, Any]) -> Any:
    """What a \`set_*\` edit replaces, recorded so a replay can tell when the source changed it."""
    if op == "set_description":
        element = _description_element(schema, target, payload)
        return {"description": element.get("description"), "description_de": annotation(element, "description_de")}
    slot = _declared(schema, target, payload.get("attribute") or "")
    if op == "set_required":
        return bool(slot.get("required"))
    return {"range": slot.get("range"), "display_dtype": annotation(slot, "display_dtype")}


def prepare_edit(
    schema: Mapping[str, Any],
    op: str,
    target: str,
    payload: Mapping[str, Any] | None,
    *,
    rules: str,
    package: str,
    profile: str | None = None,
    commit: str | None = None,
) -> dict[str, Any]:
    """A complete edit, checked against the current (edited) schema; raises \`EditError\` if it cannot apply.

    Derived values are filled in here, so a stored edit replays the same way
    later: the full name of a new class (\`<package>.<Name>\`, for
    bam-masterdata derived from its code), an attribute or term name derived
    from its code, and for \`set_*\` edits the value they replace (\`before\`).
    """
    if op not in OPS:
        raise EditError("invalid", f"unknown edit {op!r}; known: {', '.join(OPS)}")
    if rules not in RULE_SETS:
        raise EditError("invalid", f"unknown edit rules {rules!r}")
    payload = dict(payload or {})
    target = (target or "").strip()
    if op == "add_class":
        if rules == "bam-masterdata":
            code = _bam_code(_required_text(payload, "code"), "object type code")
            payload["code"] = code
            payload.setdefault("name", bam_class_name(code))
        name = _identifier(_required_text(payload, "name"), "class name")
        payload["name"] = name
        target = f"{package}.{name}"
    elif op in ("add_attribute",) and rules == "bam-masterdata":
        code = _bam_code(_required_text(payload, "code"), "property code")
        payload["code"] = code
        if not _text(payload, "name"):
            payload["name"] = bam_attribute_name(code)
    elif op == "add_enum_value" and rules == "bam-masterdata" and _text(payload, "value") and not _text(payload, "name"):
        payload["name"] = bam_attribute_name(_required_text(payload, "value"))
    if not target:
        raise EditError("invalid", "target is required")
    if op in SET_OPS:
        payload.pop("before", None)
        payload["before"] = _current_value(schema, op, target, payload)
    edit = {"op": op, "target": target, "payload": payload, "profile": profile, "commit": commit}
    # Applying it to a copy is the check: an edit that is stored always applied once.
    apply_edit(copy.deepcopy(schema), edit, rules=rules)
    return edit


# -------- applying edits --------

def apply_edit(schema: dict[str, Any], edit: Mapping[str, Any], *, rules: str) -> None:
    """Apply one edit to the schema in place; raises \`EditError\` (and changes nothing) if it cannot apply."""
    op = edit.get("op")
    handler = _HANDLERS.get(op or "")
    if handler is None:
        raise EditError("invalid", f"unknown edit {op!r}")
    target = edit.get("target")
    if not isinstance(target, str) or not target:
        raise EditError("invalid", "target is required")
    payload = edit.get("payload") or {}
    if not isinstance(payload, Mapping):
        raise EditError("invalid", "payload must be an object")
    handler(schema, target, payload, rules)


def apply_edits(
    schema: Mapping[str, Any],
    edits: Iterable[Mapping[str, Any]],
    *,
    rules: str,
    commit: str | None = None,
) -> tuple[dict[str, Any], list[Mapping[str, Any]], list[dict[str, Any]]]:
    """Replay edits in order onto a copy of the schema: (edited schema, applied edits, conflicts).

    An edit that cannot apply is skipped and reported (\`applied: false\`).
    A \`set_*\` edit made on another commit, whose target the source has
    changed since (its \`before\` value differs), is applied and reported as
    \`changed_upstream\` (\`applied: true\`).
    """
    edited = copy.deepcopy(dict(schema))
    applied: list[Mapping[str, Any]] = []
    conflicts: list[dict[str, Any]] = []
    for edit in edits:
        payload = edit.get("payload") or {}
        stale = None
        if edit.get("op") in SET_OPS and "before" in payload and commit and edit.get("commit") not in (None, commit):
            try:
                if _current_value(edited, edit["op"], edit["target"], payload) != payload["before"]:
                    stale = "the source changed this since the edit was made"
            except EditError:
                pass  # apply_edit below reports it
        trial = copy.deepcopy(edited)
        try:
            apply_edit(trial, edit, rules=rules)
        except EditError as error:
            conflicts.append({"edit": edit, "reason": error.reason, "detail": error.detail, "applied": False})
            continue
        edited = trial
        applied.append(edit)
        if stale:
            conflicts.append({"edit": edit, "reason": "changed_upstream", "detail": stale, "applied": True})
    return edited, applied, conflicts


def _add_class(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    name = _identifier(_required_text(payload, "name"), "class name")
    if not target.endswith(f".{name}"):
        raise EditError("invalid", f"class {target!r} must end with its name {name!r}")
    module = target[: -len(name) - 1]
    if target in classes:
        raise EditError("exists", f"class {name} already exists in {module}")
    if any(_module(other, cls) == module and _title(other, cls) == name for other, cls in classes.items()):
        raise EditError("exists", f"a class named {name} already exists in {module}")
    is_a = _text(payload, "is_a")
    if is_a is not None and is_a not in classes:
        raise EditError("not_found", f"base class {is_a!r} is not in the schema")
    cls: dict[str, Any] = {"name": target, "title": name}
    description = _text(payload, "description")
    if description:
        cls["description"] = description
    class_uri = _element_id(schema, target)
    if class_uri:
        cls["class_uri"] = class_uri
    if is_a:
        cls["is_a"] = is_a
    annotations: dict[str, str] = {"source_bases": _json_text([is_a] if is_a else [])}
    if rules == "bam-masterdata":
        code = _bam_code(_required_text(payload, "code"), "object type code")
        if is_a:
            base = classes[is_a]
            if _is_vocabulary(base):
                raise EditError("invalid", f"{_title(is_a, base)} is a vocabulary; an object type cannot inherit from it")
            base_code = annotation(base, "source_entity_code")
            if base_code and not (code.startswith(f"{base_code}.") and "." not in code[len(base_code) + 1:]):
                raise EditError("invalid", f"an object type based on {base_code} needs the code {base_code}.<NAME>")
        for other, cls_other in classes.items():
            if annotation(cls_other, "source_entity_code") == code:
                raise EditError("exists", f"code {code} is already used by {_title(other, cls_other)}")
        annotations["source_entity_code"] = code
        german = _text(payload, "description_de")
        if german:
            annotations["description_de"] = german
        source = {"code": code, "entity_kind": "ObjectTypeDef"}
        if description:
            source["description"] = f"{description}//{german}" if german else description
        annotations["source_annotations"] = _json_text(source)
    annotations[ADDED] = "true"
    cls["annotations"] = annotations
    classes[target] = cls


def _rename_class(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    cls = _class(schema, target)
    new_title = _identifier(_required_text(payload, "new_name"), "class name")
    module = _module(target, cls)
    new_name = f"{module}.{new_title}" if module else new_title
    if new_name == target:
        raise EditError("invalid", f"{_title(target, cls)} already has that name")
    if new_name in classes or any(
        _module(other, other_cls) == module and _title(other, other_cls) == new_title
        for other, other_cls in classes.items() if other != target
    ):
        raise EditError("exists", f"a class named {new_title} already exists in {module}")
    renamed = dict(cls, name=new_name, title=new_title)
    class_uri = _element_id(schema, new_name)
    if class_uri and "class_uri" in cls:
        renamed["class_uri"] = class_uri
    if not annotation(cls, "source_class") and annotation(cls, ADDED) != "true":
        renamed["annotations"] = dict(cls.get("annotations") or {}, source_class=target)
    schema["classes"] = {(new_name if name == target else name): (renamed if name == target else other)
                         for name, other in classes.items()}
    for other in schema["classes"].values():
        if other.get("is_a") == target:
            other["is_a"] = new_name
        if target in (other.get("mixins") or []):
            other["mixins"] = [new_name if base == target else base for base in other["mixins"]]
        hint = _json_annotation(other, "source_effective_attributes")
        if hint and any(ref.get("declaring_class_id") == target for ref in hint):
            for ref in hint:
                if ref.get("declaring_class_id") == target:
                    ref["declaring_class_id"] = new_name
            _set_annotation(other, "source_effective_attributes", _json_text(hint))
        for attribute, slot in (other.get("attributes") or {}).items():
            if slot.get("range") == target:
                slot["range"] = new_name
            if annotation(slot, "source_declaring_class") == target:
                _set_annotation(slot, "source_declaring_class", new_name)
    for slot_name, slot in (renamed.get("attributes") or {}).items():
        if "slot_uri" in slot:
            slot["slot_uri"] = _element_id(schema, new_name, slot_name) or slot["slot_uri"]
    for enum in (schema.get("enums") or {}).values():
        if annotation(enum, "source_vocabulary_class") == target:
            _set_annotation(enum, "source_vocabulary_class", new_name)


def _remove_class(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    cls = _class(schema, target)
    # The class's own attributes going with it do not count; uses by other classes do.
    used = [reference for reference in _references(schema, target) if reference.owner != target]
    enum_name = annotation(cls, "source_vocabulary_enum")
    if enum_name:
        used += [reference for reference in _references(schema, enum_name) if reference.owner != target]
    if used:
        details = "; ".join(reference.describe(schema) for reference in used[:5])
        raise EditError("in_use", f"{_title(target, cls)} is still used: {details}")
    del schema["classes"][target]
    if enum_name:
        (schema.get("enums") or {}).pop(enum_name, None)


def _add_attribute(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    cls = _class(schema, target)
    name = _identifier(_required_text(payload, "name"), "attribute name")
    if name in (cls.get("attributes") or {}):
        raise EditError("exists", f"{_title(target, cls)} already has {name!r}")
    owner = _inherited_from(classes, target, name)
    if owner is not None:
        raise EditError("inherited", f"{name!r} is inherited from {_title(owner, classes[owner])} and cannot be redefined")
    slot: dict[str, Any] = {"name": name}
    if rules == "bam-masterdata":
        if _is_vocabulary(cls):
            raise EditError("invalid", f"{_title(target, cls)} is a vocabulary; add terms instead")
        code = _bam_code(_required_text(payload, "code"), "property code")
        fields = _bam_type_fields(schema, payload)
        _check_property_code(schema, code, fields["facts"])
        mandatory = bool(payload.get("mandatory"))
        label = _text(payload, "label")
        if label:
            slot["title"] = label
        kind = "property"
    else:
        kind = _required_text(payload, "kind")
        fields = _nomad_type_fields(schema, kind, payload)
    description = _text(payload, "description")
    if description:
        slot["description"] = description
    slot_uri = _element_id(schema, target, name)
    if slot_uri:
        slot["slot_uri"] = slot_uri
    slot["annotations"] = {"source_declaring_class": target, "source_kind": kind}
    _apply_type_fields(slot, fields)
    if rules == "bam-masterdata":
        if mandatory:
            slot["required"] = True
        source = _json_annotation(slot, "source_annotations") or {}
        source.update({"mandatory": mandatory, "property_code": code})
        if label:
            source["property_label"] = label
        section = _text(payload, "section")
        if section:
            source["section"] = section
        german = _text(payload, "description_de")
        if description:
            source["description"] = f"{description}//{german}" if german else description
        _set_annotation(slot, "source_annotations", _json_text(source))
        _set_annotation(slot, "source_property_code", code)
        _set_annotation(slot, "display_card", "1..1" if mandatory else "0..1")
        if german:
            _set_annotation(slot, "description_de", german)
    elif kind == "quantity":
        _set_annotation(slot, "display_shape", "[]")
    _set_annotation(slot, ADDED, "true")
    cls.setdefault("attributes", {})[name] = slot


def _rename_attribute(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    classes = _classes(schema)
    cls = _class(schema, target)
    old = _required_text(payload, "attribute")
    slot = _declared(schema, target, old)
    new = _identifier(_required_text(payload, "new_name"), "attribute name")
    if new == old:
        raise EditError("invalid", f"{old!r} already has that name")
    if new in (cls.get("attributes") or {}):
        raise EditError("exists", f"{_title(target, cls)} already has {new!r}")
    owner = _inherited_from(classes, target, new)
    if owner is not None:
        raise EditError("inherited", f"{new!r} is inherited from {_title(owner, classes[owner])}")
    renamed = dict(slot, name=new)
    if "slot_uri" in slot:
        renamed["slot_uri"] = _element_id(schema, target, new) or slot["slot_uri"]
    cls["attributes"] = {(new if key == old else key): (renamed if key == old else value)
                         for key, value in cls["attributes"].items()}
    # Keep the attribute's place in the order the source gave.
    for other in classes.values():
        hint = _json_annotation(other, "source_effective_attributes")
        if hint and any(ref.get("name") == old and ref.get("declaring_class_id") == target for ref in hint):
            for ref in hint:
                if ref.get("name") == old and ref.get("declaring_class_id") == target:
                    ref["name"] = new
            _set_annotation(other, "source_effective_attributes", _json_text(hint))


def _remove_attribute(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    cls = _class(schema, target)
    name = _required_text(payload, "attribute")
    _declared(schema, target, name)
    del cls["attributes"][name]
    if not cls["attributes"]:
        del cls["attributes"]


def _set_range(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    slot = _declared(schema, target, _required_text(payload, "attribute"))
    kind = annotation(slot, "source_kind")
    if rules == "bam-masterdata":
        fields = _bam_type_fields(schema, payload)
        code = annotation(slot, "source_property_code")
        if code:
            others = {**schema, "classes": {
                name: {**cls, "attributes": {key: value for key, value in (cls.get("attributes") or {}).items()
                                             if value is not slot}}
                for name, cls in schema["classes"].items()
            }}
            _check_property_code(others, code, fields["facts"])
    else:
        fields = _nomad_type_fields(schema, kind or "quantity", payload)
        if kind == "subsection":
            # The card follows multivalued unless the payload leaves it out.
            if "multivalued" not in payload:
                fields["multivalued"] = bool(slot.get("multivalued"))
                fields["annotations"]["display_card"] = annotation(slot, "display_card")
    _apply_type_fields(slot, fields)


def _description_element(schema: Any, target: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    if payload.get("value") is not None:
        values = schema["enums"][_vocabulary_enum(schema, target)].setdefault("permissible_values", {})
        value = str(payload["value"])
        if value not in values:
            raise EditError("not_found", f"{value!r} is not a value of {target}")
        if values[value] is None:
            values[value] = {}
        return values[value]
    if payload.get("attribute"):
        return _declared(schema, target, str(payload["attribute"]))
    return _class(schema, target)


def _set_description(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    element = _description_element(schema, target, payload)
    description = _text(payload, "description")
    if description:
        element["description"] = description
    else:
        element.pop("description", None)
    if rules == "bam-masterdata" and "description_de" in payload:
        _set_annotation(element, "description_de", _text(payload, "description_de"))


def _set_required(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    slot = _declared(schema, target, _required_text(payload, "attribute"))
    required = payload.get("required")
    if not isinstance(required, bool):
        raise EditError("invalid", "required must be true or false")
    if required:
        slot["required"] = True
    else:
        slot.pop("required", None)
    if annotation(slot, "source_kind") == "property":
        _set_annotation(slot, "display_card", "1..1" if required else "0..1")
        source = _json_annotation(slot, "source_annotations") or {}
        source["mandatory"] = required
        _set_annotation(slot, "source_annotations", _json_text(source))


def _add_enum_value(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    enum_name = _vocabulary_enum(schema, target)
    values = schema["enums"][enum_name].setdefault("permissible_values", {})
    value = _required_text(payload, "value")
    vocabulary = annotation(schema["enums"][enum_name], "source_vocabulary_class") is not None
    if rules == "bam-masterdata" and vocabulary:
        _bam_code(value, "term code")
        if len(value) > BAM_TERM_CODE_LIMIT:
            raise EditError("invalid", f"term code {value} is longer than {BAM_TERM_CODE_LIMIT} characters")
    if value in values:
        raise EditError("exists", f"{value!r} is already a value of {target}")
    for base in schema["enums"][enum_name].get("inherits") or ():
        if value in ((schema["enums"].get(base) or {}).get("permissible_values") or {}):
            raise EditError("inherited", f"{value!r} is inherited from {base}")
    entry: dict[str, Any] = {}
    label = _text(payload, "label")
    if label:
        entry["title"] = label
    description = _text(payload, "description")
    if description:
        entry["description"] = description
    annotations: dict[str, str] = {}
    if rules == "bam-masterdata" and vocabulary:
        python_name = _identifier(_text(payload, "name") or bam_attribute_name(value), "term name")
        taken = {annotation(other or {}, "source_python_name") or code for code, other in values.items()}
        if python_name in taken:
            raise EditError("exists", f"a term named {python_name!r} already exists in {target}")
        annotations["source_python_name"] = python_name
        german = _text(payload, "description_de")
        if german:
            annotations["description_de"] = german
    annotations[ADDED] = "true"
    entry["annotations"] = annotations
    values[value] = entry


def _remove_enum_value(schema: dict[str, Any], target: str, payload: Mapping[str, Any], rules: str) -> None:
    enum_name = _vocabulary_enum(schema, target)
    values = schema["enums"][enum_name].get("permissible_values") or {}
    value = _required_text(payload, "value")
    if value not in values:
        for base in schema["enums"][enum_name].get("inherits") or ():
            if value in ((schema["enums"].get(base) or {}).get("permissible_values") or {}):
                raise EditError("inherited", f"{value!r} is inherited from {base}; remove it there")
        raise EditError("not_found", f"{value!r} is not a value of {target}")
    del values[value]


_HANDLERS = {
    "add_class": _add_class,
    "rename_class": _rename_class,
    "remove_class": _remove_class,
    "add_attribute": _add_attribute,
    "rename_attribute": _rename_attribute,
    "remove_attribute": _remove_attribute,
    "set_range": _set_range,
    "set_description": _set_description,
    "set_required": _set_required,
    "add_enum_value": _add_enum_value,
    "remove_enum_value": _remove_enum_value,
}


def term_value(schema: Mapping[str, Any], target: str, python_name: str) -> str | None:
    """The term code behind a vocabulary term node (named after the term's Python name), or None."""
    try:
        enum_name = _vocabulary_enum(schema, target)
    except EditError:
        return None
    for code, value in ((schema.get("enums") or {})[enum_name].get("permissible_values") or {}).items():
        if (annotation(value or {}, "source_python_name") or code) == python_name:
            return code
    return None


__all__: Sequence[str] = (
    "ADDED", "BAM_DATA_TYPES", "EditError", "NOMAD_DTYPES", "OPS", "RULE_SETS",
    "apply_edit", "apply_edits", "bam_attribute_name", "bam_class_name", "prepare_edit", "rules_summary",
    "term_value",
)
`,g=`"""Graph adapter: a LinkML schema held as plain JSON data to the graph JSON the frontend reads.

Plain data in and out, standard library only, so the same code can run in the
browser. The graph follows the conventions of \`extractor/graph_builder.py\`:

- each class is a \`section\` node; its id is the class name (the source id),
  its label the class title, its doc the class description;
- each attribute a class has in the current schema, declared or inherited
  (the source's attribute list only sets their order), with \`source_kind\`
  \`quantity\` (NOMAD) or \`property\` (bam-masterdata) is a \`quantity\` node owned
  by that class (id \`<class>.<name>\`) with a \`hasQuantity\` edge; with
  \`source_kind\` \`subsection\` it is a \`hasSubSection\` edge to its range;
- a bam-masterdata vocabulary is a class linked to its enum
  (\`source_vocabulary_enum\`); each of its terms, its bases' terms included, is
  a \`quantity\` node with dtype \`VOCAB_TERM\`, named after the term's Python
  attribute (\`source_python_name\`);
- \`dtype\`, \`card\` and \`shape\` are the extractor's display annotations, not
  values derived from LinkML ranges; \`unit\` is the source unit;
- bam-masterdata nodes also carry the openBIS facts the doc panel shows, when
  the source states them: \`code\`, \`title\` (property or term label), \`title_de\`,
  \`doc_de\` (the German half of the description), \`mandatory\`, \`section\`, \`iri\`;
- each class gets an \`inherits\` edge to every ancestor (from \`is_a\` and
  \`mixins\`, in Python's method resolution order), not only to its direct bases;
- the query flags of the graph endpoints are applied here, with the same
  traversal, depth and size limits as the graph builder.

The current schema, edits included, decides which classes exist and what
they hold. The extraction document of the snapshot only supplies what LinkML
does not hold: the order of the classes each module exposes and the names it
binds them to (the starting points and roots of a graph), and the public
methods of each class. A class an edit renamed keeps its source id in the
annotation \`source_class\`, so it keeps its module bindings and methods; a
class an edit added (\`edit_added\`) is a starting point of its own module.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

# Framework base classes (NOMAD metainfo, openBIS entity types) are not part of a schema.
EXCLUDE_PREFIXES = ("nomad.metainfo.", "bam_masterdata.metadata.")
# Attribute kinds shown as quantity nodes: NOMAD quantities and bam-masterdata properties.
QUANTITY_KINDS = ("quantity", "property")
VOCABULARY_TERM_DTYPE = "VOCAB_TERM"
MAX_NODES = 8000
MAX_DEPTH = 20


class RootNotFound(ValueError):
    """The requested root is not a class the module exposes."""


def root_namespace(package: str) -> str:
    """The namespace a module's graph is limited to when cross-module links are off."""
    parts = package.split(".")
    if len(parts) >= 3:
        return ".".join(parts[:3])
    return ".".join(parts)


def annotation(element: Mapping[str, Any], tag: str) -> str | None:
    """An annotation value, whether stored as plain text or as a LinkML \`{tag, value}\` object."""
    value = (element.get("annotations") or {}).get(tag)
    if isinstance(value, Mapping):
        value = value.get("value")
    return None if value is None else str(value)


def _json_annotation(element: Mapping[str, Any], tag: str) -> Any:
    text = annotation(element, tag)
    return None if text is None else json.loads(text)


def class_module(name: str, cls: Mapping[str, Any]) -> str:
    """The Python module of a class: its source id without the class name."""
    title = cls.get("title")
    if title and name.endswith(f".{title}"):
        return name[: -len(title) - 1]
    return name.rpartition(".")[0]


def _mro(name: str, classes: Mapping[str, Mapping[str, Any]], memo: dict[str, list[str]]) -> list[str]:
    """Python's C3 linearization over \`is_a\` + \`mixins\`, limited to classes in the schema."""
    if name in memo:
        return memo[name]
    memo[name] = [name]  # guards against cycles while this class is being linearized
    cls = classes[name]
    bases = [base for base in [cls.get("is_a"), *(cls.get("mixins") or [])] if base and base in classes]
    sequences = [list(_mro(base, classes, memo)) for base in bases] + [list(bases)]
    result = [name]
    while True:
        sequences = [seq for seq in sequences if seq]
        if not sequences:
            break
        for seq in sequences:
            head = seq[0]
            if not any(head in other[1:] for other in sequences):
                break
        else:
            # Not linearizable (cannot happen for real Python classes); keep depth-first order.
            head = sequences[0][0]
        result.append(head)
        for seq in sequences:
            if seq and seq[0] == head:
                del seq[0]
    deduplicated = list(dict.fromkeys(result))
    memo[name] = deduplicated
    return deduplicated


def effective_attributes(
    name: str, classes: Mapping[str, Mapping[str, Any]], memo: dict[str, list[str]],
) -> list[tuple[str, dict[str, Any]]]:
    """(declaring class, attribute) for every attribute a class has, declared or inherited.

    The current schema decides which attributes a class has: its own ones
    override inherited ones along the resolution order, so edits (added,
    removed or moved attributes, changed bases) show up. The source's list
    (\`source_effective_attributes\`) only gives the order of the attributes it
    still names, which is NOMAD's own order; any others follow, base classes
    first and in declaration order.
    """
    collected: dict[str, tuple[str, dict[str, Any]]] = {}
    for ancestor in reversed(_mro(name, classes, memo)):
        for attribute_name, slot in (classes[ancestor].get("attributes") or {}).items():
            collected[attribute_name] = (ancestor, slot)
    hint = _json_annotation(classes[name], "source_effective_attributes") or []
    rank = {ref["name"]: index for index, ref in enumerate(hint)}
    natural = {key: index for index, key in enumerate(collected)}
    ordered = sorted(natural, key=lambda key: (0, rank[key]) if key in rank else (1, natural[key]))
    return [collected[key] for key in ordered]


def vocabulary_terms(
    name: str, schema: Mapping[str, Any], memo: dict[str, list[str]],
) -> list[tuple[str, str, Mapping[str, Any]]]:
    """(Python name, term code, permissible value) of every term of a vocabulary class.

    Terms of base vocabularies come first, as the graph builder collects them;
    a term a class redeclares under the same Python name replaces the base's.
    Empty for a class that is not a vocabulary.
    """
    classes = schema.get("classes") or {}
    enums = schema.get("enums") or {}
    collected: dict[str, tuple[str, Mapping[str, Any]]] = {}
    for ancestor in reversed(_mro(name, classes, memo)):
        enum = enums.get(annotation(classes[ancestor], "source_vocabulary_enum") or "") or {}
        for code, value in (enum.get("permissible_values") or {}).items():
            value = value or {}
            collected[annotation(value, "source_python_name") or code] = (code, value)
    return [(python_name, code, value) for python_name, (code, value) in collected.items()]


def _present(**fields: Any) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value is not None}


def _class_details(cls: Mapping[str, Any]) -> dict[str, Any]:
    """openBIS facts of a bam-masterdata class, each only when stated (none for NOMAD classes).

    A class without its own definition has no code but can still have a
    German description, inherited from its base's definition.
    """
    source = _json_annotation(cls, "source_annotations") or {}
    return _present(code=annotation(cls, "source_entity_code"), iri=source.get("iri"),
                    doc_de=annotation(cls, "description_de"))


def _property_details(slot: Mapping[str, Any]) -> dict[str, Any]:
    """openBIS facts of a bam-masterdata property."""
    source = _json_annotation(slot, "source_annotations") or {}
    return _present(code=annotation(slot, "source_property_code"), title=slot.get("title"),
                    title_de=annotation(slot, "title_de"), doc_de=annotation(slot, "description_de"),
                    mandatory=bool(slot.get("required")), section=source.get("section"), iri=source.get("iri"))


def _term_details(code: str, value: Mapping[str, Any]) -> dict[str, Any]:
    return _present(code=code, title=value.get("title"), title_de=annotation(value, "title_de"),
                    doc_de=annotation(value, "description_de"))


def _methods(record: Mapping[str, Any] | None, base_namespace: str) -> list[str] | None:
    """Public method names implemented under the active base namespace, as the graph builder lists them."""
    names = {
        method["name"] for method in (record or {}).get("methods") or ()
        if base_namespace and method.get("module", "").startswith(base_namespace)
    }
    return sorted(names) or None


def _module_record(extraction: Mapping[str, Any], package: str) -> Mapping[str, Any]:
    for module in extraction.get("modules") or ():
        if module["name"] == package:
            return module
    return {}


def source_class_id(name: str, cls: Mapping[str, Any]) -> str:
    """The id a class has in the extraction document: its own, or the one it had before an edit renamed it."""
    return annotation(cls, "source_class") or name


def _current_names(classes: Mapping[str, Mapping[str, Any]]) -> dict[str, str]:
    """Extraction class id -> current class name, for every class of the schema."""
    current = {name: name for name in classes}
    for name, cls in classes.items():
        original = annotation(cls, "source_class")
        if original:
            # The renamed class answers to its old id, even if a new class took that name.
            current[original] = name
    return current


def entry_points(schema: Mapping[str, Any], extraction: Mapping[str, Any], package: str) -> tuple[list[str], dict[str, str]]:
    """The classes a module's graph starts from, in module order, and the root names it offers (name -> class).

    Both follow the current schema: a removed class is gone, a renamed one is
    offered under its new name (an alias keeps its own name), and a class an
    edit added to this module is offered under its name.
    """
    classes: Mapping[str, Mapping[str, Any]] = schema.get("classes") or {}
    current = _current_names(classes)
    module = _module_record(extraction, package)
    starts: list[str] = []
    offered: dict[str, str] = {}
    for class_id in module.get("classes") or ():
        name = current.get(class_id)
        if name in classes and name not in starts:
            starts.append(name)
    bindings = module.get("names")
    if bindings is None:
        bindings = {class_id.rpartition(".")[2]: class_id for class_id in module.get("classes") or ()}
    for binding, class_id in bindings.items():
        name = current.get(class_id)
        if name not in classes:
            continue
        # The class's own name follows a rename; any other name stays as the module binds it.
        own = binding == class_id.rpartition(".")[2]
        offered[_title(name, classes[name]) if own else binding] = name
    for name, cls in classes.items():
        if annotation(cls, "edit_added") == "true" and class_module(name, cls) == package and name not in starts:
            starts.append(name)
            offered.setdefault(_title(name, cls), name)
    return starts, offered


def _title(name: str, cls: Mapping[str, Any]) -> str:
    return cls.get("title") or name.rpartition(".")[2]


def section_names(schema: Mapping[str, Any], extraction: Mapping[str, Any], package: str) -> list[str]:
    """Names of the classes a module exposes that belong to its namespace: the roots it offers."""
    classes = schema.get("classes") or {}
    namespace = root_namespace(package)
    _, offered = entry_points(schema, extraction, package)
    return sorted(
        root for root, name in offered.items() if class_module(name, classes[name]).startswith(namespace)
    )


def schema_modules(schema: Mapping[str, Any], extraction: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Every module of the document that offers at least one root, as \`{"package", "sections"}\`."""
    found = []
    for module in extraction.get("modules") or ():
        sections = section_names(schema, extraction, module["name"])
        if sections:
            found.append({"package": module["name"], "sections": sections})
    return found


def build_graph(
    schema: Mapping[str, Any],
    extraction: Mapping[str, Any],
    package: str,
    root: str | None = None,
    include_quantities: bool = True,
    include_subsections: bool = True,
    include_inheritance: bool = True,
    allow_cross_module: bool = True,
    base_namespace: str | None = None,
    empty: bool = False,
    *,
    exclude_prefixes: tuple[str, ...] = EXCLUDE_PREFIXES,
    max_nodes: int = MAX_NODES,
    max_depth: int = MAX_DEPTH,
) -> dict[str, Any]:
    """The graph of \`package\`, starting at \`root\` (a class title) or at every class the module exposes."""
    if empty:
        return {"package": package, "root": root, "nodes": [], "edges": []}
    if base_namespace is None:
        base_namespace = root_namespace(package)
    classes: Mapping[str, Mapping[str, Any]] = schema.get("classes") or {}
    records = {record["id"]: record for record in extraction.get("classes") or ()}
    memo: dict[str, list[str]] = {}

    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []
    edge_keys: set[tuple[str, str, str]] = set()
    seen: set[str] = set()

    def allowed(module: str) -> bool:
        if any(module.startswith(prefix) for prefix in exclude_prefixes):
            return False
        return allow_cross_module or module.startswith(base_namespace)

    def add_edge(source: str, target: str, kind: str, card: str | None = None) -> None:
        key = (source, target, kind)
        if key not in edge_keys:
            edge_keys.add(key)
            edges.append({"source": source, "target": target, "type": kind, "card": card})

    def add_section(name: str, depth: int = 0) -> None:
        if depth > max_depth or name in seen:
            return
        seen.add(name)
        cls = classes[name]
        module = class_module(name, cls)
        if not allowed(module):
            return
        nodes[name] = {
            "id": name, "kind": "section", "label": _title(name, cls),
            "doc": cls.get("description"), "module": module, "dtype": None, "shape": None, "card": None,
            "owner": None, "methods": _methods(records.get(source_class_id(name, cls)), base_namespace),
            **_class_details(cls),
        }
        if len(nodes) > max_nodes:
            return

        members = effective_attributes(name, classes, memo)
        if include_quantities:
            for _, slot in members:
                kind = annotation(slot, "source_kind")
                if kind not in QUANTITY_KINDS:
                    continue
                quantity_id = f"{name}.{slot['name']}"
                card = annotation(slot, "display_card")
                if quantity_id not in nodes:
                    nodes[quantity_id] = {
                        "id": quantity_id, "kind": "quantity", "label": slot["name"],
                        "doc": slot.get("description"), "module": module,
                        "dtype": annotation(slot, "display_dtype"), "shape": annotation(slot, "display_shape"),
                        "card": card, "owner": name, "methods": None, "unit": annotation(slot, "source_unit"),
                        **(_property_details(slot) if kind == "property" else {}),
                    }
                add_edge(name, quantity_id, "hasQuantity", card)
                if len(nodes) > max_nodes:
                    return
            for python_name, code, value in vocabulary_terms(name, schema, memo):
                term_id = f"{name}.{python_name}"
                if term_id not in nodes:
                    nodes[term_id] = {
                        "id": term_id, "kind": "quantity", "label": python_name,
                        "doc": value.get("description"), "module": module,
                        "dtype": VOCABULARY_TERM_DTYPE, "shape": None, "card": None, "owner": name,
                        "methods": None, "unit": None, **_term_details(code, value),
                    }
                add_edge(name, term_id, "hasQuantity", None)
                if len(nodes) > max_nodes:
                    return

        if include_inheritance:
            for ancestor in _mro(name, classes, memo)[1:]:
                if not allowed(class_module(ancestor, classes[ancestor])):
                    continue
                add_section(ancestor, depth + 1)
                add_edge(name, ancestor, "inherits")

        if include_subsections:
            for _, slot in members:
                if annotation(slot, "source_kind") != "subsection":
                    continue
                target = slot.get("range")
                if target not in classes or not allowed(class_module(target, classes[target])):
                    continue
                add_section(target, depth + 1)
                add_edge(name, target, "hasSubSection", annotation(slot, "display_card"))
                if len(nodes) > max_nodes:
                    return

    starts, offered = entry_points(schema, extraction, package)
    if root:
        if root not in offered:
            available = ", ".join(sorted(offered)[:25])
            raise RootNotFound(f"Root section '{root}' not found in {package}. Available (first 25): {available}")
        add_section(offered[root], 0)
        # Classes the edits added to this module are drawn too, so new work stays on the canvas.
        for name in starts:
            if annotation(classes[name], "edit_added") == "true":
                add_section(name, 0)
    else:
        for name in starts:
            add_section(name, 0)

    node_list = sorted(nodes.values(), key=lambda node: (node["kind"], node["module"] or "", node["label"]))
    edges.sort(key=lambda edge: (edge["source"], edge["type"], edge["target"]))
    return {
        "package": package,
        "root": root,
        "base_namespace": base_namespace,
        "nodes": node_list,
        "edges": edges,
    }


def usage_entries(extraction: Mapping[str, Any], section_id: str) -> list[dict[str, Any]] | None:
    """Normalizers and helpers acting on a class, as \`/usage\` lists them; None if the class is not in the document."""
    usage = extraction.get("usage") or {}
    if section_id in usage:
        return [
            {"kind": entry["kind"], "qualname": entry["qualname"], "module": entry["module"],
             "short_name": entry["short_name"], "doc": entry.get("doc")}
            for entry in usage[section_id]
        ]
    if any(record["id"] == section_id for record in extraction.get("classes") or ()):
        return []
    return None
`,b=`"""Write a LinkML schema held as plain JSON data as YAML.

Standard library and PyYAML only, so the same code can run in the browser.
Output is deterministic: element fields come in a fixed order, named maps
(classes, attributes, enums, ...) keep the order they were built in, and the
header names the profile, the source commit and the tool versions.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from typing import Any

import yaml

# Field order inside an element (schema, class, slot, enum, ...). Fields not
# listed follow in alphabetical order.
FIELD_ORDER = (
    "id", "name", "text", "title", "description", "version", "license",
    "prefixes", "prefix_prefix", "prefix_reference", "default_prefix", "default_range", "imports",
    "class_uri", "slot_uri", "enum_uri", "is_a", "mixins", "abstract", "tree_root",
    "range", "multivalued", "required", "identifier", "minimum_value", "maximum_value",
    "ucum_code", "unit", "array", "exact_number_dimensions", "dimensions", "alias",
    "exact_cardinality", "minimum_cardinality", "maximum_cardinality",
    "permissible_values", "attributes", "annotations", "enums", "slots", "classes",
)
_RANK = {name: index for index, name in enumerate(FIELD_ORDER)}
# Fields whose value maps a name to an element; their own key order is kept.
NAMED_MAPS = frozenset({"prefixes", "enums", "classes", "slots", "types", "subsets",
                        "attributes", "permissible_values", "annotations"})


def _ordered(value: Any, *, named: bool = False) -> Any:
    if isinstance(value, Mapping):
        if named:
            return {key: _ordered(item) for key, item in value.items()}
        keys = sorted(value, key=lambda key: (_RANK.get(key, len(_RANK)), key))
        return {key: _ordered(value[key], named=key in NAMED_MAPS) for key in keys}
    if isinstance(value, (list, tuple)):
        return [_ordered(item) for item in value]
    return value


class _Dumper(yaml.SafeDumper):
    """Block style for multi-line text, so descriptions stay readable."""


def _represent_str(dumper: yaml.SafeDumper, value: str) -> yaml.Node:
    style = "|" if "\\n" in value else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", value, style=style)


_Dumper.add_representer(str, _represent_str)


def header_lines(
    *,
    profile: str,
    source: Mapping[str, Any],
    tools: Mapping[str, str],
    edited: bool = False,
    report: Sequence[Mapping[str, str]] | None = None,
) -> list[str]:
    name = source.get("name") or profile
    version = source.get("version") or "unknown version"
    commit = source.get("commit") or "unknown commit"
    lines = [
        "LinkML schema exported by schema-studio" + (" (with edits)" if edited else ""),
        f"profile: {profile}",
        f"source: {name} {version}, commit {commit}",
        "tools: " + ", ".join(f"{tool} {tool_version}" for tool, tool_version in sorted(tools.items())),
    ]
    if report is not None:
        lines.append(report_summary(report))
    return lines


def report_summary(report: Sequence[Mapping[str, str]]) -> str:
    """One line saying how much of the source did not convert cleanly."""
    if not report:
        return "conversion report: everything converted"
    counts = Counter(row["status"] for row in report)
    order = ("partial", "skipped", "warning")
    parts = [f"{counts[status]} {status}" for status in order if counts[status]]
    parts += [f"{count} {status}" for status, count in sorted(counts.items()) if status not in order]
    return (
        "conversion report: " + ", ".join(parts)
        + " (partial: not fully expressed in LinkML; the source facts are kept as source_* annotations)"
    )


def dump_yaml(
    schema: Mapping[str, Any],
    *,
    profile: str,
    source: Mapping[str, Any],
    tools: Mapping[str, str],
    edited: bool = False,
    report: Sequence[Mapping[str, str]] | None = None,
) -> str:
    """The schema as YAML text, with a comment header naming its origin and, if given, a report summary."""
    lines = header_lines(profile=profile, source=source, tools=tools, edited=edited, report=report)
    header = "".join(f"# {line}\\n" for line in lines)
    body = yaml.dump(
        # No line folding: one value per line keeps diffs between exports readable.
        _ordered(schema), Dumper=_Dumper, sort_keys=False, allow_unicode=True, width=float("inf"),
        default_flow_style=False,
    )
    return header + body
`;const c="/home/pyodide/schema_core",v={"__init__.py":"","browser.py":f,"core.py":h,"edits.py":y,"graph.py":g,"linkml_yaml.py":b};function A(e,n){e.FS.mkdirTree(c);for(const[r,a]of Object.entries(v))e.FS.writeFile(`${c}/${r}`,a);e.runPython(`
import sys
if "/home/pyodide" not in sys.path:
    sys.path.insert(0, "/home/pyodide")
from schema_core import browser as _schema_studio
`);const t=e.globals.get("_schema_studio"),s=t.has_snapshot,i=t.add_snapshot,u=t.handle;let d=null,l=Promise.resolve();const _=async r=>{for(const a of r.snapshots)s(a)||i(a,await n(a));return r.op==="linkml_yaml"&&(d??=e.loadPackage("pyyaml"),await d),JSON.parse(String(u(JSON.stringify(r))))};return{run(r){const a=l.then(()=>_(r));return l=a.catch(()=>{}),a}}}const m=new URL("/",self.location.origin).href,w=new URL("data/",m).href,p=new URL("pyodide/",m).href;let o=null;async function k(e){const n=await fetch(new URL(e,w));if(!n.ok)throw new Error(`Could not load ${e} (${n.status})`);return n.text()}function E(){return o??=(async()=>{self.postMessage({status:"loading"});const{loadPyodide:e}=await import(`${p}pyodide.mjs`),n=await e({indexURL:p}),t=A(n,k);return self.postMessage({status:"ready"}),t})(),o.catch(()=>{o=null}),o}self.onmessage=async e=>{const{id:n,request:t}=e.data;try{const s=await E();if(!t){self.postMessage({id:n,answer:{ok:null}});return}self.postMessage({id:n,answer:await s.run(t)})}catch(s){const i=s instanceof Error?s.message:String(s);self.postMessage({id:n,answer:{error:`The in-browser schema engine failed: ${i}`,status:500}})}};
