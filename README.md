# 🤖 Nimits-Jarvis

### A privacy-first, multimodal, model-agnostic personal AI agent.

Nimits-Jarvis is a self-hosted AI agent platform that combines **LLM reasoning, persistent memory, tools, local files, external integrations, automation, voice, and multimodal input** into a single agent runtime.

Jarvis runs models locally through **Ollama** or uses configured cloud providers through **OpenRouter and other integrations**. Routing, memory, tools, files, and privacy controls stay under one orchestration layer, independent of the underlying model provider.

### What makes Jarvis different?

* 🧠 **Model-agnostic reasoning** — switch models without changing the agent architecture.
* 🖼️ **Native multimodal input** — paste or attach images directly to conversations.
* 🔀 **Capability-aware execution** — the runtime checks what the active model supports and fails loudly instead of guessing.
* 🛠️ **Unified tool ecosystem** — MCP, Composio, local tools, filesystem access, memory, scheduling, and sandboxed execution.
* 🧠 **Persistent memory** — project-scoped semantic memory with pgvector and Mnemosyne.
* ⚡ **Token-efficient execution** — optimized tool schemas, context compaction, caching, and selective context injection.
* 🔐 **Privacy-first architecture** — multi-layer PII protection before sensitive data reaches cloud models.
* 📁 **Local computer access** — controlled filesystem read/write with boundaries and auditability.
* 🌐 **Supervised browser control** — headed, policy-gated Playwright automation with an isolated profile.
* 🎙️ **Voice & omnichannel** — voice interaction and Telegram support.
* ⏰ **Background automation** — scheduled tasks, retries, distributed locking, and autonomous workflows.

Jarvis is designed as an **AI operating layer**, not a chatbot: the model is interchangeable, capabilities are composable, and the agent runtime controls how intelligence, memory, tools, and external systems work together.

---

## ✨ Core Capabilities

### 🧠 Model-Agnostic Intelligence
Multi-provider LLM support (Ollama local, OpenRouter/Anthropic cloud), model-per-chat selection, per-step reasoning budgets (first step plans, later steps act — effort guidance only, no output caps), and agent execution guardrails including a check-in after ~8 tool calls instead of silent grinding.

### 🖼️ Multimodal / Image Understanding
Clipboard paste or file attachment (50 MB cap, magic-byte validated, archival original + derivatives). Images travel with the turn's text; the server re-validates ownership and model capability — the client is never the authority.

### 🔀 Intelligent Vision Routing
Capability metadata per model, re-checked server-side. Vision-capable model → images passed directly. Otherwise the run fails loudly (`MODEL_NO_VISION`) telling the user to switch models and re-attach — a quiet drop once produced confident hallucinations about an image the model never received. A configured vision-fallback model is on the roadmap, not yet implemented.

### 🛠️ Tool & Agent Orchestration
Three sources merge into one AI SDK `ToolSet` (custom tools win collisions, keys sorted for cache stability, 100-step cap): **Composio** OAuth tools in remote sandboxes, **MCP** servers (Streamable HTTP / SSE, per-instance, namespaced `mcp__<server>__<tool>`), and **custom local tools** (memory, scheduling, filesystem, skill loading). High-stakes external actions require explicit chat approval.

### 🌐 Supervised Browser Control
Opt-in Playwright automation via a supervised daemon (`pnpm browser:daemon`): headed real-Chrome, isolated profile outside the filesystem access tree, per-server origin allowlists (bare sites expand to apex + all subdomains — verified by probe, not assumed), read-only tools first, `cronSafe` permanently off, session self-heal across server restarts.

### 🧠 Persistent Memory
pgvector semantic memory (384-dim Ollama `bge-small` embeddings, project-scoped), Mnemosyne hybrid FTS5+cosine sidecar with PostgreSQL fallback, and a 3-layer lifecycle: prune before every call, memory flush before compaction, summarization after — conversations run indefinitely without carrying full history.

### ⚡ Context & Token Efficiency
Tool schemas minimized before reaching the model; redundant descriptions stripped; spent search results collapse to stubs; tool-result payloads decay by age (full → excerpt → one-liner) while staying addressable via paged reads; deterministic serialization keeps provider caching effective. Long multi-step workflows stay resident without re-sending settled context.

### 📁 Local File Intelligence
Read tools (`fs_list`, `fs_find`, `fs_read`) under per-project ceilings plus per-message modes; write tools under a change budget with a journaled, reversible audit log (unified diffs, SHA-256 digests, 7-day undo). Every path passes realpath→containment→deny-list; system trees and credential stores are refused with actionable errors, and macOS TCC grants attach to the launching terminal.

### 🔐 Privacy / PII Protection
Six-layer protection for cloud-model execution: identity registry, regex/heuristic scanner (incl. Luhn), local ONNX NER behind a circuit breaker, structural JSON extractor, network egress shield, and SSE stream restore — with compile-time tokenized/real-text boundaries and PII-aware tool-result handling.

