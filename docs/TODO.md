# CE TODO

Living list of open work items. Completed items move to the bottom archive.

---

## Distribution

### [ ] Godot Asset Store — await review
- Submitted 2026-09-16 on store.godotengine.org (beta), pending moderator review.
- On approval: use the store URL as the primary install link in all promotion posts.

### [ ] Promotion posts for testers (store approval not required for these)
- r/godot — lead with the explanation-panel GIF ("why did grain price rise?"), CTA: `npm install causality-engine` + store link once approved.
- r/gameenginedevs — architecture angle: provenance/explain(), authority boundary, determinism story.
- TIGSource playtesting board — bounded ask: "break the world, tell me if the explanations make sense."
- itch.io page for the browser demo — zero-friction tester funnel, link from all posts.

### [ ] Unity integration (second engine target)
- Priority over Unreal: bigger sim-game dev population, C#/WebSocket is trivial.
- Scope: mirror the Godot addon (~700 lines transport + projection). `CeClient` MonoBehaviour, JSON parse, C# events. Same authority boundary — no RNG, no causal rules in the plugin.
- Trigger: after Godot store listing shows traction, or on explicit tester demand.

### [ ] Unreal Engine integration (third engine target)
- Do NOT start before Unity. Unreal's indie sim crowd is smaller.
- Preferred shape: UE C++ WebSocket client plugin mirroring the Godot addon (`CeClient` actor, JSON, delegates), or CE as a sidecar next to the UE dedicated server (fits server-authoritative model).
- Trigger: explicit tester demand or Unity integration complete.

### [ ] 1.0.0 final release decision
- npm blocker cleared (rc.1 published). Remaining precondition: independent developer validation.
- Brief ready at `docs/INDEPENDENT-VALIDATION-BRIEF.md` — needs a human to recruit a tester.

---

## Archive (completed)

- [x] P-028 persistence resurrection — 13/13 PASS on VX1 Linux + Windows instance, cross-host checkpoint transfer byte-identical both directions, 0 engine defects. Report: `docs/P-028-REPORT.md`.
- [x] npm publication — `causality-engine@1.0.0-rc.1` live, smoke-tested from fresh project with hash parity vs local dist.
- [x] Godot Asset Store submission — addon zip rebuilt with fixed README link, thumbnail from real engine screenshot, AI disclosure, submitted for review 2026-09-16.