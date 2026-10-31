# 08 · Agents and MCP

Phase 2 replaced the one-shot RAG pipeline with a small tool-calling agent. It also added a model-provider abstraction, a human approval step for writes, and an MCP server that lets Claude (or any MCP client) search one organisation's documents.

## The shape of it

```
                ┌──────────── apps/api ─────────────────────────────────────────┐
 browser ─SSE─▶ │ ChatController ─▶ ChatService                                   │
 widget         │                     │ 1 quota  2 language  3 classify (FAST)   │
                │                     ▼                                          │
                │               AgentLoop  ◀── ModelRouter ── ChatModel port     │
                │       (≤ 5 model calls)       per tenant:     ├ GeminiChatModel │
                │        │ validate (Zod)       fast / strong   ├ AnthropicChat…  │
                │        │ audit row            model           ├ OpenAiChatModel │
                │        ▼                                      └ FakeChatModel   │
                │   ToolRegistry: search_documents · get_source ·                 │
                │                 list_documents · create_ticket (write)         │
                │        │ ports                                                 │
                │        ▼                                                       │
                │   Prisma / RetrievalService adapters ── Postgres + pgvector    │
                │                                                                │
 MCP client ──▶ │ /api/mcp/*  (ApiKeyGuard) ─▶ executeTool(read tools only)      │
 (via apps/mcp) └────────────────────────────────────────────────────────────────┘
```

**Clean architecture, concretely:**

| Layer | Files | Depends on |
|---|---|---|
| Domain (plain classes, no Nest) | `agent/domain/*` (AgentLoop, ToolRegistry, SourceLedger, QuestionClassifier, ApprovalService, executeTool), `agent/tools/*`, `llm/chat-model.port.ts`, `llm/model-router.ts` | Zod and nothing else |
| Ports | `agent/domain/ports.ts` (search, chunk reader, document lister, ticket writer, audit), `ApprovalStorePort`, `ChatModel` | — |
| Adapters | `agent/infra/prisma-adapters.ts`, `llm/adapters/{gemini,anthropic,openai}-chat-model.ts`, `llm/fake-chat-model.ts` | Prisma, fetch, `@anthropic-ai/sdk` |
| Nest glue (thin) | `agent/agent.service.ts` (composition root), `llm/llm.module.ts`, `chat/*`, `api-keys/*` | Nest |

Each domain class is unit-tested with in-memory ports and the scripted `FakeChatModel`. No test needs an API key.

## The tool contract

Every tool is an `AgentTool`:

```ts
interface AgentTool<I> {
  name: string;               // lower_snake_case; every provider accepts it
  description: string;        // written for the model
  kind: 'read' | 'write';     // write => needs a person to approve it
  input: z.ZodType<I>;        // ONE schema: JSON Schema for the model + runtime validation
  label(input: I): string;    // what the UI shows while it runs
  execute(input: I, ctx: ToolContext): Promise<{ content: unknown; summary: string }>;
}
```

- **Schemas.** `ToolRegistry.specs()` turns each Zod schema into JSON Schema with `z.toJSONSchema()`, with `additionalProperties: false`. The same schema validates what the model sends back. An invalid call does not crash anything: the error text goes back to the model as the tool result, and the model can correct itself.
- **Tenant scoping.** `ToolContext.tenantId` comes from the verified JWT or API key, never from the model. No tool schema has a tenant field, so a prompt injection cannot point a tool at another organisation.
- **Citations.** `SourceLedger` numbers every passage the agent has seen across all tool calls. The model cites those numbers; source cards come from the ledger, not from the model's text. Citation validation (layer 3) still strips any number the ledger never handed out.

| Tool | Kind | Does |
|---|---|---|
| `search_documents(query, filters?)` | read | Hybrid search (pgvector + full-text, RRF). The similarity floor from the old pipeline applies: weak matches return an empty list. |
| `get_source(chunkId)` | read | The full text of one passage. Another tenant's id reads as "not found". |
| `list_documents()` | read | The documents the assistant can answer from. |
| `create_ticket(summary)` | **write** | A hand-off to a person. Runs only after the user confirms. |

## Safety limits (enforced in code, not in the prompt)

1. **Step cap.** At most 5 model calls per answer (`AGENT_MAX_STEPS`). The last call is made with `toolChoice: 'none'`, so the loop always ends with an answer.
2. **Fan-out cap.** At most 4 tool calls per step, and a 15-second timeout per tool.
3. **Validation.** Zod checks every input before a tool runs.
4. **Approval for writes.** `create_ticket` is recorded as `PENDING_APPROVAL` and the UI shows a confirm/cancel card. `ApprovalService` then:
   - runs the input stored at proposal time, so the model gets no second chance to change it;
   - claims the row with a conditional `UPDATE`, so a double click runs it once;
   - lets approvals expire after 30 minutes;
   - is tenant-scoped, and the public widget must also present the conversation id.
5. **Audit log.** The `tool_calls` table gets one row per call, from the agent or from MCP. That includes failed validations and refused writes. Internal error text is stored there and never sent to the model or the UI.
6. **Small blast radius.** The tools can read the tenant's documents and propose one kind of write. MCP clients get the read tools only.

## Model providers (2.2)

`ChatModel` is one model turn: `stream(request) → deltas…, then { text, toolCalls, usage, stopReason, providerState }`. The loop that feeds tool results back lives in the agent, so every provider gets the same limits.

