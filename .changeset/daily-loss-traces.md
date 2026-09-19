---
"@luxalgo/prop-firm-sim-core": minor
---

Expose daily-loss boundaries as `dailyFloor` on challenge and funded traces, aligned with each recorded equity value. Days without a daily-loss rule return `null`. Recording does not change simulation outcomes.
