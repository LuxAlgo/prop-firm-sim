---
"@luxalgo/prop-firm-sim-core": minor
"@luxalgo/prop-firm-sim-mcp": minor
"@luxalgo/prop-firm-sim-cli": patch
---

Funded payout rules gain `payoutCapSchedule` (a cap per payout number, last entry repeating) and `maxPayouts` (the funded account closes after that many payouts, counted as survived rather than blown, flagged as `funded-payout-limit`). Models ladders like Apex's six sequential payout caps. Existing specs are unaffected.
