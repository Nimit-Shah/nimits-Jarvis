# 🤖 Nimits-Jarvis

**Your 100% Local, 24/7 Personal AI Agent — Operating Securely at Zero Cost.**

`Nimits-Jarvis` is a secure, self-hosted personal AI assistant built on **Next.js 15**, **Composio**, and **Vercel AI SDK**. Run open-source models locally via **Ollama** or cloud models via **OpenRouter** — with full multi-project isolation, multi-chat threading, and per-project encrypted connections.

---

## ✨ Features

### Core Intelligence
- 🧠 **Multi-Provider Models:** Run local models (Ollama) or cloud models via **OpenRouter** — each chat retains its own model selection across sessions
- 💾 **Semantic Memory (pgvector):** Persistent memory storage using `384`-dimension vectors, shared across all chats within a project
- 💤 **Cron Jobs:** Schedule recurring background tasks tied to specific chats — hardened against prompt injection via context isolation
- 🧠 **3-Layer Context Management:** Auto-pruning → memory flush → context compaction ensures infinite conversations without context overflow

### Multi-Project & Multi-Chat
- 🗂 **Project Isolation:** Each project has its own AES-256-GCM encrypted Composio API key, isolated connections, and independent settings (PII, gateways, Telegram)
- 💬 **Multi-Chat Threading:** Organize work across multiple concurrent chat threads — each with its own model, context window, and compaction state
- 🔄 **Concurrent Streaming:** Multiple chats can stream agent responses simultaneously
- 📱 **Two-Panel UI:** Left sidebar (project selector + chat list + navigation + profile) | Center (chat view with model selector)
- 📛 **Auto-Naming:** New chats automatically named from the first message; rename anytime via the sidebar menu

### Security & Privacy
- 🛡 **PII Protection (6-Layer Defense):** When using cloud models, sensitive data is tokenized and redacted at every tier — tool results, context messages, system prompts, and the transport stream itself. SSE chunk-boundary buffering ensures no token leaks mid-stream
- 🔐 **Per-Project Encryption:** Each project's Composio API key is AES-256-GCM encrypted at rest; no shared keys between projects
- ⛓ **Composio Sandboxing:** Code execution runs inside Composio's remote workbench sandboxes, protecting your host machine
- 🔑 **OAuth-First:** The agent accesses services through OAuth flows — no raw service credentials exposed

### Communication
- 💬 **Omnichannel:** Chat via the Next.js Web Dashboard or **Telegram Bot** — each Telegram message auto-creates a new chat thread
- 🎙 **Whisper Voice Mode:** Integrated speech-to-text via **Whisper** with Jarvis-themed orb UI — scoped per-chat

### Quality of Life
- 🔍 **Chat Search:** Search across all messages in a project by content
- ⚡ **Stream Reconnection:** Redis-backed resumable streams survive page refreshes
- 🌓 **Dark Mode:** Full light/dark theme support via shadcn/ui theming
- 🔒 **Auth:** Better Auth with username/password

---

## 🏗 System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            Client Interfaces                             │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────┐  │
│  │   Web Dashboard      │  │   Telegram Bot       │  │  Whisper     │  │
│  │  (Next.js 15 + tRPC) │  │   (Telegram API)     │  │  Voice STT   │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └──────┬───────┘  │
└─────────────┼─────────────────────────┼──────────────────────┼─────────┘
              │                         │                      │
              └─────────────────────────┼──────────────────────┘
                                        │
              ┌─────────────────────────▼──────────────────────────────┐
              │               prepareAgentRun()                       │
              │             (Agent Orchestrator)                       │
              │                                                        │
              │  1. Load Project + Chat → per-chat model selection     │
              │  2. Build System Prompt (identity + memories)          │
              │  3. Create PII Vault (for non-local models)            │
              │  4. Load & Prune Context (scoped to chat)              │
              │  5. Create Composio Session (per-project API key)      │
              │  6. Wrap Tools (Unicode sanitize + PII redact)         │
              │  7. Build ToolLoopAgent (20-step limit)                │
              └─────────────────────────┬──────────────────────────────┘
                                        │
     ┌──────────────────────────────────┼──────────────────────────┐
     │                                  │                          │
     ▼                                  ▼                          ▼
┌──────────────┐              ┌───────────────────┐    ┌───────────────────┐
│  Local LLM   │              │   Cloud LLMs      │    │  Composio Router  │
│  (Ollama)    │              │  (OpenRouter)     │    │  OAuth → Tools    │
│  No PII      │              │  + PII Redaction  │    │  Gmail, Slack...  │
└──────┬───────┘              └────────┬──────────┘    └────────┬──────────┘
       │                               │                        │
       └───────────────────────────────┼────────────────────────┘
                                       │
              ┌────────────────────────▼─────────────────────────┐
              │           Post-Response (fire-and-forget)        │
              │                                                  │
              │  1. PII Restore → save to DB                     │
              │  2. Memory Flush (pre-compaction threshold)      │
              │  3. Context Compaction (summarize if overflow)   │
              │  4. Clear streaming state (Redis)                │
              └──────────────────────────────────────────────────┘
```

### Multi-Project Architecture

```
User
 ├── Project A (encrypted API Key: ak_abc...)
 │    ├── Composio Entity: project-a-id
 │    ├── Settings: PII enabled, OpenRouter on
 │    ├── Chat "First chat" (model: deepseek-v4)
 │    │    ├── Compaction state
 │    │    └── Messages (scoped to chatId)
 │    └── Chat "Research" (model: qwen3:8b)
 │
 └── Project B (encrypted API Key: ak_xyz...)
      ├── Composio Entity: project-b-id
      ├── Settings: PII enabled
      ├── Chat "Email automation" (model: gpt-4o)
      │    └── Gmail connection (isolated)
      └── Chat "Daily summaries"
           └── Cron job: daily @ 9am
