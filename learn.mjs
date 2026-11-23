// Учене от собствените грешки: всяка прогноза се записва „сурова“ (както я дава моделът) и когато денят дойде,
// се сравнява с реалната средна цена от Fuelo. От тези двойки се смятат две поправки за всяко гориво:
//   скорост s: колко от предвидената промяна реално се случва (1 = точно, 0,5 = цените се движат наполовина по-бавно)
//   отместване c[h]: системна грешка нагоре или надолу за прогнозата h дни напред
// Поправките се свиват към „без поправка“, докато има малко данни, и се ограничават, за да не избягат.
// Новите грешки тежат повече (полуживот 14 дни), защото пазарът се мени.

export const HORIZONS = 5;
const HALF_LIFE = 14, MAX_ROWS = 60;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// rows: [{ made, target, fuel, base, raw, pred }], actual(fuel, date) -> цена или undefined
export function pairs(rows, actual, fuel, today) {
  return rows
    .filter((r) => r.fuel === fuel && Number.isFinite(r.raw) && r.target <= today)
    .map((r) => ({ ...r, h: days(r.made, r.target), act: actual(fuel, r.target) }))
    .filter((r) => r.act != null && r.h >= 1 && r.h <= HORIZONS)
    .sort((a, b) => b.target.localeCompare(a.target))
    .slice(0, MAX_ROWS * HORIZONS);
}

export function learn(rows, actual, fuel, today) {
  const ps = pairs(rows, actual, fuel, today);
  const w = (r) => 0.5 ** (days(r.target, today) / HALF_LIFE);
  // Скорост: претеглени най-малки квадрати на реалната спрямо предвидената промяна, свити към 1
  let sxy = 0, sxx = 0, n1 = 0;
  for (const r of ps) {
    const x = r.raw - r.base, y = r.act - r.base;
    if (Math.abs(x) < 0.002) continue; // без предвидена промяна няма какво да се мери
    sxy += w(r) * x * y; sxx += w(r) * x * x; n1++;
  }
  const sRaw = sxx > 0 ? sxy / sxx : 1;
  const s = clamp(1 + (sRaw - 1) * (n1 / (n1 + 20)), 0.3, 2);
  // Отместване по хоризонт върху грешката след поправката на скоростта, свито към 0
  const bias = [], corr = [], count = [];
  for (let h = 1; h <= HORIZONS; h++) {
    const hs = ps.filter((r) => r.h === h);
    let se = 0, sw = 0;
    for (const r of hs) { const e = r.base + (r.raw - r.base) * s - r.act; se += w(r) * e; sw += w(r); }
    const b = sw ? se / sw : 0;
    bias.push(b); count.push(hs.length);
    corr.push(clamp(-b * (hs.length / (hs.length + 5)), -0.03, 0.03) || 0);
  }
  return { s, sRaw, n: n1, bias, corr, count };
}

// Прилага поправките към сурова прогноза h дни напред
export const apply = (L, base, raw, h) => base + (raw - base) * L.s + (L.corr[h - 1] || 0);

// Реална точност: средна грешка, сравнение с „няма промяна“ и позната посока, по хоризонт
export function accuracy(rows, actual, fuel, today) {
  const ps = pairs(rows, actual, fuel, today), out = [];
  for (let h = 1; h <= HORIZONS; h++) {
    const hs = ps.filter((r) => r.h === h && Number.isFinite(r.pred));
    const moved = hs.filter((r) => Math.abs(r.act - r.base) >= 0.005);
    out.push({
      h, n: hs.length,
      mae: hs.length ? hs.reduce((a, r) => a + Math.abs(r.pred - r.act), 0) / hs.length : null,
      maeRaw: hs.length ? hs.reduce((a, r) => a + Math.abs(r.raw - r.act), 0) / hs.length : null,
      naive: hs.length ? hs.reduce((a, r) => a + Math.abs(r.base - r.act), 0) / hs.length : null,
      direction: moved.length ? moved.filter((r) => Math.sign(r.pred - r.base) === Math.sign(r.act - r.base)).length / moved.length : null,
      directionN: moved.length,
    });
  }
  return out;
}

// --- Диапазон: колко може да се разминава прогнозата h дни напред ---
// Начало: грешката от проверката на модела върху 2 години (80% от седмиците са в ±q80), разпределена по дни
// като √(h/7). Щом има реални проверени прогнози, тяхната грешка постепенно заема мястото ѝ.
const quantile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
export function band(rows, actual, fuel, today, h, q80Week) {
  const prior = Math.max(0.005, (q80Week ?? 0.015) * Math.sqrt(h / 7));
  const errs = pairs(rows, actual, fuel, today).filter((r) => r.h === h && Number.isFinite(r.pred)).map((r) => Math.abs(r.pred - r.act));
  const live = quantile(errs, 0.8), n = errs.length;
  return Math.max(0.005, live == null ? prior : (prior * 10 + live * n) / (10 + n));
}

// --- Дни от седмицата и празници ---
// Някои дни цените се сменят по-често. От дневната история на средната цена се смята средната промяна
// за всеки ден от седмицата (и за празник) спрямо обичайната. Свива се към 0, докато има малко седмици.
// Официални празници в България; Великден е по православния календар
const HOLIDAYS = new Set([
  '2026-01-01', '2026-03-03', '2026-04-10', '2026-04-11', '2026-04-12', '2026-04-13', '2026-05-01', '2026-05-06', '2026-05-24', '2026-09-06', '2026-09-22', '2026-12-24', '2026-12-25', '2026-12-26',
  '2027-01-01', '2027-03-03', '2027-04-30', '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-06', '2027-05-24', '2027-09-06', '2027-09-22', '2027-12-24', '2027-12-25', '2027-12-26',
]);
export const dayKind = (d) => (HOLIDAYS.has(d) ? 7 : new Date(d + 'T12:00:00Z').getUTCDay());
export const DAY_NAMES = ['неделя', 'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота', 'празник'];

// series: [[date, price]] за едно гориво, по дни
export function weekdays(series) {
  const s = [...series].sort((a, b) => a[0].localeCompare(b[0])), ch = [];
  for (let i = 1; i < s.length; i++) if (days(s[i - 1][0], s[i][0]) === 1) ch.push([dayKind(s[i][0]), s[i][1] - s[i - 1][1]]);
  const mean = ch.length ? ch.reduce((a, c) => a + c[1], 0) / ch.length : 0;
  const eff = [], n = [];
  for (let k = 0; k < 8; k++) {
    const v = ch.filter((c) => c[0] === k).map((c) => c[1] - mean);
    n.push(v.length);
    eff.push(v.length ? clamp((v.reduce((a, x) => a + x, 0) / v.length) * (v.length / (v.length + 4)), -0.01, 0.01) || 0 : 0);
  }
  return { eff, n, weeks: Math.floor(ch.length / 7) };
}
// Натрупаният ефект на дните от утре до h дни напред
export const weekdayShift = (W, from, h) => {
  let s = 0;
  for (let k = 1; k <= h; k++) s += W.eff[dayKind(new Date(Date.parse(from + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10))];
  return s;
};
