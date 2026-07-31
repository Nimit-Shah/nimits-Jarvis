"""
Mnemosyne HTTP sidecar for TrustClaw.
Runs on localhost:3999. Called by TrustClaw's memory tools.

Architecture:
  - memory store: Mnemosyne BeamMemory (SQLite + FTS5 + hybrid vector search)
  - AI profile store: a separate SQLite table for structured personal facts
  - Profile classification: regex + keyword-rule DSA pipeline that identifies
    personal information (name, email, phone, LinkedIn, preferences, job, etc.)
    and upserts it into the profile table.
"""

from __future__ import annotations

import os
import re
import sqlite3
import logging
from contextlib import asynccontextmanager
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger("mnemosyne_bridge")

# ── Config from environment ────────────────────────────────────────────────────
DATA_DIR = os.environ.get(
    "MNEMOSYNE_DATA_DIR",
    os.path.join(os.path.dirname(__file__), "..", ".mnemosyne", "data"),
)
RECENCY_HALFLIFE = float(os.environ.get("MNEMOSYNE_RECENCY_HALFLIFE", "168"))
PROFILE_DB_PATH = os.path.join(DATA_DIR, "ai_profile.db")

os.makedirs(DATA_DIR, exist_ok=True)

# ── Mnemosyne setup ────────────────────────────────────────────────────────────
try:
    from mnemosyne import remember as mn_remember, recall as mn_recall
    from mnemosyne.core.beam import BeamMemory
    HAS_MNEMOSYNE = True
except ImportError:
    logger.warning(
        "mnemosyne-memory not installed. Run: pip install 'mnemosyne-memory[embeddings]'. "
        "Memory storage will be partially degraded."
    )
    HAS_MNEMOSYNE = False

_beam: Optional["BeamMemory"] = None


def get_beam() -> Optional["BeamMemory"]:
    global _beam
    if HAS_MNEMOSYNE and _beam is None:
        _beam = BeamMemory(session_id="jarvis_main")
    return _beam


