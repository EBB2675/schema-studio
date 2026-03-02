from extractor.graph_builder import _module_allowed


def test_module_allowed_blocks_excluded_prefixes():
    assert not _module_allowed(
        module="nomad.metainfo.something",
        base_namespace="pkg.schema",
        exclude_prefixes=("nomad.metainfo.",),
        allow_cross_module=True,
    )


def test_module_allowed_restricts_to_base_namespace_when_cross_module_disabled():
    assert _module_allowed(
        module="pkg.schema.model",
        base_namespace="pkg.schema",
        exclude_prefixes=(),
        allow_cross_module=False,
    )
    assert not _module_allowed(
        module="other.schema.model",
        base_namespace="pkg.schema",
        exclude_prefixes=(),
        allow_cross_module=False,
    )


def test_module_allowed_accepts_other_namespaces_when_cross_module_enabled():
    assert _module_allowed(
        module="other.schema.model",
        base_namespace="pkg.schema",
        exclude_prefixes=(),
        allow_cross_module=True,
    )
