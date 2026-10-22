# PastTheEyeTest 2027 projections: every formula

This is the complete recipe behind the 2027 projected hitter and pitcher cards and the 2027 Ranges tab, in the order the build applies it. Every constant listed is the value the build uses (`build_projections.py`, `build_pitcher_projections.py`, `build_iswing_history.py`). Fitted values such as weights, $k$, aging, $\beta$ and band edges come out of the notebook's tables (`tables/*_model.csv` and the others).

**Notation**

| Symbol | Meaning |
|---|---|
| $T$ | the season being projected (2027) |
| $x_{s}$ | the player's value of a stat in season $s$ |
| $n_{s}$ | his sample in that season, in the stat's own unit (PA, BIP, swings, BF, IP or pitches) |
| $\bar{x}_{s}$ | the league average in season $s$ |
| $j$ | seasons back: $j=1$ is last season, $s = T-j$ |

---

## 1. Inputs

**Season age.** A player's age on June 30 of the season:

$$\text{age}_s = s - \text{birth year} - \mathbb{1}[\text{birthday after June 30}]$$

Pitcher ages are clamped to the range 22–37 before they enter the model.

**Sample size per stat.** Each stat uses the first of its preferred sample sizes that is filled on at least 90% of that stat's rows:

| Group | Stats | Sample size |
|---|---|---|
| Hitters | xSLG, Chase %, K%, BB% | PA |
| Hitters | xwOBACON, EV stats, Barrel %, LA+SwtSpt% | BIP, else PA |
| Hitters | bat tracking, Z-Contact%, Whiff % | swings, else PA |
| Hitters | xRV/600 and its parts | xRV PA |
| Pitchers | SIERA, FIP, Avg FB Velo | IP |
| Pitchers | all other card stats | BF, else IP |
| Pitchers | Stuff+, Location+, Tunnel+, Pitch+, model residual | pitches |

**League average** for each season is the sample-weighted mean:

$$\bar{x}_s = \frac{\sum_i n_{i,s}\, x_{i,s}}{\sum_i n_{i,s}}$$

**Which seasons train the model.** A player-season counts as a training target only if:
- its sample meets the minimum:

  | Sample | Minimum |
  |---|---|
  | PA | 100 |
  | BIP | 60 |
  | swings | 150 |
  | BF | 100 |
  | IP | 20 |
  | pitches | 300 |

- it is not 2020. The 60-game season is used as an input to later projections, never as a target.

---

## 2. The base projection: learned Marcel

$$\boxed{\;\hat{x}_T \;=\; \bar{x}_{T-1} \;+\; \frac{\sum_{j=1}^{J} w_j\, n_{T-j}\,\big(x_{T-j} - \bar{x}_{T-j}\big)}{\sum_{j=1}^{J} w_j\, n_{T-j} \;+\; k} \;+\; a_1(\text{age}_T - 28) + a_2(\text{age}_T - 28)^2\;}$$

- **League-relative values.** Each past season enters as the gap from *that season's* league average, $x_{T-j}-\bar{x}_{T-j}$. Old seasons are therefore not distorted by league-wide changes such as juiced balls or K-rate inflation. The result is re-anchored to last season's league average $\bar{x}_{T-1}$.
- **Lookback.** $J = \min(5,\ \text{seasons available} - 1)$.
- **Season weights.** Last season has $w_1 = 1$. Each older season's weight is the previous one times a factor between 0 and 1:

  $$w_j = w_{j-1}\, d_j,\qquad 0 \le d_j \le 1$$

  So an older season can never count more than a newer one.
- **Regression constant** $k > 0$, in the stat's own sample units. A season of sample $n$ keeps $\dfrac{n}{n+k}$ of the player's gap from average, and the rest goes to the league average. When $n = k$, the projection is half his record and half league average.
- **Aging.** A quadratic around age 28, fitted jointly with the weights so the weights don't absorb aging. The peak age is $28 - a_1/(2a_2)$ when $a_2 < 0$.

**History weight.** Used again in §6 and §7:

$$H = \sum_{j} w_j\, n_{T-j}$$

### Fitting $d_2,\dots,d_J,\ \log k,\ a_1,\ a_2$
The parameters are fit by bounded nonlinear least squares (trust-region reflective):
- $d_j \in [0,1]$
- $k \in [10^{-3}, 10^{6}]$, searched on the log scale and started at the median sample size
- $a_1, a_2$ free