```

### PII Protection — 6-Layer Defense

```
Tool Results ──► Deep-Walk JSON Scanner ──► Structured PII Extraction
                                               │
Context Messages ──► Redaction Pass ───────────┤
                                               │
System Prompt ──► Identity/Soul scrub ─────────┤
                                               ▼
                                     ┌─────────────────┐
                                     │   PII Vault     │
                                     │  [CLAW_TYPE_H]↔ │
                                     │  user@email.com │
                                     └────────┬────────┘
                                               │
                        ┌──────────────────────┼──────────────────────┐
                        ▼                      ▼                      ▼
               Tool Result Redact    Context Redact          System Prompt Scrub
                        │                      │                      │
                        └──────────────────────┼──────────────────────┘
                                               │
                                     ┌─────────▼─────────┐
                                     │ Transport Shield  │
                                     │ (Network-layer    │
                                     │  final checkpoint)│
                                     └─────────┬─────────┘
                                               │
                                     ┌─────────▼─────────┐
                                     │  SSE Stream with  │
                                     │  Chunk-Boundary   │
                                     │  Buffered Restore │
                                     └───────────────────┘
```

---

## 🚀 Getting Started

### 1. Prerequisites
- [Node.js v22+](https://nodejs.org) and [PNPM](https://pnpm.io)
- [Ollama](https://ollama.com) (for local LLM and embedding generation)
- [PostgreSQL 16+](https://postgresql.org) with the `pgvector` extension enabled
- [Redis](https://redis.io) (optional — enables resumable streams; basic streaming works without it)

### 2. Pull Open Source Models
```bash
ollama pull qwen3:8b
ollama pull qllama/bge-small-en-v1.5
```

### 3. Setup
```bash
git clone https://github.com/Nimit-Shah/nimits-jarvis.git
cd nimits-jarvis
pnpm install
cp .env.example .env
```

Edit `.env` and fill in:
- `DATABASE_URL` — PostgreSQL connection string
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
- `COMPOSIO_API_KEY` — Get from [Composio Dashboard](https://dashboard.composio.dev/)
- `ENCRYPTION_KEY` — `openssl rand -hex 32` (for at-rest API key encryption)
- `OPENROUTER_API_KEY` — Get from [OpenRouter](https://openrouter.ai/) (for cloud models)

### 4. Per-Project API Keys (Project Isolation)
Each project stores its own encrypted Composio API key in the database. Run the migration to set up the schema:
```bash
pnpm prisma db push
```
Then encrypt and store per-project keys via the provided migration script. Each project gets fully isolated connections — project A's Gmail won't leak into project B.

### 5. Run
```bash
pnpm dev
```
Open [http://localhost:3000](http://localhost:3000) and complete the onboarding wizard.

---

## 🛡 Security Design

- **Zero Local Execution:** Code runs inside Composio's sandboxes — host machine protected from prompt injection
- **OAuth-First:** No raw service keys visible to the agent; all access through Composio OAuth brokers
- **PII Encryption (6 Layers):**
  1. **Structured PII Extraction** — Deep-walks JSON tool results (depth 25) matching 40+ known paths and key-name heuristics. Covers Gmail People API (`names.*.displayName`, `names.*.givenName`, `names.*.familyName`, `emailAddresses.*.value`), Calendar, Slack, and Discord schemas
  2. **Tool-Output Redaction** — All string values in tool results redacted against registered PII. Identity registry uses `\b...\b` word boundaries to prevent substring corruption. Phone regex includes `\b` boundary and context validation to reject resource IDs. DeBERTa classifier with circuit breaker (3 failures → 120s cooldown → retry)
  3. **Context Message Redaction** — Historical turns fully redacted using deterministic tokens; checkpoints restore tokens in tool inputs before re-execution
  4. **System Prompt Scrub** — Identity/soul prompts (which may contain user PII) are redacted
  5. **Transport-Layer Shield** — Network-level deep-scrub of the entire compiled payload before LLM, with `containsTokenPattern` safety utility for downstream consumers
  6. **SSE Chunk-Boundary Restore** — Regex-based chunk buffer catches partial tokens at SSE boundaries for both bracket format `[CLAW_TYPE_HASH]` and email domain format `CLAW_EMAIL_hash@trustclaw.anon`; tokens restored to real values on return
- **Token Formats:** Email addresses use domain format (`CLAW_EMAIL_A1B2@trustclaw.anon`); all other types use bracket format (`[CLAW_PERSON_NAME_C3D4]`). Both formats supported by `isTokenString`, `containsTokenPattern`, and SSE boundary buffering
- **Canonicalization:** Case-insensitive deduplication with whitespace normalization preserves first-seen casing for restoration
- **Project Isolation:** Each project has its own AES-256-GCM encrypted Composio API key; no shared keys, no connection leakage between projects
- **Per-Chat Model Selection:** Each chat can use a different model (local or OpenRouter); model retained across chat switches

---

## 🏛 Architecture Principles

- **One thing per file** — One component, one procedure, one schema per file
- **Type safety end-to-end** — Zod schemas define contracts, TypeScript enforces them
- **Mobile-first** — Every page responsive; sidebar becomes slide-over Sheet on mobile
- **Co-location** — Related files live together (skeletons with components, schemas with procedures)
- **Maximally use shadcn/ui** — Minimal custom CSS; theme-aware color variables

---

## 📝 License

Distributed under the MIT License. See `LICENSE` for more information.