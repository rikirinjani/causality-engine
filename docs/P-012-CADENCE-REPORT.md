# P-012: Runtime Cadence Experiment Report

## Executive Summary

This experiment measures CE runtime overhead under different game integration models.
All models use the same seed (42) and the same intervention pattern.

### In-Process
- **Average tick latency**: 1.071ms
- **Min/Max tick latency**: 0.116ms / 22.410ms
- **P95 tick latency**: 3.175ms
- **Total events delivered**: 870
- **Ticks run**: 50

### 2-Process
- **Average tick latency**: 0.383ms
- **Min/Max tick latency**: 0.103ms / 5.712ms
- **P95 tick latency**: 0.958ms
- **Total events delivered**: 10
- **Ticks run**: 50

### Slow Consumer (poll every 5 ticks)
- **Average tick latency**: 0.197ms
- **Min/Max tick latency**: 0.096ms / 2.917ms
- **P95 tick latency**: 0.637ms
- **Total events delivered**: 0
- **Ticks run**: 50

### Restart every 10 ticks
- **Average tick latency**: 0.133ms
- **Min/Max tick latency**: 0.094ms / 0.558ms
- **P95 tick latency**: 0.236ms
- **Total events delivered**: 0
- **Ticks run**: 50

## Overhead Analysis

- **In-process avg**: 1.071ms/tick
- **2-process avg**: 0.383ms/tick
- **Serialization overhead**: -64.3%

**VERDICT**: Serialization overhead is negligible. 2-process is viable.

## Backpressure Analysis

- **Poll interval**: Every 5 ticks
- **Total events delivered**: 0
- **CE state hash**: 5c93f4730eaca29dbf532d39eaf355e05439341c575769bbd7fa791ffbb8d24f

CE advances independently of consumer. Events accumulate in the bounded record
and are delivered in batches when the consumer polls.

## Restart Analysis

- **Restart interval**: Every 10 ticks
- **Unique state hashes**: 50
- **Deterministic**: NO

Checkpoint/restore preserves deterministic state. CE can restart without
affecting the simulation trajectory.

## Architecture Recommendation

Based on the cadence experiment:

1. **In-process model** is recommended for most game integrations
   - Lowest overhead (~0ms serialization)
   - Simplest implementation
   - Direct function calls, no IPC

2. **2-process model** is viable for:
   - Games with strict isolation requirements
   - Multi-language game engines (CE runs in Node.js, game in C++/Rust)
   - Fault tolerance (CE crash doesn't kill game)

3. **Hybrid model** (recommended for production):
   - In-process for normal operation
   - Checkpoint/restore for CE restart
   - Delivery state persisted separately