$$\min \;\sum_{i} \frac{n_{i,T}}{\bar{n}}\big(\hat{x}_{i,T}-x_{i,T}\big)^2 \;+\; \sum_{j=2}^{J}\Big(\frac{\lambda}{\sqrt{\text{seen}_j}}\,(d_j - d_j^{0})\,\mathrm{sd}(y)\Big)^2$$

- Each target is weighted by its own sample size, relative to the mean sample $\bar{n}$.
- **Light anchor.** The penalty term pulls the decay toward Marcel's 5/4/3/2/1 shape: $d^0 = (0.8, 0.75, 0.667, 0.5)$, which gives weights 1, .8, .6, .4, .2.
  - $\lambda = 0.02\sqrt{N_\text{rows}}$.
  - $\text{seen}_j$ is the share of rows that actually have a season $j$ back (at least 0.02). Rarely seen lags are anchored more firmly.

The final 2027 fit uses every season. Each stat is fit separately, so hitters get 15 card stats plus 14 xRV stats, and pitchers get 14 card stats plus the four grades.

---

## 3. Model layers (only where a backtest earns them)

A layer stacks projected model grades on top of the base projection. Everything here is relative to league average, with no intercept:

$$\hat{x}^{\text{rel}}_T = c_0\, \hat{x}^{\text{rel}}_{\text{base}} + \sum_m c_m\, \hat{s}^{\text{rel}}_m$$

The coefficients $c$ come from sample-weighted least squares. Each signal $\hat{s}_m$ is itself projected with its own learned weights, $k$ and aging (§2).

**Hitter layers**

| Layer | Eligible stats | Signals |
|---|---|---|
| iSwing+ | xSLG, xwOBACON, Avg EV, 90th % EV, Barrel %, Blasts/Contact, LA+SwtSpt%, Contact Quality, xRV/600 | projected lean iSwing+ |
| swing residual | xwOBACON only | projected swing-expected xwOBAcon, plus his regressed "beats his swing" residual (centered on 0) |

**Pitcher layers**

| Layer | Eligible stats | Signals |
|---|---|---|
| grades | any card stat | projected Stuff+, Location+, Tunnel+, Pitch+ |
| stuff | any card stat | projected Stuff+ alone |
| model residual | SIERA, FIP, xwOBA, xBA, xSLG, Barrel%, Avg EV | projected Pitch+, plus his regressed "beats his pitch model" residual |

**Selection.** For each candidate, leave-one-season-out error is computed on the same rows that every candidate can score. A layer is used only if

$$\text{RMSE}_\text{layer} < 0.998 \times \text{RMSE}_\text{base}$$

that is, it must cut error by at least 0.2%. Otherwise the stat stays on the base model.

### iSwing+ (lean), walk-forward
- **Model.** An XGBoost model predicts each contact swing's xwOBAcon from 10 swing features, with no hitter identity. Settings: 800 trees, depth 7, learning rate 0.03, early stopping on a 15% hold-out of batters.
- **Walk-forward.** Season $Y$ is scored by a model trained only on seasons before $Y$.
- **Score.** A batter's season value is his mean predicted xwOBAcon, $r$, put on a 100/15 scale using hitters with at least 100 swings:

$$\text{iSwing+} = 100 + 15\cdot\frac{\ln r - \text{mean}(\ln r)}{\text{sd}(\ln r)}$$

- **Swing residual:**

$$\text{resid} = \overline{\text{xwOBAcon}}_\text{actual} - \overline{\text{xwOBAcon}}_\text{predicted}$$

The swing features, with plate location $(p_x, p_z)$ in feet. $\mathrm{AA}$ is attack angle and $\mathrm{AD}$ is attack direction.

| Feature | Formula |
|---|---|
| bat speed, swing length | as measured |
| speed over expected | bat speed − that season's mean bat speed in his 0.2-ft horizontal location bin |
| speed vs location | $\text{bat speed}\cdot\big(1 + 0.3\sqrt{p_x^2 + (p_z-2.5)^2}\big)$ |
| attack angle vs optimal | $-\lvert \mathrm{AA} - \mathrm{clip}(3(p_z-1)^2 + 7,\,5,\,30)\rvert$, with $p_z$ clipped to 1–4 |
| attack angle adjustment | same, with height normalized to his strike zone: $h = \frac{p_z - \text{zone bottom}}{\text{zone top} - \text{zone bottom}}$, ideal $\mathrm{clip}(3(1.85h)^2 + 7,\,5,\,30)$ |
| tilt for height | $-\lvert \text{tilt} - \mathrm{clip}(58 - 10p_z,\,20,\,48)\rvert$ |
| direction from optimal | $-\lvert \mathrm{AD}' - \mathrm{clip}(20p_x',\,-18,\,18)\rvert$, with $\mathrm{AD}'$ and $p_x'$ mirrored for righties |
| length for location | $-\big(\text{swing length} - (7.3 + 0.3p_x)\big)$ |
| effort level | bat speed ÷ his own 90th-percentile bat speed that season |