### ⏰ Background Tasks
Minute-cadence cron runner (Vercel Cron or local daemon), atomic per-instance claiming, stale-lock recovery, rate-limit backoff, Telegram/web/cron source gating (`cron` sees only `cronSafe` tools).

### 🎙️ Voice & Omnichannel
Web dashboard (Next.js 16, shadcn/ui, dark mode), bidirectional Telegram bot, Whisper STT / configurable TTS with audio-orb UI.

---

## 🏗️ Architecture

### Multimodal flow

```text
User: text + images (paste / attach)
  → ownership + readiness validation
  → capability check on the chat model
  → vision-capable? attach derivatives : MODEL_NO_VISION (loud)
  → ToolLoopAgent (tools, memory, compaction as usual)
```

### Capability routing (general shape)

```text
Input → Capability Detection → Supported → Primary Model
                              → Unsupported → loud error today;
                                configured-fallback model (roadmap)
```

### System diagram

```mermaid
flowchart TD
    subgraph Ingress Gateways
        A["Web Dashboard (Next.js 16 + tRPC)"]
        B["Telegram Webhook (/api/telegram-webhook)"]
        C["Cron Dispatcher (/api/cron/nimits-jarvis)"]
    end

    subgraph Agent Core Orchestrator
        D["prepareAgentRun()"]
        E["ToolLoopAgent (100-Step Loop)"]
        F["Tool Optimizer & Registry"]
        G["3-Layer Context Compaction Engine"]
    end

    subgraph Tool Sources
        T1["Composio Cloud Sandboxes"]
        T2["MCP Servers (HTTP/SSE)"]
        T3["Custom Tools (Memory, Schedule, fs_*)"]
        T4["Hermetic Script Runner (Python)"]
        T5["Supervised Browser (Playwright daemon)"]
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
        S1[("PostgreSQL (Prisma 7)")]
        S2[("pgvector (384-dim Cosine Search)")]
        S3["Mnemosyne Sidecar (Hybrid FTS5)"]
        S4[("Redis (Rate Limits & Stream Cache)")]
    end

    A --> D
    B --> D
    C --> D

    D --> P1 & P2 & P3 & P4
    D --> F
    F --> T1 & T2 & T3 & T4 & T5
    D --> E
    E --> P5
    E --> G
    G --> S1 & S2 & S3
    A --> P6
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: `>=24.0.0` and **pnpm** `v10+` / `v11+`
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

### 6. Supervised Browser Control (optional)
```bash
pnpm browser:daemon
```
Add a Playwright-type MCP server in Settings → MCP pointing at the daemon's loopback URL, sync tools, and enable the read-only set (`browser_navigate`, `browser_snapshot`, `browser_wait_for`). Origin allowlists, the isolated profile, and headless/headed mode are managed per server; policy edits apply on daemon reload.

### macOS privacy note
TCC privacy grants attach to the **terminal application that launches the server**, not to Jarvis itself. Grant **Full Disk Access** to that terminal in System Settings → Privacy & Security, and always launch from the same terminal — switching from iTerm to Terminal.app (or an IDE shell) means a fresh grant and silent `EPERM` until it is given.

---

## 🧪 Verification & Quality Assurance

Run type checking, linting, and production builds:
```bash
# Full gate: ESLint + strict TypeScript type check
pnpm check

# Turbopack production build
pnpm build

# Filesystem + PII acceptance batteries (need .env + local DB)
pnpm dotenv -e .env -- exec tsx src/server/api/routers/nimits-jarvis/agent/__tests__/fs-phase-a.test.ts
pnpm dotenv -e .env -- exec tsx src/server/api/routers/nimits-jarvis/agent/__tests__/fs-phase-b.test.ts

# Update Graphify codebase knowledge graph
python3 -m graphify update .
```

---

## 🎯 Design Principles

1. **Model agnostic** — swap providers without rewriting the agent architecture.
2. **Capability over provider** — reason about what a model can do (text, vision, reasoning, embeddings, voice), not vendor-specific behavior.
3. **Primary model ownership** — the user's selected model owns the conversation and final response; specialized models fill capabilities.
4. **Local-first, cloud-capable** — sensitive processing stays local where practical; cloud runs where explicitly configured.
5. **Least necessary context** — the agent receives the minimum context to complete a task, not the whole application state.
6. **Explicit high-impact actions** — consequential external operations require authorization where configured.
7. **Persistent but controlled memory** — memory improves future turns without injecting full history into every request.
8. **Extensible execution** — new models, tools, integrations, and modalities arrive through capability and routing layers, not core-loop coupling.

---

## 🗺️ Roadmap

* Configured vision-fallback model (analyze via fallback, primary keeps the response)
* MCP image-block passthrough into the attachment store
* Comet rendering-parity probe for browser control
* Origin-rule match counts + discovery suggestions in Settings
* Retrieval-based tool discovery if measured payloads demand it

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for details.
