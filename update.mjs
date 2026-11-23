// Веднъж на ден: цени от Fuelo (България, марки, съседни държави), петрол от Yahoo, оценка за следващите дни.
// Записва данните за таблото в docs/data/ и праща ntfy (ако има NTFY_TOPIC).
//   node update.mjs             всичко
//   node update.mjs --no-ntfy   без известие
// Ключове: от средата или от .env (не се качва): FUELO_API_KEY, NTFY_TOPIC, по желание FINNHUB_API_KEY.
//
// Лимит на Fuelo (безплатен план): 100 заявки на ден и 5 в минута, общо за всички ключове на акаунта.
// Едно пускане прави най-много ~40 заявки. Отговорите се пазят в data/fuelo-cache.json по дата,
// затова второ пускане в същия ден не харчи нищо. Под RESERVE оставащи заявки скриптът спира да пита.
//
// Модел за оценката (прост и обясним):
//   цена на продукта на борсата в евро/литър: бензин от RBOB (RB=F), дизел от ULSD (HO=F); газ следва Brent с тегло 0,35
//   натиск = 1,2 (ДДС) × (средно за последните 3 борсови дни − средно за дни 8–10 назад)
//   бензиностанциите прехвърлят натиска постепенно: след n дни е минал натиск × (1 − (1 − k)^n), k = 1/5,
//   докато data/history.csv събере 20+ дни; после k се смята от реалните промени.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = path.join(here, '.env');
if (existsSync(envFile)) for (const l of readFileSync(envFile, 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const KEY = process.env.FUELO_API_KEY;
if (!KEY) throw new Error('липсва FUELO_API_KEY');
const NO_NTFY = process.argv.includes('--no-ntfy');

const FUELS = [
  { code: 'gasoline', name: 'А95', src: 'RB=F', w: 1, excise: 0.363 },
  { code: 'gasoline98', name: 'А98', alt: 'gasoline98plus', src: 'RB=F', w: 1, excise: 0.363 },
  { code: 'diesel', name: 'Дизел', src: 'HO=F', w: 1, excise: 0.3303 },
  { code: 'dieselplus', name: 'Премиум дизел', src: 'HO=F', w: 1, excise: 0.3303 },
  { code: 'lpg', name: 'Газ', src: 'BZ=F', w: 0.35, excise: 0.0939 },
];
const BRAND_FUELS = ['gasoline', 'gasoline98', 'diesel', 'dieselplus'];
const BRANDS = [{ id: 3, name: 'OMV' }, { id: 4, name: 'Rompetrol' }, { id: 1, name: 'Eko' }, { id: 39, name: 'Бенита' }];
const COUNTRIES = [{ code: 'gr', name: 'Гърция' }, { code: 'ro', name: 'Румъния' }, { code: 'de', name: 'Германия' }];
const K_DEFAULT = 1 / 5, DAYS_AHEAD = 3, RESERVE = 15;
const L_PER_GAL = 3.78541, L_PER_BBL = 158.987;

const sofiaDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
const TODAY = sofiaDate();
const dataDir = path.join(here, 'data'), siteData = path.join(here, 'docs', 'data');
mkdirSync(dataDir, { recursive: true });
mkdirSync(siteData, { recursive: true });
// Fuelo връща последната известна цена, понякога отпреди години: приемаме само цени от последните 7 дни
const fresh = (d) => d && d.price > 0 && (Date.parse(TODAY) - Date.parse(d.date)) / 864e5 <= 7;
const readJson = (f, def) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : def);
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v) + '\n');

// --- Fuelo с кеш, темпо и пазене на дневния лимит ---
const cacheFile = path.join(dataDir, 'fuelo-cache.json');
let cache = readJson(cacheFile, {});
if (cache.date !== TODAY) cache = { date: TODAY, r: {} };
let remaining = Infinity, calls = 0, lastCall = 0;
async function fuelo(p) {
  if (p in cache.r) return cache.r[p];
  if (remaining < RESERVE) return null;
  const wait = lastCall + 12500 - Date.now(); // 5 заявки в минута
  if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
  lastCall = Date.now();
  const r = await fetch('https://api.fuelo.net' + p, { headers: { Authorization: 'Bearer ' + KEY } });
  calls++;
  const rem = r.headers.get('x-ratelimit-remaining');
  if (rem != null) remaining = +rem;
  if (r.status === 429) {
    const body = await r.json().catch(() => ({}));
    if (body.code === 'daily_quota_exceeded') { remaining = 0; return null; }
    await new Promise((ok) => setTimeout(ok, (+r.headers.get('retry-after') || 60) * 1000));
    lastCall = 0;
    return fuelo(p);
  }
  const v = r.ok ? (await r.json()).data : null; // 404 no_data: няма такова гориво
  cache.r[p] = v;
  writeJson(cacheFile, cache);
  return v;
}