### Pitch-model residual (pitchers)

$$\text{model\_resid} = \text{rv} + \text{xRV}$$

Both terms are per 100 pitches, from the pitch-model season files. The sum is the pitcher's actual run value minus what the model expected from his pitches, so a positive value means he beats his stuff. It is projected like any other stat (§2), centered on 0.

---

## 4. The lean correction ("regress toward players like him")

Marcel regresses everyone toward the playing-time-weighted league average, which is mostly regulars. Players with thin histories are worse on average, so they were projected too high. The correction is:

$$\hat{x}_T \;\leftarrow\; \hat{x}_T + \beta\,\frac{k}{H + k}$$

The term is largest for the thinnest history and about 0 for a long full-time career.

- **Fitting $\beta$.** With $u = \frac{k}{H+k}$ and backtest misses $e = x - \hat{x}$ (§7, step 1), $\beta = \dfrac{\sum u\,e}{\sum u^2}$.
- **Walk-forward test.** For each backtest season after the second, $\beta$ is fit on the earlier seasons only and scored on that season.
- **Kept only if** it lowers RMSE in at least $\max(2, \lceil \tfrac{2}{3}\,\text{tests}\rceil)$ of the tests. It needs at least 3 backtest seasons, so xRV and bat-tracking stats are never corrected.
- **Re-centering.** When kept, the interval misses in §7 are re-centered on the corrected projection.

---

## 5. Making the card add up

**xRV components** must sum to the projected total, as they do on actual cards. Each group's gap is shared out in proportion to each component's last-season variance $v_c$:

$$x_c \leftarrow x_c + (\text{goal} - \textstyle\sum x)\,\dfrac{v_c}{\sum v}$$

| Components | Must sum to |
|---|---|
| Contact Quality + Whiff + Decision | xRV/600 |
| Fastball + Breaking + Offspeed | xRV/600 − other pitch types |
| Inner + Middle + Outer | xRV/600 − Chase |
| Upper + Middle + Lower | xRV/600 − Chase |

**Pitchers:** $\text{K-BB\%} = \text{K\%} - \text{BB\%}$, so it agrees with the two numbers beside it.

**"Show" views.** Each projection splits into three parts that add up:

| Part | Definition |
|---|---|
| history | $\bar{x}_{T-1} + \frac{\sum w_j n_{T-j}(x_{T-j}-\bar{x}_{T-j})}{\sum w_j n_{T-j}+k} + \beta\frac{k}{H+k}$ |
| age | $a_1(\text{age}-28) + a_2(\text{age}-28)^2$ |
| model | final − history − age, i.e. whatever a layer or reconciliation added |

---

## 6. Percentiles on the projected cards

A projection is ranked against last season's actual qualified players, so a 95 means the same thing on actual and projected cards:

