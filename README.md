# 🤖 Nimits-Jarvis

**Your 100% Local, 24/7 Personal AI Agent — Operating Securely at Zero Cost.**

`Nimits-Jarvis` is a secure, self-hosted personal AI assistant built on **Next.js 15**, **Composio**, **Model Context Protocol (MCP)**, and **Vercel AI SDK**. Run open-source models locally via **Ollama** or cloud models via **OpenRouter** — with full multi-project isolation, multi-chat threading, per-project encrypted connections, and enterprise-grade 6-layer PII redaction.

---

## 📚 Specification & Architecture Reference

The system architecture, execution loops, security boundaries, and extension roadmaps in this codebase are designed and governed according to the technical specification created by **Claude Opus 5**:
- 📄 **Core Architecture & Design Notes:** [`docs/Personal Project Talk with Claude.docx`](file:///Users/ayunimusmac/nimits-jarvis/docs/Personal%20Project%20Talk%20with%20Claude.docx)
- 🔌 **Model Context Protocol (MCP) Integration:** [`docs/MCP_IMPLEMENTATION.md`](file:///Users/ayunimusmac/nimits-jarvis/docs/MCP_IMPLEMENTATION.md)
- 📜 **Hermetic Script Execution Engine:** [`docs/SCRIPT_EXECUTION.md`](file:///Users/ayunimusmac/nimits-jarvis/docs/SCRIPT_EXECUTION.md)
- 🛡️ **PII PureShield Specification:** [`docs/PII-POLICY.internal.md`](file:///Users/ayunimusmac/nimits-jarvis/docs/PII-POLICY.internal.md)

---

## ✨ Features & Capabilities

### 🧠 Core Intelligence & Tool Ecosystem
- **Multi-Provider LLMs:** Run local models on-device via **Ollama** (e.g. `qwen3:8b`, `deepseek-r1`) or cloud models via **OpenRouter** / Anthropic. Each chat thread retains its own model selection.
- **Unified 4-Source Tool Merge:** Tools from all sources merge into a single AI SDK `ToolSet` without plugin dispatch overhead:
  1. **Composio Tools (Dynamic):** OAuth-brokered tools (Gmail, Calendar, Slack, GitHub) executing in isolated remote sandboxes.
  2. **Model Context Protocol (MCP) Tools:** Dynamic per-instance MCP servers (HTTP / SSE / StdIO) with namespaced tools (`mcp__<server>__<tool>`).
  3. **Custom Local Tools:** Semantic memory (`createMemorySaveTool`, `memory_search`), cron scheduling (`createScheduleTool`), and connection management.
  4. **Script Execution (Gated):** Sandboxed Python data analysis (`write_script`, `run_script`, `read_artifact`) with human-in-the-loop approval cards.
- **Tool Schema Optimizer:** Automatically trims bloated JSON Schema metadata (`description` noise, redundant definitions) to reduce prompt token consumption by 40–60%.

### 💾 Persistent Memory & Context Management
- **3-Layer Context Compaction:** Auto-pruning → memory flush → summary compaction ensures conversations can run indefinitely without context window overflow.
- **Semantic pgvector Memory:** Persistent fact storage with `384`-dimension vectors embedded via Ollama (`qllama/bge-small-en-v1.5`), shared across all chats within a project.
- **Mnemosyne Hybrid Memory Bridge:** Integrates with the Mnemosyne sidecar for fast FTS5 + cosine similarity hybrid recall, gracefully falling back to raw PostgreSQL `pgvector`.

### 🛡️ Enterprise PII PureShield (6-Layer Hybrid Redaction)
When cloud models are used, sensitive identity data is tokenized and shielded before crossing the network boundary:
1. **Layer 1: Identity Registry (`identity.yaml`)** — Deterministic <1ms dictionary lookup matching known personal names, phones, emails, and secrets (sorted length-descending to prevent substring collisions).
2. **Layer 2: Regex & Heuristic Scanner** — RFC 5322 emails, international phone numbers (with lookbehind `(?<!\w)` and 10-digit validation), Luhn-verified credit cards, SSNs, IPv4 addresses, and API key patterns.
3. **Layer 3: Local DeBERTa ONNX NER Classifier** — Zero-shot token classification using `@huggingface/transformers` with circuit-breaker protection (3 failures → 120s cooldown).
4. **Layer 4: Structural JSON Extractor** — Schema-aware path walker (depth 25) extracting entities from Gmail People API, Google Calendar, Slack, and Discord payloads.
5. **Layer 5: Network Transport Shield** — Final egress checkpoint deep-scrubbing the fully assembled message array before HTTP wire serialization.
6. **Layer 6: SSE Chunk-Boundary Buffered Stream Restore** — Buffers split tokens across streaming chunks, seamlessly restoring `[CLAW_TYPE_HASH]` and `CLAW_EMAIL_hash@trustclaw.anon` tokens back to real values in the browser UI.
- **Branded Compile-Time Types:** `TokenizedText` and `RealText` enforce PII boundaries at compile-time via TypeScript branded types.

### ⏰ Resilient Background Tasks & Schedulers
- **Minute-by-Minute Cron Runner:** Triggered via Vercel Cron (`* * * * *`) or local background daemon (`scripts/cron-daemon.ts`).
- **Distributed Locking:** Database-backed locks with `lockedAt`, `lockedBy`, and stale lock timeout recovery.
- **Rate-Limit Retry Backoff:** Rate-limited cron tasks are rescheduled with a dynamic retry window (`NOW + retryAfterSeconds`) instead of being skipped.

### 💬 Omnichannel & Voice
- **Web Dashboard:** Clean Next.js 15 App Router interface with shadcn/ui and Dark Mode.
- **Telegram Bot:** Full bidirectional messaging with typing indicators, tool execution status updates, and automatic error handling.
- **Whisper Voice Mode:** Local speech-to-text with interactive audio orb visualization.

---

## 🏗 System Architecture

```mermaid
flowchart TD
    subgraph Ingress Gateways
        A["Web Dashboard (Next.js 15 + tRPC)"]
        B["Telegram Webhook (/api/telegram-webhook)"]
        C["Cron Dispatcher (/api/cron/nimits-jarvis)"]
    end

    subgraph Agent Core Orchestrator
        D["prepareAgentRun()"]
        E["ToolLoopAgent (20-Step Loop)"]
        F["Tool Optimizer & Registry"]
        G["3-Layer Context Compaction Engine"]
    end

    subgraph Tool Sources
        T1["Composio Cloud Sandboxes"]
        T2["MCP Servers (HTTP/SSE)"]
        T3["Custom Tools (Memory, Schedule)"]
        T4["Hermetic Script Runner (Python)"]
    end

    subgraph PII PureShield Subsystem
        P1["Identity Registry (identity.yaml)"]
        P2["Regex + Luhn Scanner"]
        P3["Local DeBERTa NER (HuggingFace ONNX)"]
        P4["Structural JSON Extractor"]
        P5["PIITransportShield (Egress Checkpoint)"]
        P6["SSE Stream Chunk Buffer"]
    end

    subgraph Storage & Persistence
        S1[("PostgreSQL (Prisma 7.9)")]
        S2[("pgvector (384-dim Cosine Search)")]
        S3["Mnemosyne Sidecar (Hybrid FTS5)"]
        S4[("Redis (Rate Limits & Stream Cache)")]
    end

    A --> D
    B --> D
    C --> D

    D --> P1 & P2 & P3 & P4
    D --> F
    F --> T1 & T2 & T3 & T4
    D --> E
    E --> P5
    E --> G
    G --> S1 & S2 & S3
    A --> P6
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: `>=22.12.0` (Active LTS / v24) and **pnpm** `v10+` / `v11+`
- **PostgreSQL 16+** with the `pgvector` extension installed
- **Ollama** (for local embeddings and offline model inference)
- **Redis** (optional — required for cross-instance stream resumption and rate limiting)

### 2. Pull Required Models
```bash
# Pull embedding model (384-dimension vector embeddings)
ollama pull qllama/bge-small-en-v1.5

# Pull default local reasoning model
ollama pull qwen3:8b
```

### 3. Installation
```bash
git clone https://github.com/Nimit-Shah/nimits-Jarvis.git
cd nimits-Jarvis
pnpm install
cp .env.example .env
```

Configure `.env`:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/trustclaw"
BETTER_AUTH_SECRET="<generate-with-openssl-rand-base64-32>"
ENCRYPTION_KEY="<generate-with-openssl-rand-hex-32>"
NEXT_PUBLIC_APP_URL="http://localhost:3000"

# Optional Cloud Providers
OPENROUTER_API_KEY="sk-or-v1-..."
COMPOSIO_API_KEY="ak_..."
```

### 4. Database Setup & Migrations
```bash
pnpm prisma generate
pnpm prisma db push
```

### 5. Run Development Server
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) to access the dashboard.

---

## 🧪 Verification & Quality Assurance

Run type checking, linting, and production builds:
```bash
# Run strict TypeScript type check
pnpm typecheck

# Run Next.js production build
pnpm build

# Update Graphify codebase knowledge graph
python3 -m graphify update .
```

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for details.