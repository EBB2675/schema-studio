"""Conversion of extraction documents into LinkML schemas, kept as plain JSON data.

This is the only part of the app that uses `linkml-runtime` (to check the
result); the graph adapter and the YAML export work on the plain data.
"""
from typing import Any

from .bam import BAM_PREFIX, BAM_SOURCE, convert_bam
from .common import Conversion, ConversionError
from .nomad import NOMAD_PREFIXES, convert_nomad


def convert(document: dict[str, Any], *, prefix: str | None = None) -> Conversion:
    """Convert an extraction document with the converter of its source."""
    if document.get("source", {}).get("name") == BAM_SOURCE:
        return convert_bam(document, prefix=prefix)
    return convert_nomad(document, prefix=prefix)


__all__ = [
    "BAM_PREFIX", "Conversion", "ConversionError", "NOMAD_PREFIXES", "convert", "convert_bam", "convert_nomad",
]