$$\text{pct} = 100\cdot\frac{\#\{\text{pool} < \hat{x}\}}{\#\text{pool}}\quad(\text{flipped to } 100 - \text{pct for lower-is-better stats})$$

| Pool | Qualifier |
|---|---|
| hitters | 2026 with ≥100 PA (xRV: ≥100 xRV PA) |
| pitchers | 2026 with ≥10 IP |
| pitch grades | 2026 with ≥200 pitches |
| iSwing+ | ≥100 swings |

**Who gets a projection:**
- **Hitters:** ≥200 PA over 2024–26 and active in 2025 or 2026.
- **Pitchers:** ≥40 IP over 2024–26 and active in 2025 or 2026.

---

## 7. The 2027 ranges (confidence intervals)

The ranges are learned from the model's own past misses. There is no bell-curve assumption.

**Step 1: backtest misses.**
- For each of up to the last 6 target seasons $S$, the model is fit only on seasons before $S$. Seasons whose training contains fewer than 2 target seasons are skipped.
- Every projectable player in $S$ is kept.
- Rates (stats with % in the name, and Blasts/Contact) are measured on the logit scale. A 5% K-rate's range is then proportional to its level and stays between 0 and 100%:

$$g(v) = \ln\frac{v/c}{1 - v/c}\ \ (c = 1 \text{ or } 100,\ \text{clipped to } [10^{-4},\,1-10^{-4}]),\qquad g(v)=v \text{ otherwise}$$

$$\text{miss} = g(x_S) - g(\hat{x}_S)$$

**Step 2: spread per player.**

$$\sigma^2 = c_0 + \frac{a}{H + k} + \frac{b}{n},\qquad c_0, a, b \ge 0 \ \ (\text{non-negative least squares on miss}^2)$$

| Term | Meaning |
|---|---|
| $c_0$ | the floor no track record removes |
| $a/(H+k)$ | uncertainty about true talent, which shrinks with a longer, fuller history |
| $b/n$ | one season of luck at sample $n$ |

**Step 3: edges, out of season.**
- Each backtest season's misses are standardized by a spread fit on the **other** seasons:

$$z = \frac{\text{miss}}{\sigma_{\text{other seasons}}}$$

  Year-to-year league drift is therefore inside the band.
- The band edges are the empirical quantiles $q_p$ of $z$ at $p$ = 5, 10, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 90 and 95%. Skewed or fat-tailed misses stay that way.

**Step 4: 2027 playing time.** No playing-time projection exists, so the luck term uses recent playing time:

$$n = \mathrm{clip}\!\left(\frac{w_1 n_{T-1} + w_2 n_{T-2}}{w_1 + w_2},\ n_\text{min},\ n_\text{full}\right)$$

- $n_\text{min}$ is the stat's minimum sample (§1).
- $n_\text{full}$ is the 90th percentile of last season's qualified samples.

**Step 5: the range.**

$$x_p = g^{-1}\!\big(g(\hat{x}_T) + \sigma\, q_p\big)\qquad(\text{floored at 0 for stats that can't be negative})$$

**What gets drawn.**
- **Bands.** The tab draws the nested central bands 90% ($x_5$–$x_{95}$), 75% ($x_{12.5}$–$x_{87.5}$), 50% ($x_{25}$–$x_{75}$) and 25% ($x_{37.5}$–$x_{62.5}$).
- **Listed outcomes.** It lists the 10th, 25th, 50th, 75th and 90th percentile outcomes.

**Drift widening.**
- **Applies to:** stats with only one backtest season (bat tracking, xRV), whose bands can't see season-to-season drift on their own.
- **Factor:** the median ratio of out-of-season to in-sample 90% band width across stats with ≥3 backtest seasons, never below 1.
- **On the real history** the ratio is about 1.00, so in practice nothing is widened.

**Calibration check.** For each backtest season, bands are fit (spread *and* edges) on the other seasons only, and the build counts the share of actual outcomes inside each band. Honest bands land near 90 / 75 / 50 / 25%.

---

## 8. The Ranges-tab axis

Every stat goes on one common axis: standard deviations from last season's league average, with better to the right:

$$z(v) = \mathrm{clip}\!\left(\pm\frac{v - m}{s},\ -3.5,\ 3.5\right)$$

- $m$ and $s$ are the mean and sample SD ($n-1$) of last season's qualified pool (§6).
- The sign is − for lower-is-better stats.
- The shaded strip is $\pm 1$ SD.

---

## 9. How the model is validated (what the notebook reproduces)

| Check | How |
|---|---|
| **Walk-forward accuracy** | Each of the last 3 target seasons is projected from earlier seasons only. Methods are compared on the same players, those who have a last season, by sample-weighted RMSE $\sqrt{\sum n(\hat{x}-x)^2/\sum n}$. The baselines are league average, last season's value, and Marcel with fixed weights 1/.8/.6/.4/.2 (with $k$ still fitted). |
| **Regression vs stickiness** | The year-to-year correlation $r$, for players meeting the minimum in both seasons, should track $n/(n+k)$ at the typical sample $n$. |
| **Layers** | Leave-one-season-out RMSE, base vs each layer (§3). |
| **Lean correction** | Walk-forward wins out of tests; RMSE before → after (§4). |
| **Spread model** | Predicted $\sigma$ vs the observed RMS miss, binned. They should lie on the diagonal. |
| **Range calibration** | Out-of-season coverage per band and per season (§7). |
