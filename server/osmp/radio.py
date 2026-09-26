"""OSMP Radio — seeded playlist generation without any API key.

Algorithm:
1. Seed resolution: an 11-char video id seeds directly; free text is searched on
   YouTube and the top results become seeds.
2. Expansion: each seed's YouTube "Mix/Radio" playlist (RD...) is fetched — that
   is YouTube's own recommendation graph — plus an artist/query search to widen
   the pool. Hop-2 mixes from the best hop-1 candidates deepen it.
3. Filtering: drop lives/unknown-duration, too-short/too-long items, duplicates
   (normalized title key), and the seeds themselves.
4. Shaping: relevance score (hop distance + position in mix), artist spread
   (max 2 per channel inside a sliding window of 8 picks), and a deterministic
   banded shuffle so the same seed gives a stable-but-varied result.
"""
from __future__ import annotations

import logging
import random
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from . import youtube
from .youtube import TrackUnavailable

log = logging.getLogger("osmp.radio")

MIN_DURATION = 60.0        # skip intros/shorts below 1 min
MAX_DURATION = 15 * 60.0   # skip hour-long "mixes" above 15 min
WINDOW = 8                 # artist-spread sliding window
MAX_PER_WINDOW = 2

_JUNK_RE = re.compile(
    r"\b(official\s+)?(music\s+)?(video|audio|clip|visualizer|lyric(s)?(\s+video)?|"
    r"hd|hq|remaster(ed)?(\s+\d{4})?|explicit|clean|cover|slowed|reverb|sped up|"
    r"live|session|take\s+\d+)\b", re.I)
_NONWORD_RE = re.compile(r"[^a-z0-9]+")


def norm_title(title: str, artist: str) -> str:
    """Dedupe key: strip parentheticals, junk words, punctuation."""
    t = re.sub(r"[\(\[].*?[\)\]]", " ", title or "")
    t = _JUNK_RE.sub(" ", t)
    t = _NONWORD_RE.sub("", t.lower())
    a = _NONWORD_RE.sub("", (artist or "").lower())
    return (t[:48] + "|" + a[:12])


class _Pool:
    """Candidate pool with best-score-wins merging."""

    def __init__(self):
        self.items: dict[str, dict] = {}
        self.lock = threading.Lock()

    def add_many(self, tracks: list[dict], score: float, origin: str):
        with self.lock:
            for t in tracks:
                if t.get("live"):
                    continue
                dur = t.get("duration")
                if dur is not None and not (MIN_DURATION <= dur <= MAX_DURATION):
                    continue
                prev = self.items.get(t["id"])
                if prev is None:
                    t = dict(t)
                    t["_score"] = score
                    t["_origin"] = origin
                    self.items[t["id"]] = t
                elif score > prev["_score"]:
                    prev["_score"] = score
                    prev["_origin"] = origin


def _mix_scores(n: int) -> list[float]:
    """Position bonus inside a mix: earlier = more strongly related."""
    return [1.0 - 0.4 * (i / max(n - 1, 1)) for i in range(n)]


