# Findings

- Current correct checkout is ai-reliability-implementation, branch starts637c7a2. User explicitly authorized implementation and real verification after the failed storyboard acceptance.
- Existing durable tasks already enforce source/model identity, idempotency, independent lifecycle, checkpoints and save gate. Reuse these as sole persistence authority, no second graph checkpointer.
- Real failures were node output defects (wrong scene_direction keys, then unescaped quotes); no directing review occurred. LangGraph alone cannot resolve output correctness.
- Short12s/2shot scene currently uses monolithic controlled_storyboard; split all new planning into compact outline + small expansion batches, preserving complete validated stages.
- Selected official npm LangGraph1.7.4/core1.3.4; Node22 compatible, peerZod4 supported. Must explicitly suppress automatic LangSmith tracing while Langfuse remains business trace destination.
- New structure repair is opt-in for storyboard contracts, stays within existing two format rounds and3actual attempts per step. Model supplies values for fixed app-selected targets; whole schema and business validation still required.
- Task budget persists aggregate usage and elapsed active time; resume retains counters, bounded explicit allowance only after budget exhaustion; no automatic model/provider changes.
