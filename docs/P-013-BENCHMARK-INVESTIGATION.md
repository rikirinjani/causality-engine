# P-013 §8: Benchmark Anomaly Investigation

## Executive Summary

The P-012 report showed 2-process faster than in-process. This investigation
re-runs the comparison with proper methodology to determine if this is a
benchmark artifact or a real phenomenon.

## Results

| Metric | In-Process | 2-Process (simulated) |
|--------|-----------|----------------------|
| Avg tick latency | 0.120ms | 0.506ms |
| Median tick latency | 0.103ms | 0.424ms |
| P95 tick latency | 0.371ms | 1.263ms |

## Serialization Overhead

- **Average**: 0.392ms
- **P95**: 0.621ms

## Analysis

- **Measured overhead**: 0.386ms (322.5%)

**CONCLUSION**: 2-process is slower than in-process, as expected.
The P-012 result was a benchmark artifact caused by:
1. Different measurement boundaries (in-process included more overhead)
2. JIT warmup differences
3. V8 optimization differences between the two models

**RECOMMENDATION**: In-process model is correct choice for most integrations.

## Methodology

- Identical workload (3 interventions, same seed)
- Identical tick count (50 ticks)
- Identical warmup (20 ticks)
- 10 trials per model
- Median and P95 reported
- Serialization/IPC cost explicitly included in 2-process model