def generate(seed: str, count: int = 25) -> dict:
    """Generate a radio playlist. Returns {seed, seed_type, tracks}."""
    seed = (seed or "").strip()
    if not seed:
        raise ValueError("seed is required")
    count = max(5, min(int(count), 100))

    seed_is_id = youtube.is_video_id(seed)
    pool = _Pool()
    seed_ids: set[str] = set()
    seed_meta: dict | None = None

    # --- 1. resolve seeds -------------------------------------------------
    primary_seeds: list[str] = []
    if seed_is_id:
        try:
            seed_meta = youtube.get_metadata(seed)
        except (TrackUnavailable, youtube.ResolveError) as exc:
            log.info("seed metadata failed (%s), continuing with mix only", exc)
        primary_seeds = [seed]
        seed_ids.add(seed)
        seed_label = (seed_meta or {}).get("title", seed)
        seed_artist = (seed_meta or {}).get("artist")
    else:
        results = youtube.search(seed, limit=6)
        if not results:
            raise youtube.ResolveError(f"no YouTube results for seed '{seed}'")
        # top 3 search hits seed the graph
        primary_seeds = [r["id"] for r in results[:3]]
        seed_ids.update(primary_seeds)
        seed_label = seed
        seed_artist = results[0].get("artist")

    # --- 2. expand: hop-1 mixes (parallel) + query/artist searches ----------
    def fetch_mix(vid: str, score: float):
        entries = youtube.related_mix(vid, limit=40)
        scored = []
        for t, pos_bonus in zip(entries, _mix_scores(len(entries))):
            t = dict(t)
            t["_score"] = score * (0.6 + 0.4 * pos_bonus)
            scored.append(t)
        return scored

    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(fetch_mix, vid, 1.0) for vid in primary_seeds]
        search_queries = [f"{seed} playlist"] if not seed_is_id else []
        if seed_artist and seed_artist != "Unknown artist":
            search_queries.append(f"{seed_artist} songs")
        for q in search_queries:
            futures.append(ex.submit(_safe_search, q, 0.85))
        hop1: list[dict] = []
        for fut in futures:
            try:
                hop1.extend(fut.result())
            except Exception as exc:  # noqa: BLE001
                log.warning("expansion task failed: %s", str(exc)[:120])

    for t in hop1:
        t = dict(t)
        score = t.pop("_score", 0.8)
        pool.add_many([t], score, t.get("id", ""))

    # --- hop 2: mixes of the three strongest hop-1 candidates --------------
    with pool.lock:
        ranked = sorted((t for t in pool.items.values() if t["id"] not in seed_ids),
                        key=lambda t: t["_score"], reverse=True)
    hop2_seeds = [t["id"] for t in ranked[:3]]
    if hop2_seeds:
        with ThreadPoolExecutor(max_workers=3) as ex:
            futs = [ex.submit(fetch_mix, vid, 0.72) for vid in hop2_seeds]
            for fut in futs:
                try:
                    for t in fut.result():
                        t = dict(t)
                        score = t.pop("_score", 0.6)
                        pool.add_many([t], score, t.get("id", ""))
                except Exception as exc:  # noqa: BLE001
                    log.warning("hop2 failed: %s", str(exc)[:120])

    # --- 3. filter ------------------------------------------------------------
    with pool.lock:
        candidates = [t for t in pool.items.values() if t["id"] not in seed_ids]
    seen_keys: set[str] = set()
    unique: list[dict] = []
    for t in sorted(candidates, key=lambda t: t["_score"], reverse=True):
        key = norm_title(t["title"], t["artist"])
        if key in seen_keys:
            continue
        seen_keys.add(key)
        unique.append(t)

    if len(unique) < count:
        # widen with another search round so short mixes still fill the request
        try:
            extra = youtube.search(f"{seed_label} music", limit=min(25, count * 2))
            for t in extra:
                if t["id"] in seed_ids or t.get("live"):
                    continue
                dur = t.get("duration")
                if dur is not None and not (MIN_DURATION <= dur <= MAX_DURATION):
                    continue
                key = norm_title(t["title"], t["artist"])
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                t = dict(t); t["_score"] = 0.55; t["_origin"] = t["id"]
                unique.append(t)
        except Exception as exc:  # noqa: BLE001
            log.warning("widening search failed: %s", str(exc)[:120])

    # --- 4. shape: artist spread + deterministic banded shuffle ---------------
    rng = random.Random(f"osmp:{seed.lower()}")
    for t in unique:
        # jitter keeps repeated generations from being identical while preserving rank
        t["_score"] += rng.uniform(0, 0.12)
    unique.sort(key=lambda t: t["_score"], reverse=True)

    chosen: list[dict] = []
    artist_window: list[str] = []
    deferred: list[dict] = []
    for t in unique:
        if len(chosen) >= count:
            break
        artist = (t.get("artist") or "").strip().lower()
        recent = artist_window[-WINDOW:]
        if artist and recent.count(artist) >= MAX_PER_WINDOW:
            deferred.append(t)
            continue
        chosen.append(t)
        artist_window.append(artist)
    # fill any remaining slots from deferred, then leftovers
    for t in deferred:
        if len(chosen) >= count:
            break
        chosen.append(t)

    # strong opening: best 3 scores first, then a shuffle-weighted interleave
    head, tail = chosen[:3], chosen[3:]
    rng.shuffle(tail)
    ordered = head + tail

    for t in ordered:
        t.pop("_score", None)
        t.pop("_origin", None)
        t.pop("live", None)
        t["file_path"] = None  # client fills from library state

    return {
        "seed": seed_label,
        "seed_type": "track" if seed_is_id else "query",
        "seed_ids": sorted(seed_ids),
        "count": len(ordered),
        "tracks": ordered,
    }


def _safe_search(q: str, score: float) -> list[dict]:
    try:
        results = youtube.search(q, limit=15)
    except Exception as exc:  # noqa: BLE001
        log.warning("radio search '%s' failed: %s", q, str(exc)[:120])
        return []
    for t in results:
        t["_score"] = score
    return results
