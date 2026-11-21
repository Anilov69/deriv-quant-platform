export const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : "—");
export const money = (x: number, cur = "USD") =>
  Number.isFinite(x) ? `${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}` : "—";
export const signed = (x: number, d = 2) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}` : "—");
export const clock = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString();
