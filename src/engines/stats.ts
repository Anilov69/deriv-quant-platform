/** Shared statistical primitives used by every engine. Pure functions, no I/O. */

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample standard deviation (n − 1 denominator). Returns 0 for n < 2. */
export function std(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / (n - 1));
}

/** Standard normal CDF Φ(z) via the Abramowitz–Stegun 7.1.26 erf approximation (|ε| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Two-sided p-value for a z statistic: p = 2·(1 − Φ(|z|)). */
export function twoSidedP(z: number): number {
  return 2 * (1 - normCdf(Math.abs(z)));
}

/**
 * Binomial z-score of observing k successes in n trials when the null success
 * probability is p:  Z = (k − n·p) / √(n·p·(1 − p)).
 */
export function binomialZ(k: number, n: number, p: number): number {
  if (n === 0 || p <= 0 || p >= 1) return 0;
  return (k - n * p) / Math.sqrt(n * p * (1 - p));
}

/** ln Γ(x) via Lanczos (g = 7, n = 9). */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised lower incomplete gamma P(a, x) (series for x < a+1, continued fraction otherwise). */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let del = sum;
    for (let n = 1; n < 500; n++) {
      del *= x / (a + n);
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  // Lentz continued fraction for Q(a, x)
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c;
    if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Upper-tail p-value of a χ² statistic with `df` degrees of freedom: P(X ≥ x) = 1 − P(df/2, x/2). */
export function chiSquarePValue(x: number, df: number): number {
  if (x <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - gammaP(df / 2, x / 2)));
}

/**
 * Pearson χ² goodness-of-fit against a uniform distribution over the bins:
 *   χ² = Σ (Oᵢ − Eᵢ)² / Eᵢ,  Eᵢ = n / bins,  df = bins − 1.
 */
export function chiSquareUniform(counts: number[]): { chi2: number; df: number; pValue: number } {
  const n = counts.reduce((a, b) => a + b, 0);
  const df = counts.length - 1;
  if (n === 0) return { chi2: 0, df, pValue: 1 };
  const e = n / counts.length;
  let chi2 = 0;
  for (const o of counts) chi2 += ((o - e) * (o - e)) / e;
  return { chi2, df, pValue: chiSquarePValue(chi2, df) };
}

/**
 * Bayesian shrinkage of an empirical win-rate toward its theoretical value.
 * With a Beta(α·p₀, α·(1−p₀)) prior, the posterior mean after k wins in n trials is
 *   p̂ = (k + α·p₀) / (n + α).
 * α ("prior strength", in pseudo-trials) stops tiny samples from producing
 * fake edges: with n ≪ α the estimate stays close to p₀.
 */
export function shrunkProbability(k: number, n: number, p0: number, alpha: number): number {
  if (n + alpha <= 0) return p0;
  return (k + alpha * p0) / (n + alpha);
}

/** Lag-1 autocorrelation ρ(1) = Σ(xₜ−x̄)(xₜ₋₁−x̄) / Σ(xₜ−x̄)². */
export function autocorr1(xs: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  const m = mean(xs);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    den += d * d;
    if (i > 0) num += d * (xs[i - 1] - m);
  }
  return den === 0 ? 0 : num / den;
}

/** Number of decimals implied by a pip size (0.01 → 2) or passed through if already a decimal count. */
export function decimalsFromPip(pip: number | undefined): number {
  if (pip === undefined || !isFinite(pip)) return 2;
  if (pip >= 1 && Number.isInteger(pip)) return pip; // ticks_history returns decimal count
  return Math.max(0, Math.round(-Math.log10(pip)));
}

/**
 * Last decimal digit of a quote. Deriv settles digit contracts on the quote
 * formatted to the symbol's pip precision, so trailing zeros count
 * (4853.1 on a 3-decimal index is "4853.100" → digit 0).
 */
export function lastDigit(quote: number, decimals: number): number {
  const s = quote.toFixed(decimals);
  return Number(s[s.length - 1]);
}

/**
 * Generic conditional back-test over a price series.
 * For every index i where `when(i)` holds, the outcome of a contract bought at
 * tick i is judged by `win(i)` (returning null when the future is not yet known).
 * Returns hit count k and sample size n.
 */
export function conditionalHits(
  len: number,
  when: (i: number) => boolean,
  win: (i: number) => boolean | null,
): { k: number; n: number } {
  let k = 0;
  let n = 0;
  for (let i = 0; i < len; i++) {
    if (!when(i)) continue;
    const w = win(i);
    if (w === null) continue;
    n++;
    if (w) k++;
  }
  return { k, n };
}
