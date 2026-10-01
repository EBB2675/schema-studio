"""Conversion of extraction documents into LinkML schemas, kept as plain JSON data.

This is the only part of the app that uses `linkml-runtime` (to check the
result); the graph adapter and the YAML export work on the plain data.
"""
from .common import Conversion, ConversionError
from .nomad import NOMAD_PREFIXES, convert_nomad

__all__ = ["Conversion", "ConversionError", "NOMAD_PREFIXES", "convert_nomad"]
