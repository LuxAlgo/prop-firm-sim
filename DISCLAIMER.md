# Disclaimer

**Prop Firm Sim produces simulations, not predictions.**

## What the numbers are

Every output of this project - pass probabilities, expected attempts, expected
cost, expected value, optimal-risk curves - is a **Monte Carlo distribution
under stated assumptions**. The assumptions are echoed inside every result
(`assumptions.flags`), rendered by every interface, and they matter:

- Your future trading is assumed to look like the inputs you gave (a win-rate /
  R-multiple model, or a bootstrap resample of your own past trades). Real
  performance drifts, degrades under pressure, and changes with instruments and
  regimes. **Traders systematically overestimate their win rate** - that is why
  the sensitivity panel exists. Look at it.
- Some rules are recorded but **not simulated** (consistency rules, scaling
  plans, and anything else listed under `flagsNotSimulated`). Where a rule is
  not simulated, your real odds are usually **worse** than the simulation, not
  better.
- Trades are modeled as same-day round trips; intra-trade excursions are not
  modeled, which slightly understates trailing-drawdown risk.

Nothing here is financial advice, an inducement to buy any evaluation, or a
guarantee of passing anything. A positive expected value in a simulation is a
property of the model, not a promise about your account.

## What the dataset is

`data/firms/*.json` is a **community-maintained transcription of publicly
published rules**, with a citation URL and a `lastVerified` date on every
entry. It is data, not endorsement - this project deliberately ships no
rankings, no recommendations, no offers, and no affiliate anything.

Firms change their rules, prices, and payout policies **without notice**.
The firm's own published rules are **always authoritative** over this dataset.
Before paying anyone money, read the firm's current terms yourself, and check
the entry's `lastVerified` date. If you find drift, please
[open a rule-change report](https://github.com/LuxAlgo/prop-firm-sim/issues).

## License

MIT - see [LICENSE](./LICENSE). Provided "as is", without warranty of any kind.