| Adapter | Transport | Notes |
|---|---|---|
| Gemini | `streamGenerateContent` (SSE), `functionDeclarations` with `parametersJsonSchema` | Gemini 3 needs the `thoughtSignature` on function-call parts sent back. The raw parts travel in `providerState` and are replayed verbatim. The key goes in the `x-goog-api-key` header, never in the URL. |
| Anthropic | Official SDK, `beta.messages.stream()` + `finalMessage()` | Defaults to `claude-opus-5-5` for answers and `claude-haiku-5-5` for classification. Thinking is left adaptive, with effort `medium`/`low`. Content blocks, thinking included, are replayed unchanged. Tool results go back in one user message. No tool call runs from a turn cut off by `max_tokens` or a `refusal`. Strong models opt into server-side refusal fallbacks (`fallbacks: "default"`). |
| OpenAI-compatible | Chat Completions streaming | Reassembles tool-call fragments by index. Works with any compatible endpoint, which is how the e2e test talks to a fake LLM server. |
| Fake | in-process | `demoResponder`: keyword rules, deterministic. `LLM_DEFAULT_PROVIDER=fake` runs the whole product with no key, for demos. It is refused in production. |

**Routing.** `ModelRouter.resolve(tenant.llmProvider, tier)` picks the tenant's provider if it has a key, otherwise the deployment default. Owners choose the provider in Settings, where providers without a key are shown but disabled. Each question first goes to the **fast** model, which labels it `documents`, `handoff` or `smalltalk`. Small talk is answered by the fast model with no tools. Everything else goes to the **strong** model with tools. Any doubt becomes `documents`.

Embeddings stay on Gemini (`gemini-embedding-001`, 768 d). Changing the embedder means re-embedding every chunk, which is a migration, not a setting.

## SSE events

`meta` → (`step` running/done)* → `sources`* → `approval`* → `delta`* → `done` (with `pendingActions`) | `error`. Each `sources` event carries the full ledger so far. Old clients that ignore unknown events keep working: the widget did, until it learned to render the approval box.

## MCP server (`apps/mcp`)

- **Transports:** stdio (`dist/stdio.js`, for Claude Desktop and Claude Code) and streamable HTTP (`dist/http.js`, stateless, `POST /mcp`).
- **Tools:** `search_documents`, `get_source`, both marked `readOnlyHint`. **Resource:** `documents://{tenant}`. A key can only read its own tenant's URI.
- **Auth:** a tenant API key (`asklk_…`, 256 bits). Admins create keys in Settings → API keys. The key is shown once and only its SHA-256 is stored. Revoking works immediately.
- **Rate limits:** per key in the MCP HTTP server (sliding window, `MCP_RATE_LIMIT`, default 60/min), and per key again in the API (Redis, 60/min per route).
- **Audit:** every call is a `tool_calls` row with `origin = MCP` and the key id. The MCP server also writes one JSON line per call to stderr; stdout is the protocol channel in stdio mode.
- **No database access.** The MCP server only forwards calls to `/api/mcp/*`, where the same tool objects as the chat agent run. One implementation, one audit log, one tenant check.

It was checked from Claude Code 2.1.312 against a local API: see `docs/screenshots/v3-mcp-claude-code.png`, rendered from the run's `stream-json` output. Claude connected over stdio, called `search_documents`, and answered "Rs. 2,000 [1] (tuition-class-info.txt)". The audit table recorded the call as `MCP | search_documents | OK`. Setup steps are in the README.

## Tests

| Where | What |
|---|---|
| `agent/domain/*.spec.ts` | Loop behaviour with a scripted model: tool selection, results fed back, step cap, final `toolChoice: none`, fan-out cap, invalid input, unknown tool, hidden internal errors, write → pending approval, one proposal per answer, usage summed, audit rows. Also the registry, ledger, classifier, approvals and executor. |
| `llm/**/*.spec.ts` | Each adapter's wire format with mocked `fetch` / a fake SDK client, the router, the fake model, and the SSE reader. |
| `test/agent.e2e-spec.ts` | The real app and real Postgres, with the OpenAI adapter pointed at `test/fake-llm-server.ts`. It covers search → cited answer, refusal, ticket proposed → cross-tenant approve refused → approved once → 409 on repeat, and the MCP gateway (keys, read-only tools, resource, revoke). |
| `apps/mcp/test` | The MCP server over an in-memory transport, the HTTP transport with a real client, the backend client and the limiter. |
| `apps/web/e2e/chat.spec.ts` | Tool steps render live; approve and cancel send the right request; grouped citations. |

## What I would do differently

- **Persist the agent trace per message.** Today the steps live in `tool_calls`, joined to a message only through the conversation. A `messageId` on each row would make the admin conversation view show "how this answer was made".
- **Resume after approval.** An approved ticket gets a fixed confirmation message. Feeding the result back into the agent would let it write a natural follow-up, at the cost of another model call per approval.
- **Cost of the agent shape.** The old pipeline refused a hopeless question without any model call. The agent spends at least the classifier call plus one strong call before it can search. The classifier keeps small talk cheap, but a cache of recent question embeddings, so the floor can be checked before the model, would win back most of the saving.
- **Evals before more tools.** Tool selection is unit-tested with a scripted model. Whether a real model picks the right tool is a Phase 3 question, and it needs a golden set.