// --- Борсови цени от Yahoo (без ключ); при грешка остават последните записани ---
const oilFile = path.join(siteData, 'oil.json');
async function yahoo(sym) {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=2y&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('Yahoo ' + sym + ': ' + r.status);
  const d = (await r.json()).chart.result[0], out = {};
  d.timestamp.forEach((t, i) => {
    const c = d.indicators.quote[0].close[i];
    if (c != null) out[new Date(t * 1000).toISOString().slice(0, 10)] = c;
  });
  return out;
}
const SYMS = { brent: 'BZ=F', wti: 'CL=F', diesel: 'HO=F', gasoline: 'RB=F', eurusd: 'EURUSD=X', eurron: 'EURRON=X' };

// Yahoo сменя BZ=F (и HO=F, RB=F, CL=F) на следващия договор дни преди текущият да изтече, а TradingView (UKOIL)
// и повечето сайтове показват текущия до края. Без поправка цената скача с разликата между двата месеца
// (за Brent 2-3 $), а оценката вижда фалшиво поскъпване или поевтиняване.
// Поправка: в последните 15 дни, където „непрекъснатата“ цена вече е равна на следващия договор,
// а по-ранният още се търгува, слагаме цената на по-ранния.
const MONTHS = 'FGHJKMNQUVXZ';
async function contract(root, y, m) {
  const sym = root + MONTHS[m] + String(y).slice(2) + '.NYM';
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?range=1mo&interval=1d', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const d = (await r.json()).chart.result?.[0];
    if (!d?.timestamp || Date.now() / 1000 - d.meta.regularMarketTime > 4 * 86400) return null; // изтекъл или не се търгува
    const out = {};
    d.timestamp.forEach((t, i) => { const c = d.indicators.quote[0].close[i]; if (c != null) out[new Date(t * 1000).toISOString().slice(0, 10)] = c; });
    return out;
  } catch { return null; }
}
async function fixRoll(root, series) {
  const now = new Date(), tries = [];
  for (let i = 0; i < 4; i++) { const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1)); tries.push(contract(root, t.getUTCFullYear(), t.getUTCMonth())); }
  const live = (await Promise.all(tries)).filter(Boolean);
  if (live.length < 2) return 0;
  const [front, next] = live, from = new Date(Date.now() - 15 * 864e5).toISOString().slice(0, 10);
  let fixed = 0;
  for (const d of Object.keys(series)) {
    if (d < from || front[d] == null || next[d] == null) continue;
    if (Math.abs(series[d] - next[d]) < 0.02 && Math.abs(front[d] - next[d]) >= 0.02) { series[d] = front[d]; fixed++; }
  }
  return fixed;
}

let oil = readJson(oilFile, null);
try {
  const got = Object.fromEntries(await Promise.all(Object.entries(SYMS).map(async ([k, s]) => [k, await yahoo(s)])));
  for (const [k, root] of [['brent', 'BZ'], ['wti', 'CL'], ['diesel', 'HO'], ['gasoline', 'RB']]) {
    const n = await fixRoll(root, got[k]);
    if (n) console.log(k + ': ' + n + ' дни сменени с текущия договор (Yahoo е минал на следващия по-рано)');
  }
  const dates = Object.keys(got.brent).filter((d) => got.eurusd[d]).sort();
  oil = {
    updated: new Date().toISOString(),
    rows: dates.map((d) => [d, ...['brent', 'wti', 'diesel', 'gasoline', 'eurusd', 'eurron'].map((k) => got[k][d] ?? null)]),
    cols: ['date', 'brent', 'wti', 'diesel', 'gasoline', 'eurusd', 'eurron'],
  };
  writeJson(oilFile, oil);
} catch (e) {
  console.log('Yahoo не отговори, ползвам записаните цени:', e.message);
  if (!oil) throw e;
}
const col = (name) => oil.cols.indexOf(name);
const fxLast = oil.rows.at(-1)[col('eurusd')];
const ronLast = [...oil.rows].reverse().find((r) => r[col('eurron')])?.[col('eurron')];

