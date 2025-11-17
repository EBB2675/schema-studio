from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, List, Tuple
import functools
import importlib
import inspect
import logging

logger = logging.getLogger(__name__)

UsageKind = Literal["normalize_method", "normalize_function", "utility_function"]


@dataclass(frozen=True)
class UsageEntry:
    """
    Describes one "under the hood" code path that acts on a given section.

    kind
        "normalize_method"   -> section.normalize(...)
        "normalize_function" -> module-level helper acting on the section
        "utility_function"   -> reserved for future heuristics
    qualname
        Fully-qualified Python name of the callable.
    module
        Module name containing the callable.
    short_name
        Simple function/method name, e.g. "normalize" or "normalize_dft".
    doc
        Short first-paragraph summary of the callable's docstring, if available.
    """
    kind: UsageKind
    qualname: str
    module: str
    short_name: str
    doc: Optional[str] = None


def _short_doc(obj: object, max_len: int = 280) -> Optional[str]:
    """
    Return a compact first-paragraph summary of an object's docstring.

    - Takes all lines up to the first blank line.
    - Collapses whitespace to single spaces.
    - Truncates to `max_len` characters with an ellipsis if needed.
    """
    try:
        raw = inspect.getdoc(obj) or ""
    except Exception:
        return None

    raw = raw.strip()
    if not raw:
        return None

    lines = raw.splitlines()
    para_lines: list[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            # stop at first blank line
            break
        para_lines.append(line)

    if not para_lines:
        return None

    text = " ".join(para_lines)
    if len(text) > max_len:
        text = text[: max_len - 1].rstrip() + "…"
    return text or None


def _resolve_section_class(section_qualname: str):
    """
    Resolve "package.module.ClassName" into the class object.

    Returns None if import or lookup fails.
    """
    module_name, sep, class_name = section_qualname.rpartition(".")
    if not sep:
        logger.debug("Section qualname %r has no module component", section_qualname)
        return None

    try:
        module = importlib.import_module(module_name)
    except Exception:
        logger.debug(
            "Could not import module %s for section %s",
            module_name,
            section_qualname,
            exc_info=True,
        )
        return None

    cls = getattr(module, class_name, None)
    if not inspect.isclass(cls):
        logger.debug(
            "Attribute %s in module %s is not a class (section %s)",
            class_name,
            module_name,
            section_qualname,
        )
        return None

    return cls


def _usage_from_normalize_method(cls) -> List[UsageEntry]:
    """
    Discover a normalize() method on the section class itself.
    """
    entries: List[UsageEntry] = []

    normalize = getattr(cls, "normalize", None)
    if normalize is None:
        return entries

    # For bound/unbound methods we want the underlying function-like object.
    if inspect.ismethod(normalize) or inspect.isfunction(normalize):
        func = normalize
    else:
        func = getattr(cls, "normalize", None)
        if not (inspect.ismethod(func) or inspect.isfunction(func)):
            return entries

    module_name = getattr(func, "__module__", cls.__module__)
    qualname = f"{module_name}.{cls.__name__}.normalize"

    entries.append(
        UsageEntry(
            kind="normalize_method",
            qualname=qualname,
            module=module_name,
            short_name="normalize",
            doc=_short_doc(func),
        )
    )
    return entries


def _usage_from_module_normalize_functions(cls) -> List[UsageEntry]:
    """
    Discover module-level helpers that appear to normalize this section.

    Heuristic:
      - we look in the *same module* as the section class
      - function name must contain "normalize"
      - function name must also contain the class name (case-insensitive)
        somewhere, not necessarily directly after "normalize_"

    Examples that will be picked up for DFT:
      * normalize_dft
      * normalize_dft_section
      * section_normalize_dft
      * normalize_modelmethod_dft
    """
    entries: List[UsageEntry] = []

    module_name = cls.__module__
    try:
        module = importlib.import_module(module_name)
    except Exception:
        logger.debug(
            "Could not import module %s while scanning normalize helpers for %s",
            module_name,
            cls,
            exc_info=True,
        )
        return entries

    cls_name_lower = cls.__name__.lower()

    for name, obj in inspect.getmembers(module, inspect.isfunction):
        n_lower = name.lower()

        # must look like some kind of normalizer for this class
        if "normalize" not in n_lower:
            continue
        if cls_name_lower not in n_lower:
            continue

        qualname = f"{module.__name__}.{name}"
        entries.append(
            UsageEntry(
                kind="normalize_function",
                qualname=qualname,
                module=module.__name__,
                short_name=name,
                doc=_short_doc(obj),
            )
        )

    return entries


def _usage_from_utility_functions(cls) -> List[UsageEntry]:
    """
    Placeholder for future heuristics for "utility_function" entries.

    For now, we return an empty list. Later, this could be extended to scan
    selected utility modules and look for type-hints or isinstance checks
    involving `cls`.
    """
    return []


@functools.lru_cache(maxsize=1024)
def get_usage_for_section(section_qualname: str) -> Tuple[UsageEntry, ...]:
    """
    Main entry point: return a tuple of UsageEntry objects for a given section.

    Parameters
    ----------
    section_qualname
        Fully-qualified section class name, e.g.
        "nomad_simulations.schema_packages.model_method.DFT".

    Returns
    -------
    tuple[UsageEntry, ...]
        Possibly empty. Normalization methods/helpers come first, followed
        by any utility functions (once implemented).
    """
    cls = _resolve_section_class(section_qualname)
    if cls is None:
        return tuple()

    entries: List[UsageEntry] = []
    entries.extend(_usage_from_normalize_method(cls))
    entries.extend(_usage_from_module_normalize_functions(cls))
    entries.extend(_usage_from_utility_functions(cls))

    # Stable sort: normalize_method → normalize_function → utility_function
    kind_order = {
        "normalize_method": 0,
        "normalize_function": 1,
        "utility_function": 2,
    }

    entries.sort(key=lambda e: (kind_order.get(e.kind, 99), e.short_name))

    return tuple(entries)


__all__ = ["UsageEntry", "UsageKind", "get_usage_for_section"]
