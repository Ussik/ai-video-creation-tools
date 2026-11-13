# Findings

- Start from committed reliability implementation `331da2f`; branch `codex/langsmith-observability` in the same explicit implementation checkout. Main remains `2c2b700`.
- User authorized starting LangSmith integration and real-integration preparation. They have no LangSmith account and need setup guidance. No LangSmith key/config detected; never request a key in chat or upload formal project content.
- Official langsmith SDK 0.12.0 offers standalone Client without LangChain. Verify exact SDK behavior before selecting queue, timeout and privacy configuration.
- Existing model-request-observation is the business root with dispatch/metrics callbacks covering text, tools, Gemini, background Responses, media and TTS. Do not add a second task owner or global fetch interception.
- Existing local safeModelMetrics is broader than external-safe metadata: exclude arbitrary labels, endpoints, remote IDs, step text, raw reasons and errors from export. Only fixed enums, numeric diagnostics and opaque correlations may leave the process.
- Background scene planner currently inherits HTTP context whose response ends earlier than generation/review/repair. Give that worker its existing independent observation wrapper without changing domain lifecycle.
- New SDK installation must preserve current per-entry node_modules links; update lock/manifest and provision isolated ignored dependency runtime.

- Official current LangSmith has both project and Agent workspaces. Added official Agent LRN address support with immutable slug ID and one of local/development/staging/production; project selection is mutually exclusive. This does not introduce business agents or LangGraph.
- Standalone SDK 0.12.0 has a generated `Langsmith` HTTP client with explicit silent logger and maxRetries=0; older tracing `Client` has hidden retries and console output. Export uses official run schema and `/runs/batch` with one bounded application queue instead.
- Independent review found the SDK inherits `LANGCHAIN_CUSTOM_HEADERS`. Both exporter and diagnostic readback reconstruct only tracing credential/content headers, enforce exact destination and reject redirects. Real SDK plus mocked fetch tests verify the sensitive environment header never leaves.
- Node 22 rejects `--env-file` inside NODE_OPTIONS. Use `node --env-file=.env.langsmith.local scripts/dev.mjs` explicitly; diagnostic commands load a supplied env path relative to repository root.
- Local preflight command verified disabled/no network and enabled with temporary synthetic config. Cloud smoke requires both write and read permission; a tracing-only key cannot prove readback acceptance.
- Scope and checks complete with no cloud key/account configured. Only synthetic SDK wire tests, temp files and isolated mocked data are used; no paid model or formal project/service mutation.

## User-directed replacement on 2026-11-13
- User selected Langfuse after discussing open-source self-hosted alternatives. All uncommitted LangSmith integration will be replaced; previous reliability base and observation hooks remain.
- Prior full backend 3256/3256 and unified build passed for LangSmith hooks; new exporter requires fresh relevant verification. LangSmith live export failed 3 batches and was paused without claiming cloud success.
- Docker CLI 29.4 is installed with orbstack context, but its daemon socket does not exist. Attempt starting the installed runtime before live self-host acceptance.
- No useful relevant memory hit. No model calls or formal project content are required.

- SDK research selected the documented v3 HTTP ingestion API (no extra SDK/OTel dependency), compatible with pinned self-host Langfuse 3.227.1. Ingestion responses require per-event confirmation, including failures embedded in HTTP 207.
- Application diagnostics now check a completed synthetic root and child via public trace readback; use --config rather than --env-file to avoid tsx argument interception.
- Existing OrbStack started successfully. Existing postgres/mysql/redis/nginx containers observed and preserved; Langfuse must use its own project/network/volumes/loopback ports.

## Official v4 compatibility correction
- First local v3 deployment and synthetic readback passed for root 9a24df5c-14d0-483f-828e-9057d676de82. Full build and backend3260 passed. Browser login succeeded, but UI warned v3 ends security support January2027.
- Refreshed official latest release: stable v4.79.0 published2026-11-12. Upgrade docs require new deployments use default events_only and OTel ingestion; legacy batch ingest gives per-event400 and legacy trace reads404. Existing v3 choice would create early migration work. Switching delivery to v4 and standard OTLP now; initial synthetic verification is superseded and will be repeated.
- Official infra architecture unchanged; recommended ClickHouse26.3.62.3. No business data in local volumes; only one synthetic trace.
- Healthcheck issue identified: Next image binds container HOSTNAME, 127.0.0.1 probe fails while hostnameprobe200. Explicit container HOSTNAME=0.0.0.0 corrects probe while hostport remainsloopback.
- Previous EgoTaskSpace2 no longer exists; inventory only userSpace0. Created one new Langfuse goal Space3, p1. Admin login successful, credentials read directly from ignored file without tool output.

- v4 official source confirms GET/api/public/v2/observations supports traceId plus fields=basic,metadata. Acceptance matches exact exported root span ID, finished root metadata and a finished direct child. Readback excludes io/model/usage fields and strips arbitrary metadata.
- v4 deployment images4.79.0 and ClickHouse26.3.62.3 pin official multiarch digests; deployment upgrade running with existing local generated credentials.

- v4 real acceptance passed: local health version4.79.0, synthetic OTLP write plus observations v2 same exact root/child readback_verified for tracea8b650c0cdad237ea99845306232989b. Browser OSS4.79 login/project/list/rootmetadata succeeded; inputs/outputs empty. Result page left for user, EgoSpace3 finished keep[p1].
- Separate manual diagnostic pull used an incorrectly transcribed ClickHouse digest and returned notfound; no image/container mutation. Actual Compose already pinned correct official digestde3e47c64078aa196dae2349e048fc98ba81947f651f5c20e06e46baea8ae40a and up succeeded.