// Цена на продукта в евро/литър по борсови дни
function cost(src) {
  const c = col({ 'RB=F': 'gasoline', 'HO=F': 'diesel', 'BZ=F': 'brent' }[src]);
  return oil.rows.filter((r) => r[c] != null && r[col('eurusd')]).map((r) => (src === 'BZ=F' ? r[c] / L_PER_BBL : r[c] / L_PER_GAL) / r[col('eurusd')]);
}
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
function pressure(f, retail) {
  const v = cost(f.src), n = v.length, now = avg(v.slice(n - 3)), before = avg(v.slice(n - 10, n - 7)), ch = (now - before) / before;
  return { p: f.src === 'BZ=F' ? retail * ch * f.w : 1.2 * (now - before) * f.w, ch: ch * 100, cost: now };
}

// --- История на цените в България (събира се ден по ден, безплатният план няма история) ---
const histFile = path.join(dataDir, 'history.csv');
if (!existsSync(histFile)) writeFileSync(histFile, 'date,fuel,price,min,max,cost,pressure\n');
const hist = readFileSync(histFile, 'utf8').trim().split('\n').slice(1).filter(Boolean).map((l) => {
  const [date, fuel, price, min, max, c, pr] = l.split(',');
  return { date, fuel, price: +price, min: +min, max: +max, cost: +c, pressure: +pr };
});
function fitK(code) {
  const rows = hist.filter((r) => r.fuel === code).sort((a, b) => a.date.localeCompare(b.date));
  let sxy = 0, sxx = 0, n = 0;
  for (let i = 1; i < rows.length; i++) {
    const x = rows[i - 1].pressure, y = rows[i].price - rows[i - 1].price;
    if (Number.isFinite(x) && Number.isFinite(y)) { sxy += x * y; sxx += x * x; n++; }
  }
  return n < 20 || sxx === 0 ? { k: K_DEFAULT, n } : { k: Math.min(1, Math.max(0, sxy / sxx)), n };
}
const upsert = (row) => {
  const i = hist.findIndex((r) => r.date === row.date && r.fuel === row.fuel);
  if (i >= 0) hist[i] = row; else hist.push(row);
};

// --- 1. България: средни цени и оценка ---
const bg = {};
for (const f of FUELS) {
  let d = await fuelo('/v2/prices/average?country=bg&fuel=' + f.code), code = f.code;
  if (!fresh(d) && f.alt) { d = await fuelo('/v2/prices/average?country=bg&fuel=' + f.alt); code = f.alt; }
  if (!fresh(d)) continue;
  const pr = pressure(f, d.price), { k, n } = fitK(f.code);
  const ahead = [];
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const day = sofiaDate(new Date(Date.parse(d.date + 'T12:00:00Z') + i * 864e5));
    ahead.push({ date: day, price: +(d.price + pr.p * (1 - (1 - k) ** i)).toFixed(3) });
  }
  // Разбивка: продукт и акциз са оценки, ДДС е 1/6 от цената, останалото е доставка, складове и печалба
  const vat = d.price / 6, product = f.src === 'BZ=F' ? null : pr.cost;
  bg[f.code] = {
    name: code === f.code ? f.name : 'А98/100', code, price: d.price, min: d.min, max: d.max, date: d.date, k, kDays: n, change: pr.ch, src: f.src, ahead,
    breakdown: product == null ? null : { product, excise: f.excise, vat, margin: d.price - vat - f.excise - product },
  };
  upsert({ date: d.date, fuel: f.code, price: d.price, min: d.min, max: d.max, cost: +pr.cost.toFixed(4), pressure: +pr.p.toFixed(4) });
}

// --- 2. Марки: OMV, Rompetrol, Eko, Бенита ---
const brandNames = readJson(path.join(dataDir, 'brands-bg.json'), null) ?? await (async () => {
  const all = await fuelo('/v2/brands?country=bg');
  const keep = Object.fromEntries((all || []).filter((b) => BRANDS.some((x) => x.id === b.id)).map((b) => [b.id, b.fuel_names]));
  writeJson(path.join(dataDir, 'brands-bg.json'), keep);
  return keep;
})();
const brands = [];
for (const b of BRANDS) {
  const prices = {};
  for (const fc of BRAND_FUELS) {
    let d = await fuelo('/v2/brands/' + b.id + '/prices/average?fuel=' + fc), code = fc;
    if (!fresh(d) && fc === 'gasoline98') { d = await fuelo('/v2/brands/' + b.id + '/prices/average?fuel=gasoline98plus'); code = 'gasoline98plus'; }
    if (!fresh(d)) continue;
    prices[fc] = { price: d.price, date: d.date, code, label: brandNames?.[b.id]?.[code] ?? null };
    upsert({ date: d.date, fuel: b.name + ':' + fc, price: d.price, min: d.min ?? d.price, max: d.max ?? d.price, cost: NaN, pressure: NaN });
  }
  brands.push({ name: b.name, prices });
}

