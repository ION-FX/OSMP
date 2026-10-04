"""Optional LLM curator — works with any OpenAI-compatible chat API
(OpenAI, OpenRouter, Groq, LM Studio, Ollama...). Given a natural-language
prompt it returns a tracklist; we resolve each pick on YouTube.

Settings (server-side, via /api/settings):
  llm_base_url  e.g. https://api.openai.com/v1  or  http://localhost:11434/v1
  llm_api_key   (may be empty for local servers)
  llm_model     e.g. gpt-4o-mini, llama3.1
"""
from __future__ import annotations

import json
import logging
import re
from concurrent.futures import ThreadPoolExecutor

import httpx

from . import db, youtube

log = logging.getLogger("osmp.llm")

SYSTEM_PROMPT = """You are OSMP Radio, a music curator for a YouTube-backed player.
Given the user's request, design a tracklist of real, well-known recordings that
fit it. Rules:
- Respond with ONLY a JSON object, no prose, no markdown fences:
  {"title": "<short playlist title>", "notes": "<2-3 sentence vibe description>",
   "tracks": [{"query": "<artist> - <track>"}]}
- Exactly {count} tracks unless the request implies fewer.
- Prefer queries in "Artist - Title" form; pick songs that actually exist.
- Vary artists: at most 2 tracks per artist.
- Match the requested mood/genre/era; if the user names a seed artist or song,
  build around it."""


class LLMNotConfigured(Exception):
    pass


class LLMError(Exception):
    pass


def is_configured() -> bool:
    s = db.all_settings()
    return bool((s.get("llm_base_url") or "").strip())


def _settings() -> tuple[str, str, str]:
    s = db.all_settings()
    base = (s.get("llm_base_url") or "").strip().rstrip("/")
    key = (s.get("llm_api_key") or "").strip()
    model = (s.get("llm_model") or "").strip() or "gpt-4o-mini"
    if not base:
        raise LLMNotConfigured("No LLM configured. Set base URL (and key/model) in Settings.")
    return base, key, model


def _extract_json(text: str) -> dict:
    """Models love wrapping JSON in fences or chatter — dig it out robustly."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise LLMError(f"LLM returned no JSON object: {text[:160]!r}")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as exc:
        raise LLMError(f"LLM returned malformed JSON: {exc}") from exc


def curate(prompt: str, count: int = 20, timeout: float = 90.0) -> dict:
    """Ask the LLM for a tracklist, resolve each pick on YouTube.

    Returns {title, notes, tracks:[...], unresolved:[...]}.
    """
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    count = max(3, min(int(count), 50))
    base, key, model = _settings()

    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT.replace("{count}", str(count))},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.9,
    }
    try:
        r = httpx.post(f"{base}/chat/completions", json=payload, headers=headers,
                       timeout=timeout)
    except httpx.HTTPError as exc:
        raise LLMError(f"LLM request failed: {exc}") from exc
    if r.status_code != 200:
        raise LLMError(f"LLM API error {r.status_code}: {r.text[:200]}")
    try:
        content = r.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, ValueError) as exc:
        raise LLMError("Unexpected LLM response shape") from exc

    data = _extract_json(content)
    picks = data.get("tracks") or []
    if not isinstance(picks, list) or not picks:
        raise LLMError("LLM returned an empty tracklist")

    def resolve(pick) -> dict | None:
        q = pick.get("query") if isinstance(pick, dict) else str(pick)
        if not q:
            return None
        try:
            results = youtube.search(str(q), limit=1)
        except youtube.ResolveError as exc:
            log.info("resolve '%s' failed: %s", q, exc)
            return None
        if not results:
            return None
        t = results[0]
        t["resolved_from"] = str(q)
        return t

    with ThreadPoolExecutor(max_workers=4) as ex:
        resolved = list(ex.map(resolve, picks[:count]))

    tracks, seen, unresolved = [], set(), []
    for pick, t in zip(picks[:count], resolved):
        q = pick.get("query") if isinstance(pick, dict) else str(pick)
        if t is None:
            unresolved.append(q)
            continue
        if t["id"] in seen:
            unresolved.append(q)
            continue
        seen.add(t["id"])
        tracks.append(t)

    if not tracks:
        raise LLMError("None of the LLM's picks could be resolved on YouTube")

    return {
        "title": (data.get("title") or "LLM Mix").strip()[:80],
        "notes": (data.get("notes") or "").strip()[:600],
        "model": model,
        "count": len(tracks),
        "tracks": tracks,
        "unresolved": unresolved,
    }
