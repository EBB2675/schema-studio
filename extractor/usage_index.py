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
        "normalize_function" -> module-level helper likely acting on the section
        "utility_function"   -> helpers actually called inside normalize()
    qualname
        Fully-qualified Python name of the callable.
    module
        Module name containing the callable.
    short_name
        Simple function/method name, e.g. "normalize" or "resolve_chemical_symbol".
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
    Return a compact first-sentence summary of an object's docstring.

    - Takes all lines up to the first blank line.
    - Collapses whitespace to single spaces.
    - Cuts at the end of the first sentence if possible.
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

    # Keep only the first sentence if possible!!!
    dot_pos = text.find(". ")
    if dot_pos != -1:
        text = text[: dot_pos + 1]

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


def _get_normalize_callable(cls):
    """
    Return the underlying normalize function or method for a section class.

    Returns None if no suitable normalize callable is found.
    """
    normalize = getattr(cls, "normalize", None)
    if normalize is None:
        return None

    if inspect.ismethod(normalize) or inspect.isfunction(normalize):
        return normalize

    func = getattr(cls, "normalize", None)
    if inspect.ismethod(func) or inspect.isfunction(func):
        return func

    return None


def _usage_from_normalize_method(cls) -> List[UsageEntry]:
    """
    Discover a normalize() method on the section class itself.
    """
    entries: List[UsageEntry] = []

    func = _get_normalize_callable(cls)
    if func is None:
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


def _helpers_from_normalize_source(cls, func) -> List[object]:
    """
    Heuristic: inspect the source of `cls.normalize` and look for usages
    of methods on the same class and functions in the same module.

    We look for patterns like:
      - ".helper_name("
      - "helper_name("

    and only keep callables.
    """
    try:
        source = inspect.getsource(func)
    except OSError:
        # Builtins, C-extensions, dynamically created functions, etc.
        return []

    helpers: set[object] = set()

    # 1) methods on the same class, e.g. self.resolve_chemical_symbol(...)
    for name, obj in inspect.getmembers(cls):
        if name == "normalize":
            continue
        if name.startswith("__"):
            # skip dunder methods
            continue
        if not callable(obj):
            continue

        # Look for ".name(" to catch self.name(...) or other.attr.name(...)
        needle = f".{name}("
        if needle in source:
            helpers.add(obj)

    # 2) functions from the same module, e.g. normalize_atoms_state(...)
    try:
        module = importlib.import_module(cls.__module__)
    except Exception:
        module = None

    if module is not None:
        for name, obj in inspect.getmembers(module, inspect.isfunction):
            if name == "normalize":
                continue

            # Either bare call "name(" or attribute call ".name("
            if f"{name}(" in source or f".{name}(" in source:
                helpers.add(obj)

    return list(helpers)


def _usage_from_utility_functions(cls) -> List[UsageEntry]:
    """
    Utility functions that are actually used inside cls.normalize().

    This includes:
      - methods on the same class (self.helper_method)
      - module level functions in the same module
    """
    entries: List[UsageEntry] = []

    func = _get_normalize_callable(cls)
    if func is None:
        return entries

    for helper in _helpers_from_normalize_source(cls, func):
        name = getattr(helper, "__name__", repr(helper))
        module_name = getattr(helper, "__module__", cls.__module__)
        qualname = f"{module_name}.{getattr(helper, '__qualname__', name)}"

        entries.append(
            UsageEntry(
                kind="utility_function",
                qualname=qualname,
                module=module_name,
                short_name=name,
                doc=_short_doc(helper),
            )
        )

    return entries


@functools.lru_cache(maxsize=1024)
def get_usage_for_section(section_qualname: str) -> Tuple[UsageEntry, ...]:
    """
    Main entry point: return a tuple of UsageEntry objects for a given section.

    Parameters
    ----------
    section_qualname
        Fully-qualified section class name, e.g.
        "nomad_simulations.schema_packages.model_method.ModelMethod".

    Returns
    -------
    tuple[UsageEntry, ...]
        Possibly empty. Normalization methods/helpers come first, followed
        by any utility functions.
    """
    cls = _resolve_section_class(section_qualname)
    if cls is None:
        return tuple()

    entries: List[UsageEntry] = []
    entries.extend(_usage_from_normalize_method(cls))
    entries.extend(_usage_from_module_normalize_functions(cls))
    entries.extend(_usage_from_utility_functions(cls))

    # Stable sort: normalize_method -> normalize_function -> utility_function
    kind_order = {
        "normalize_method": 0,
        "normalize_function": 1,
        "utility_function": 2,
    }

    entries.sort(key=lambda e: (kind_order.get(e.kind, 99), e.short_name))

    return tuple(entries)


__all__ = ["UsageEntry", "UsageKind", "get_usage_for_section"]