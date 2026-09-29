"""Smart playlists: saved rule sets evaluated against the track cache.

A spec is plain JSON kept in the `smart_playlists` table:

    {"match": "all" | "any",
     "rules": [{"field": "plays", "op": "gte", "value": 5}, ...],
     "order": "most_played", "limit": 50}

Every field/op passes a whitelist below and every value goes into a `?`
parameter — user input never becomes SQL text, so a hostile spec can at
worst match rows it was allowed to match.
"""
from __future__ import annotations

import time
from typing import Any

MAX_RULES = 12
MAX_LIMIT = 500

# field -> (sql expression, kind)
_FIELDS: dict[str, tuple[str, str]] = {
    "plays":       ("play_count", "int"),
    "last_played": ("last_played", "days"),
    "added":       ("added_at", "days"),
    "duration":    ("COALESCE(duration, 0)", "seconds"),
    "artist":      ("artist", "text"),
    "title":       ("title", "text"),
    "source":      ("source", "enum"),
    "offline":     ("file_path", "bool"),
}

_OPS: dict[str, tuple[str, ...]] = {
    "int":     ("gte", "lte", "eq"),
    "days":    ("within", "before", "never"),
    "seconds": ("gte", "lte"),
    "text":    ("contains", "is"),
    "enum":    ("is",),
    "bool":    ("is",),
}

_ENUM_VALUES = {"youtube", "local"}

_ORDERS: dict[str, str] = {
    "most_played":     "play_count DESC, last_played DESC",
    "recently_played": "last_played DESC",
    "recently_added":  "added_at DESC",
    "random":          "RANDOM()",
    "title":           "title COLLATE NOCASE",
    "artist":          "artist COLLATE NOCASE, title COLLATE NOCASE",
}

SOURCES = {"youtube": "from YouTube", "local": "uploaded"}


# ------------------------------------------------------------------ presets

PRESETS: list[dict[str, Any]] = [
    {"key": "most_played", "name": "Most played", "emoji": "icon:zap",
     "spec": {"match": "all", "rules": [],
              "order": "most_played", "limit": 50}},
    {"key": "on_repeat", "name": "On repeat", "emoji": "icon:repeat",
     "spec": {"match": "all", "rules": [{"field": "last_played", "op": "within", "value": 7}],
              "order": "most_played", "limit": 50}},
    {"key": "recently_added", "name": "Recently added", "emoji": "icon:sparkles",
     "spec": {"match": "all", "rules": [{"field": "added", "op": "within", "value": 30}],
              "order": "recently_added", "limit": 50}},
    {"key": "deeper_cuts", "name": "Deeper cuts", "emoji": "icon:disc",
     "spec": {"match": "all", "rules": [{"field": "last_played", "op": "never"}],
              "order": "random", "limit": 50}},
    {"key": "your_uploads", "name": "Your uploads", "emoji": "icon:upload",
     "spec": {"match": "all", "rules": [{"field": "source", "op": "is", "value": "local"}],
              "order": "recently_added", "limit": 100}},
]


# ------------------------------------------------------------------ validation

def validate_spec(spec: dict) -> dict:
    """Normalize + validate a spec dict; raises ValueError with a
    user-presentable message. Returns a clean copy safe to store."""
    if not isinstance(spec, dict):
        raise ValueError("spec must be an object")
    match = spec.get("match", "all")
    if match not in ("all", "any"):
        raise ValueError("match must be 'all' or 'any'")
    rules_in = spec.get("rules", [])
    if not isinstance(rules_in, list):
        raise ValueError("rules must be a list")
    if len(rules_in) > MAX_RULES:
        raise ValueError(f"at most {MAX_RULES} rules")
    rules = []
    for r in rules_in:
        if not isinstance(r, dict):
            raise ValueError("each rule must be an object")
        field = r.get("field")
        if field not in _FIELDS:
            raise ValueError(f"unknown field: {field!r}")
        expr, kind = _FIELDS[field]
        op = r.get("op")
        if op not in _OPS[kind]:
            raise ValueError(f"field {field} cannot use op {op!r}")
        value = r.get("value")
        if op == "never":
            value = None
        elif kind == "int":
            value = _num(value, field)
        elif kind == "seconds":
            value = _num(value, field)
        elif kind == "days":
            value = _num(value, "days")
            if value <= 0:
                raise ValueError("days must be positive")
        elif kind == "enum":
            if value not in _ENUM_VALUES:
                raise ValueError(f"source must be one of {sorted(_ENUM_VALUES)}")
        elif kind == "bool":
            value = bool(value)
        elif kind == "text":
            value = str(value or "").strip()
            if not value:
                raise ValueError("text rule needs a value")
            if len(value) > 200:
                value = value[:200]
        rules.append({"field": field, "op": op, "value": value})
    order = spec.get("order", "most_played")
    if order not in _ORDERS:
        raise ValueError(f"unknown order: {order!r}")
    limit = spec.get("limit", 50)
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        raise ValueError("limit must be a number")
    if not 1 <= limit <= MAX_LIMIT:
        raise ValueError(f"limit must be 1..{MAX_LIMIT}")
    return {"match": match, "rules": rules, "order": order, "limit": limit}