// --- 3. Съседни държави (без оценка), в евро ---
const countries = [];
for (const c of COUNTRIES) {
  const prices = {};
  for (const fc of BRAND_FUELS) {
    let d = await fuelo('/v2/prices/average?country=' + c.code + '&fuel=' + fc), code = fc;
    if (!fresh(d) && fc === 'gasoline98') { d = await fuelo('/v2/prices/average?country=' + c.code + '&fuel=gasoline98plus'); code = 'gasoline98plus'; }
    if (!fresh(d)) continue;
    const eur = d.currency === 'EUR' ? d.price : d.currency === 'RON' && ronLast ? d.price / ronLast : null;
    prices[fc] = { price: eur, local: d.price, currency: d.currency, date: d.date, code };
  }
  countries.push({ code: c.code, name: c.name, prices });
}

writeFileSync(histFile, 'date,fuel,price,min,max,cost,pressure\n' + hist.sort((a, b) => a.date.localeCompare(b.date) || a.fuel.localeCompare(b.fuel))
  .map((r) => [r.date, r.fuel, r.price, r.min, r.max, Number.isFinite(r.cost) ? r.cost : '', Number.isFinite(r.pressure) ? r.pressure : ''].join(',')).join('\n') + '\n');
writeJson(path.join(siteData, 'history.json'), hist.map((r) => [r.date, r.fuel, r.price]));

// BNO (фонд върху Brent) от Finnhub, същият източник като OpenStock: само за сравнение
let bno = null;
if (process.env.FINNHUB_API_KEY) try {
  const r = await fetch('https://finnhub.io/api/v1/quote?symbol=BNO', { headers: { 'X-Finnhub-Token': process.env.FINNHUB_API_KEY } });
  if (r.ok) { const q = await r.json(); bno = { price: q.c, change: q.dp }; }
} catch {}

const brentCh = pressure({ src: 'BZ=F', w: 1 }, 1).ch;
const latest = {
  updated: new Date().toISOString(), date: TODAY, bg, brands, countries, bno,
  oil: { brent: oil.rows.at(-1)[col('brent')], brentWeek: brentCh, eurusd: fxLast, dieselWeek: pressure({ src: 'HO=F', w: 1 }, 1).ch, gasolineWeek: pressure({ src: 'RB=F', w: 1 }, 1).ch },
  fuelo: { calls, remaining: Number.isFinite(remaining) ? remaining : null, limit: 100 },
};
writeJson(path.join(siteData, 'latest.json'), latest);
console.log('Fuelo: ' + calls + ' заявки сега, остават ' + (Number.isFinite(remaining) ? remaining : '?') + ' за днес');

// --- ntfy: веднъж на ден ---
const eur = (x) => x.toFixed(2).replace('.', ',');
const pct = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1).replace('.', ',') + '%';
const arrow = (d) => (d <= -0.005 ? '↓' : d >= 0.005 ? '↑' : '=');
const lines = Object.values(bg).map((f) => f.name + ': ' + eur(f.price) + ' → ~' + eur(f.ahead[0].price) + ' € ' + arrow(f.ahead[0].price - f.price));
const D = bg.diesel, A = bg.gasoline;
const title = 'Горива утре: дизел ' + arrow(D.ahead[0].price - D.price) + ' ~' + eur(D.ahead[0].price) + ' €, А95 ' + arrow(A.ahead[0].price - A.price) + ' ~' + eur(A.ahead[0].price) + ' €';
const body = lines.join('\n') + '\nЗащо: за седмица в евро Brent ' + pct(latest.oil.brentWeek) + ', дизелът на борсата ' + pct(latest.oil.dieselWeek) + ', бензинът ' + pct(latest.oil.gasolineWeek) + '.\nСредни цени по Fuelo. Това е оценка, не обещание.';
console.log('\n' + title + '\n' + body);

const stateFile = path.join(dataDir, 'state.json'), state = readJson(stateFile, {});
const topic = process.env.NTFY_TOPIC;
if (topic && !NO_NTFY && state.ntfy !== TODAY) {
  const headers = { Title: '=?UTF-8?B?' + Buffer.from(title).toString('base64') + '?=', Tags: 'fuelpump', Priority: '3' };
  if (process.env.SITE_URL) headers.Click = process.env.SITE_URL;
  const r = await fetch('https://ntfy.sh/' + topic, { method: 'POST', body, headers });
  console.log('ntfy', r.status);
  if (r.ok) writeJson(stateFile, { ...state, ntfy: TODAY });
}