# ── AI Profile SQLite Store ────────────────────────────────────────────────────
def _get_profile_db() -> sqlite3.Connection:
    conn = sqlite3.connect(PROFILE_DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ai_profile (
            key TEXT NOT NULL,
            category TEXT NOT NULL,
            label TEXT NOT NULL,
            value TEXT NOT NULL,
            importance REAL NOT NULL DEFAULT 0.9,
            source_memory TEXT,
            instance_id TEXT DEFAULT 'default',
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (key, instance_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profile_category ON ai_profile(category)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_profile_instance ON ai_profile(instance_id)")
    conn.commit()
    
    # Migrate existing data: add instance_id column if missing (for existing DBs)
    try:
        conn.execute("SELECT instance_id FROM ai_profile LIMIT 1")
    except sqlite3.OperationalError:
        # Column doesn't exist, add it and migrate existing data
        conn.execute("ALTER TABLE ai_profile ADD COLUMN instance_id TEXT DEFAULT 'default'")
        conn.commit()
    
    return conn


# ── Personal Profile Classifier (DSA) ─────────────────────────────────────────
#
# Design: Multi-pass rule pipeline.
#   Pass 1: Named-entity regex for structured values (email, phone, URL, URN)
#   Pass 2: Keyword-anchored context extraction for semantic facts
#   Pass 3: Importance scoring based on category weight table
#
# This runs in-process and is intentionally lightweight — no LLM call.
# Each pattern is a (key_template, category, label_template, pattern) tuple.
# The key_template is used to construct a unique dedup key for upsert.

CATEGORY_EMAIL = "contact"
CATEGORY_PHONE = "contact"
CATEGORY_LINKEDIN = "contact"
CATEGORY_SOCIAL = "contact"
CATEGORY_NAME = "identity"
CATEGORY_JOB = "work"
CATEGORY_COMPANY = "work"
CATEGORY_PROJECT = "work"
CATEGORY_LOCATION = "identity"
CATEGORY_PREFERENCE = "preferences"
CATEGORY_TIMEZONE = "identity"
CATEGORY_PERSONALITY = "preferences"
CATEGORY_TOOL = "preferences"
CATEGORY_TECH = "preferences"

_STRUCTURED_PATTERNS: list[tuple[str, str, str, str]] = [
    # (key_prefix, category, label, regex_pattern)
    ("email", CATEGORY_EMAIL, "Email Address",
     r'\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b'),
    ("linkedin_urn", CATEGORY_LINKEDIN, "LinkedIn URN",
     r'urn:li:[a-zA-Z:]+\d+'),
    ("linkedin_url", CATEGORY_LINKEDIN, "LinkedIn Profile URL",
     r'https?://(?:www\.)?linkedin\.com/in/[a-zA-Z0-9\-_%]+/?'),
    ("phone", CATEGORY_PHONE, "Phone Number",
     r'(?:\+?\d[\d\s\-().]{7,}\d)'),
    ("twitter", CATEGORY_SOCIAL, "Twitter Handle",
     r'(?:^|\s)(@[A-Za-z0-9_]{3,15})\b'),
    ("github_url", CATEGORY_SOCIAL, "GitHub Profile",
     r'https?://github\.com/[a-zA-Z0-9\-]+/?'),
    ("timezone", CATEGORY_TIMEZONE, "Timezone",
     r'\b(?:UTC[+-]\d{1,2}|IST|EST|PST|CST|MST|GMT|BST|CET|JST|AEST|Asia/[A-Za-z_]+|America/[A-Za-z_]+|Europe/[A-Za-z_]+)\b'),
]

_SEMANTIC_PATTERNS: list[tuple[str, str, str, str]] = [
    # (key_prefix, category, label, trigger_keywords_regex)
    ("name", CATEGORY_NAME, "Full Name",
     r"(?:my name is|i(?:'m| am) called|call me|name's)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})"),
    ("first_name", CATEGORY_NAME, "First Name",
     r"(?:my first name is|just call me)\s+([A-Z][a-z]+)"),
    ("job_title", CATEGORY_JOB, "Job Title",
     r"(?:i(?:'m| am) a|my (?:job|role|position|title) is|work as(?: a)?)\s+([A-Za-z\s]+?(?:Engineer|Developer|Designer|Manager|Director|Lead|Analyst|Scientist|Founder|CTO|CEO|VP|Head|Architect|Consultant|Researcher|Writer|Student|Intern|Officer|Principal))\b"),
    ("company", CATEGORY_COMPANY, "Company / Organization",
     r"(?:i work at|i work for|employed at|my company is)\s+([A-Z][A-Za-z0-9\s&.,'-]+?)(?:\s+(?:as|in|for|team)|\.|,|$)"),
    ("project", CATEGORY_PROJECT, "Current Project",
     r"(?:working on|building|my project(?:'s name)? is|project called)\s+([A-Za-z0-9\s\-_]+?)(?:\s+(?:which|that|and|to|is|\.)|\.|,|$)"),
    ("location", CATEGORY_LOCATION, "Location",
     r"(?:i(?:'m| am) (?:based in|located in|from|in)|i live in|my location is|city is)\s+([A-Za-z\s,'-]+?)(?:\.|,|\s+and|\s+but|$)"),
    ("preference_lang", CATEGORY_PREFERENCE, "Preferred Language",
     r"(?:i prefer|i use|my preferred|favorite)\s+(Python|TypeScript|JavaScript|Rust|Go|Java|Swift|Kotlin|C\+\+|Ruby|Scala)\b"),
    ("preference_editor", CATEGORY_PREFERENCE, "Editor / IDE",
     r"(?:i use|my editor is|i prefer)\s+(VS Code|Vim|Neovim|JetBrains|Xcode|Emacs|Cursor|IntelliJ|WebStorm)\b"),
    ("personality", CATEGORY_PERSONALITY, "Personality / Style",
     r"(?:i(?:'m| am)(?: a)? (?:very|quite|fairly|pretty|extremely))?\s+(introvert|extrovert|detail.oriented|big.picture|creative|analytical|ambitious|pragmatic|perfectionist)\b"),
]

CATEGORY_IMPORTANCE: dict[str, float] = {
    "identity": 0.95,
    "contact": 0.95,
    "work": 0.85,
    "preferences": 0.75,
}


def classify_personal_info(text: str) -> list[dict]:
    """
    Multi-pass DSA classifier that extracts structured personal profile facts
    from a free-text memory string. Returns a list of profile attribute dicts.
    """
    findings: list[dict] = []
    text_lower = text.lower()

    # ── Pass 1: Structured regex patterns (email, phone, URN, etc.) ───────────
    for key_prefix, category, label, pattern in _STRUCTURED_PATTERNS:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for i, match in enumerate(matches):
            value = match.strip()
            if not value:
                continue
            key = f"{key_prefix}_{i}" if i > 0 else key_prefix
            findings.append({
                "key": key,
                "category": category,
                "label": label,
                "value": value,
                "importance": CATEGORY_IMPORTANCE.get(category, 0.8),
            })

    # ── Pass 2: Semantic keyword-anchored patterns ─────────────────────────────
    for key_prefix, category, label, pattern in _SEMANTIC_PATTERNS:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            # If the pattern uses a capture group, take group(1), else group(0)
            if len(match.groups()) > 0:
                value = match.group(1).strip()
            else:
                value = match.group(0).strip()
            value = re.sub(r'\s+', ' ', value)
            if len(value) > 3:  # skip very short noise matches
                findings.append({
                    "key": key_prefix,
                    "category": category,
                    "label": label,
                    "value": value,
                    "importance": CATEGORY_IMPORTANCE.get(category, 0.8),
                })

    # ── Pass 3: Deduplicate by key (keep highest-importance match) ────────────
    deduped: dict[str, dict] = {}
    for f in findings:
        key = f["key"]
        if key not in deduped or f["importance"] > deduped[key]["importance"]:
            deduped[key] = f

    return list(deduped.values())


def upsert_profile(conn: sqlite3.Connection, facts: list[dict], source: str, instance_id: str = "default") -> None:
    for fact in facts:
        conn.execute("""
            INSERT INTO ai_profile (key, category, label, value, importance, source_memory, instance_id, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(key, instance_id) DO UPDATE SET
                value = excluded.value,
                importance = excluded.importance,
                source_memory = excluded.source_memory,
                updated_at = datetime('now')
        """, (fact["key"], fact["category"], fact["label"], fact["value"], fact["importance"], source[:500], instance_id))
    conn.commit()


def load_profile(conn: sqlite3.Connection, instance_id: str = "default") -> list[dict]:
    cursor = conn.execute("""
        SELECT key, category, label, value, importance, updated_at
        FROM ai_profile
        WHERE instance_id = ?
        ORDER BY category, importance DESC, updated_at DESC
    """, (instance_id,))
    rows = cursor.fetchall()
    return [dict(row) for row in rows]


# ── Request / Response Models ──────────────────────────────────────────────────
class RememberRequest(BaseModel):
    text: str
    importance: float = 0.8
    source: str = "conversation"
    instanceId: Optional[str] = None


class RecallRequest(BaseModel):
    query: str
    top_k: int = 5
    temporal_weight: float = 0.3
    instanceId: Optional[str] = None


# ── FastAPI Application ────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Verify data dir and warm up Mnemosyne beam on startup."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if HAS_MNEMOSYNE:
        get_beam()  # initialise + warm up
        logger.info("Mnemosyne BeamMemory initialized")
    else:
        logger.warning("Mnemosyne unavailable — profile classifier still active")
    yield
    logger.info("Mnemosyne bridge shutting down")


app = FastAPI(title="Mnemosyne Bridge", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/remember")
def store_memory(req: RememberRequest):
    """Store memory in Mnemosyne + run profile classifier."""
    # Use provided instanceId or default
    instance_id = req.instanceId or "default"
    
    # 1. Save into Mnemosyne BEAM (if available)
    if HAS_MNEMOSYNE:
        try:
            mn_remember(
                req.text,
                importance=req.importance,
                source=req.source,
                extract_entities=True,
            )
        except Exception as exc:
            logger.error("Mnemosyne remember failed: %s", exc)

    # 2. Run profile classifier (always — even without Mnemosyne)
    facts = classify_personal_info(req.text)
    if facts:
        try:
            conn = _get_profile_db()
            upsert_profile(conn, facts, source=req.text, instance_id=instance_id)
            conn.close()
        except Exception as exc:
            logger.error("Profile upsert failed: %s", exc)

    return {"ok": True, "profile_facts_extracted": len(facts)}


@app.post("/recall")
def retrieve_memory(req: RecallRequest):
    """Retrieve memories with hybrid scoring (Mnemosyne) or empty list fallback."""
    if not HAS_MNEMOSYNE:
        return {"found": False, "memories": []}

    try:
        results = mn_recall(
            req.query,
            top_k=req.top_k,
            temporal_weight=req.temporal_weight,
            temporal_halflife=RECENCY_HALFLIFE,
        )
        memories = [
            {
                "content": r.get("content", ""),
                "importance": r.get("importance", 0.7),
                "created_at": str(r.get("created_at", "")),
                "score": r.get("score", 0.0),
            }
            if isinstance(r, dict) else
            {
                "content": getattr(r, "content", ""),
                "importance": getattr(r, "importance", 0.7),
                "created_at": str(getattr(r, "created_at", "")),
                "score": getattr(r, "score", 0.0),
            }
            for r in results
        ]
        return {"found": len(memories) > 0, "memories": memories}
    except Exception as exc:
        logger.error("Mnemosyne recall failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/profile")
def get_profile(instance_id: str = "default"):
    """Return the structured AI user profile extracted from saved memories, filtered by instance."""
    try:
        conn = _get_profile_db()
        items = load_profile(conn, instance_id=instance_id)
        conn.close()

        # Group by category for easier frontend rendering
        grouped: dict[str, list] = {}
        for item in items:
            cat = item["category"]
            if cat not in grouped:
                grouped[cat] = []
            grouped[cat].append(item)

        return {"profile": items, "grouped": grouped, "total": len(items)}
    except Exception as exc:
        logger.error("Profile load failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.post("/sleep")
def consolidate():
    """Run Mnemosyne memory consolidation."""
    beam = get_beam()
    if beam is None:
        return {"ok": False, "reason": "Mnemosyne not available"}
    try:
        if hasattr(beam, "consolidate_working_to_episodic"):
            beam.consolidate_working_to_episodic()
        elif hasattr(beam, "consolidate"):
            beam.consolidate()
        return {"ok": True}
    except Exception as exc:
        logger.error("Consolidation failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/stats")
def stats(instance_id: str = "default"):
    """Return Mnemosyne memory statistics."""
    profile_count = 0
    try:
        conn = _get_profile_db()
        cursor = conn.execute("SELECT COUNT(*) FROM ai_profile WHERE instance_id = ?", (instance_id,))
        profile_count = cursor.fetchone()[0]
        conn.close()
    except Exception:
        pass

    if not HAS_MNEMOSYNE:
        return {"mnemosyne_available": False, "profile_facts": profile_count}

    try:
        from mnemosyne import Mnemosyne
        m = Mnemosyne()
        mn_stats = m.stats()
        return {
            "mnemosyne_available": True,
            "profile_facts": profile_count,
            **mn_stats,
        }
    except Exception as exc:
        return {"mnemosyne_available": True, "profile_facts": profile_count, "error": str(exc)}


@app.get("/health")
def health():
    return {"status": "ok", "mnemosyne": HAS_MNEMOSYNE}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=3999, log_level="warning")