def _num(value, what: str) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} needs a number")
    if v != v or v in (float("inf"), float("-inf")):
        raise ValueError(f"{what} needs a real number")
    return v


# ------------------------------------------------------------------ SQL build

def where_clause(spec: dict) -> tuple[str, list]:
    """WHERE fragment for the rules ('all' = AND, 'any' = OR) + bound args."""
    parts: list[str] = []
    args: list = []
    now = time.time()
    for r in spec["rules"]:
        expr, kind = _FIELDS[r["field"]]
        op, value = r["op"], r["value"]
        if kind == "days":
            if op == "never":
                parts.append(f"{expr} IS NULL")
            elif op == "within":
                parts.append(f"{expr} >= ?")
                args.append(now - value * 86400)
            else:  # before
                parts.append(f"{expr} < ?")
                args.append(now - value * 86400)
        elif op == "gte":
            parts.append(f"{expr} >= ?"); args.append(value)
        elif op == "lte":
            parts.append(f"{expr} <= ?"); args.append(value)
        elif op == "eq":
            parts.append(f"{expr} = ?"); args.append(value)
        elif op == "contains":
            parts.append(f"INSTR(lower({expr}), lower(?)) > 0"); args.append(value)
        elif op == "is" and kind == "text":
            parts.append(f"lower({expr}) = lower(?)"); args.append(value)
        elif op == "is" and kind == "enum":
            parts.append(f"{expr} = ?"); args.append(value)
        elif op == "is" and kind == "bool":
            parts.append(f"{expr} IS {'NOT NULL' if value else 'NULL'}")
    if not parts:
        return "", []
    joiner = " AND " if spec["match"] == "all" else " OR "
    return "(" + joiner.join(parts) + ")", args


# ------------------------------------------------------------------ evaluate

def _query(spec: dict, cfg) -> tuple[str, list]:
    w, args = where_clause(spec)
    sql = "SELECT * FROM tracks"
    if w:
        sql += f" WHERE {w}"
    sql += f" ORDER BY {_ORDERS[spec['order']]} LIMIT ?"
    args.append(spec["limit"])
    return sql, args


def evaluate(spec: dict, cfg=None) -> list[dict]:
    from . import db  # late import avoids a circular import at module load
    sql, args = _query(validate_spec(spec), cfg)
    return db.query_rows(sql, args, cfg)


def evaluate_count(spec: dict, cfg=None) -> dict:
    from . import db
    w, args = where_clause(validate_spec(spec))
    sql = "SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(duration,0)),0) AS secs FROM tracks"
    if w:
        sql += f" WHERE {w}"
    rows = db.query_rows(sql, args, cfg)
    return {"count": int(rows[0]["n"]), "seconds": int(rows[0]["secs"] or 0)}


def describe(spec: dict) -> str:
    """Human-readable rule summary, e.g.
    'plays ≥ 5 and last played within 7 days · most played · 50 max'."""
    parts = []
    for r in spec["rules"]:
        field, op, value = r["field"], r["op"], r["value"]
        if op == "never":
            parts.append(f"{_LABEL[field]} never played")
        elif op == "within":
            parts.append(f"{_LABEL[field]} within {int(value)} days")
        elif op == "before":
            parts.append(f"{_LABEL[field]} older than {int(value)} days")
        elif op == "gte":
            parts.append(f"{_LABEL[field]} ≥ {_fmt_num(field, value)}")
        elif op == "lte":
            parts.append(f"{_LABEL[field]} ≤ {_fmt_num(field, value)}")
        elif op == "eq":
            parts.append(f"{_LABEL[field]} = {_fmt_num(field, value)}")
        elif op == "contains":
            parts.append(f"{_LABEL[field]} contains “{value}”")
        elif op == "is":
            if r["field"] == "source":
                parts.append(SOURCES.get(value, value))
            elif r["field"] == "offline":
                parts.append("downloaded" if value else "not downloaded")
            else:
                parts.append(f"{_LABEL[field]} is “{value}”")
    joiner = " and " if spec["match"] == "all" else " or "
    body = joiner.join(parts) if parts else "all tracks"
    order = spec["order"].replace("_", " ")
    return f"{body} · {order} · {spec['limit']} max"


_LABEL = {
    "plays": "plays", "last_played": "last played", "added": "added",
    "duration": "length", "artist": "artist", "title": "title",
    "source": "source", "offline": "downloaded",
}


def _fmt_num(field: str, value: float) -> str:
    if field == "duration":
        m = int(value // 60)
        s = int(value % 60)
        return f"{m}:{s:02d}"
    return str(int(value)) if float(value).is_integer() else str(value)
