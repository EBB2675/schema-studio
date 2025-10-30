from __future__ import annotations
from typing import Dict, Any, Tuple, Set

def index_graph(graph: Dict[str, Any]) -> Tuple[Dict[str, Dict], Set[Tuple[str,str,str]]]:
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    edges = set((e["source"], e["target"], e.get("type","")) for e in graph.get("edges", []))
    return nodes, edges

def diff_graphs(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    an, ae = index_graph(a)
    bn, be = index_graph(b)

    added_nodes   = [bn[k] for k in (set(bn) - set(an))]
    removed_nodes = [an[k] for k in (set(an) - set(bn))]

    common = set(an) & set(bn)
    changed_nodes = []
    for k in common:
        # Compare minimal label fields (tweak as you like)
        av = {x: an[k].get(x) for x in ("label", "module", "kind")}
        bv = {x: bn[k].get(x) for x in ("label", "module", "kind")}
        if av != bv:
            changed_nodes.append({"id": k, "before": an[k], "after": bn[k]})

    added_edges   = [{"source": s, "target": t, "type": ty} for (s,t,ty) in (be - ae)]
    removed_edges = [{"source": s, "target": t, "type": ty} for (s,t,ty) in (ae - be)]

    return {
        "nodes": {
            "added": added_nodes,
            "removed": removed_nodes,
            "changed": changed_nodes
        },
        "edges": {
            "added": added_edges,
            "removed": removed_edges
        }
    }
