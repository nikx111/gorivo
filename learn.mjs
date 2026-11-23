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
