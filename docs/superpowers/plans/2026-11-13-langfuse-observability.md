# Langfuse Observability Implementation Plan

> **For agentic workers:** Continue the user-authorized implementation in this session with scoped parallel workers and independent review.

**Goal:** Replace pending LangSmith integration with optional Langfuse tracing and a working local self-hosted installation.

**Architecture:** Keep existing observation ownership and reliability behavior. A bounded, asynchronous Langfuse exporter projects only safe metadata into root traces and provider spans; the separate Langfuse deployment stores traces outside the business database. Diagnostics use synthetic data and never call a model.

**Tech Stack:** TypeScript, documented Langfuse v4 OpenTelemetry ingestion API, existing Node tests, Docker Compose.

**Spec:** User request on 2026-11-13: use Langfuse; previous authorization covers implementation, local setup, verification, commit and push.

## Global Constraints

- Preserve retry, cancellation, paid replay barriers, checkpoints, model mappings and product DTOs.
- Default tracing off; no source prompt, script, media, raw error, endpoint, secret, free label or reasoning in exported metadata.
- Bounded queue and timeouts; observability outages cannot fail or delay model dispatch.
- No LangChain or LangGraph migration, paid model call, deployment to a shared server, or restart of the user business service.
- Local config secrets are generated securely, stored ignored with mode 0600 and never printed.

## Review Focus

- Disabled/invalid tracing never contacts the backend.
- Late metrics, duplicate callbacks, concurrent observations and partial ingestion failures preserve ownership.
- Inherited SDK headers, server redirects and arbitrary values cannot expose credentials or content.
- Local deployment uses loopback ports, persistent named volumes and opt-out product telemetry.
- Diagnostics resolve relative config paths from repo root, verify the exact completed root/child and report failure honestly.

### Task 1: Langfuse exporter and observation hooks

**Files:** Replace backend/src/infrastructure/observability/langsmith-tracing.ts and its tests with langfuse-tracing.ts; update observation/server imports, manifests and lock.

**Interfaces:** createLangfuseTracer(config, dependencies), readLangfuseConfig(env), getLangfuseTracer(), flushLangfuseTraces(timeoutMs?) and observation dispatch/metrics/finish remain compatible with existing hooks. status includes lastTraceId and bounded queue counters.

- [x] Verify current stable v4.79.0 OTLP ingestion and observations v2 readback schema.
- [x] Implement metadata-only OTLP root/span mapping with bounded delivery and immutable span completion.
- [x] Verify real SDK wire behavior, no-op/privacy/concurrency/late/failure tests and hook regressions.

### Task 2: Local deployment, diagnostics and guidance

**Files:** infra/langfuse/compose.yaml, backend/scripts/langfuse.ts and tests, scripts/langfuse-local.mjs, .env.example, docs/langfuse-observability.md, manifests and docs index.

- [x] Pin current stable v4.79.0 self-host images from official compose and configure isolated loopback ports, durable volumes and disabled telemetry.
- [x] Generate ignored local credentials/config; supply reproducible start/stop commands with readable error output.
- [x] Implement config check and synthetic write/read smoke, retaining zero model calls.
- [x] Start existing container runtime and verify local deployment if available.

### Task 3: Acceptance and delivery

- [x] Remove active LangSmith scripts/dependency/docs, preserving prior hook work.
- [x] Confirm local trace and child in Langfuse, run unified build and backend regression, independently review.
- [x] Update plan evidence, verify secret exclusion, commit and push codex/langfuse-observability.

## Verified outcome

Langfuse4.79.0 local deployment and OTLP/v2 synthetic acceptance passed. Exporter13/13, diagnostics8/8, deployment tooling6/6, full backend3260/3260 and unified build passed. Independent v4 review found no P1/P2. The business service requires loading the local tracing config on its next normal start; no existing service was restarted.
