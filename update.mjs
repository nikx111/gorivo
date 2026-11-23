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
// Оценката идва от model.py: модел на корекцията на грешката, изчислен върху официалните седмични цени
// в България от бюлетина на ЕК и проверен върху последните 2 години. Тук се взима само промяната,
// която моделът очаква от днес нататък, и се прилага към днешната цена от Fuelo.
// Ако model.py не тръгне (няма Python или бюлетинът не се свали), остава старото просто правило:
//   натиск = 1,2 (ДДС) × (средно за последните 3 борсови дни − средно за дни 8–10 назад), за ден минава 1/5 от него.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { learn, apply, accuracy, band, weekdays, weekdayShift, HORIZONS } from './learn.mjs';

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
// only100: при Shell кодът gasoline98 във Fuelo е V-Power 95, затова за колоната А98/100 се взима направо 100-октановото
const BRANDS = [{ id: 3, name: 'OMV' }, { id: 4, name: 'Rompetrol' }, { id: 1, name: 'Eko' }, { id: 2, name: 'Lukoil' }, { id: 5, name: 'Shell', only100: true }, { id: 39, name: 'Бенита' }];
const COUNTRIES = [{ code: 'gr', name: 'Гърция' }, { code: 'ro', name: 'Румъния' }, { code: 'de', name: 'Германия' }];
const K_DEFAULT = 1 / 5, DAYS_AHEAD = 5, RESERVE = 15;
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
// Заявки, които връщат само стари цени (Бенита, А98 при някои марки), се питат веднъж седмично, не всеки ден
const skipFile = path.join(dataDir, 'fuelo-skip.json'), skip = readJson(skipFile, {});
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function remember(p, v) {
  if (fresh(v)) delete skip[p]; else skip[p] = addDays(TODAY, 7);
  writeJson(skipFile, skip);
  return v;
}
const MAX_CALLS = 45; // таван за едно пускане, за да остане място в дневния лимит от 100
async function fuelo(p) {
  if (p in cache.r) return remember(p, cache.r[p]);
  if (skip[p] && skip[p] > TODAY) return null;
  if (remaining < RESERVE || calls >= MAX_CALLS) return null;
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
  return remember(p, v);
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
    // Цените на договорите се свалят с няколко секунди разлика, затова не се иска пълно съвпадение:
    // достатъчно е непрекъснатата цена да е много по-близо до следващия договор, отколкото до текущия
    const gap = Math.abs(front[d] - next[d]);
    if (gap >= 0.05 && Math.abs(series[d] - next[d]) < 0.25 * gap) { series[d] = front[d]; fixed++; }
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

// --- Модел върху историята (model.py) ---
let model = null;
try {
  execFileSync(process.env.PYTHON || 'python3', [path.join(here, 'model.py'), TODAY], { stdio: 'inherit', timeout: 300000 });
  model = readJson(path.join(siteData, 'model.json'), null);
} catch (e) {
  console.log('model.py не тръгна, ползвам простото правило: ' + e.message);
}
const BASE = { gasoline: 'gasoline', gasoline98: 'gasoline', diesel: 'diesel', dieselplus: 'diesel', lpg: 'lpg' };

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
  const mp = model?.fuels?.[BASE[f.code]]?.path, method = mp && mp[d.date] != null ? 'model' : 'rule';
  const ahead = [];
  for (let i = 1; i <= DAYS_AHEAD; i++) {
    const day = sofiaDate(new Date(Date.parse(d.date + 'T12:00:00Z') + i * 864e5));
    const delta = method === 'model' ? (mp[day] ?? Object.values(mp).at(-1)) - mp[d.date] : pr.p * (1 - (1 - k) ** i);
    ahead.push({ date: day, raw: +(d.price + delta).toFixed(4), price: +(d.price + delta).toFixed(3) });
  }
  // Разбивка: ДДС е 1/6 от цената, акцизът е от бюлетина на ЕК (цена с данъци − без данъци − ДДС),
  // продуктът е борсовата цена, останалото е доставка, складове и печалба
  const vat = d.price / 6, product = f.src === 'BZ=F' ? null : pr.cost;
  const excise = model?.taxes?.[f.src === 'HO=F' ? 'diesel' : 'gasoline']?.excise ?? f.excise;
  bg[f.code] = {
    name: code === f.code ? f.name : 'А98/100', code, price: d.price, min: d.min, max: d.max, date: d.date, method, change: pr.ch, src: f.src, ahead,
    modelToday: method === 'model' ? mp[d.date] : null,
    breakdown: product == null ? null : { product, excise, vat, margin: d.price - vat - excise - product },
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
    const first = b.only100 && fc === 'gasoline98' ? 'gasoline98plus' : fc;
    let d = await fuelo('/v2/brands/' + b.id + '/prices/average?fuel=' + first), code = first;
    if (!fresh(d) && code === 'gasoline98') { d = await fuelo('/v2/brands/' + b.id + '/prices/average?fuel=gasoline98plus'); code = 'gasoline98plus'; }
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

// --- Дневник на прогнозите, учене от грешките и реална точност (learn.mjs) ---
// Всяка прогноза се записва сурова (raw, както я дава моделът) и поправена (pred, каквато е показана).
// Когато денят дойде, се сравнява с цената от Fuelo; от грешките се учат поправките за следващите прогнози.
const fcFile = path.join(dataDir, 'forecasts.csv');
const fcLines = existsSync(fcFile) ? readFileSync(fcFile, 'utf8').trim().split('\n') : [];
const fcHead = (fcLines[0] || '').split(',');
const fcs = fcLines.slice(1).filter(Boolean).map((l) => {
  const v = Object.fromEntries(fcHead.map((k, i) => [k, l.split(',')[i]]));
  return { made: v.made, target: v.target, fuel: v.fuel, base: +v.base, raw: +(v.raw ?? v.pred), pred: +v.pred, method: v.method };
});
const actual = (fuel, date) => hist.find((r) => r.fuel === fuel && r.date === date)?.price;
const learned = {};
for (const [code, f] of Object.entries(bg)) {
  const Lr = learn(fcs, actual, code, TODAY);
  learned[code] = { s: Lr.s, n: Lr.n, corr: Lr.corr, count: Lr.count };
  // Дни от седмицата и празници: научени от дневната история на средната цена
  const W = weekdays(hist.filter((r) => r.fuel === code).map((r) => [r.date, r.price]));
  const q80 = model?.fuels?.[BASE[code]]?.check?.q80;
  f.ahead.forEach((a, i) => {
    const p = apply(Lr, f.price, a.raw, i + 1) + weekdayShift(W, f.date, i + 1), w = band(fcs, actual, code, TODAY, i + 1, q80);
    a.price = +p.toFixed(3); a.lo = +(p - w).toFixed(3); a.hi = +(p + w).toFixed(3);
  });
  f.learn = learned[code];
  f.weekdays = { eff: W.eff, n: W.n, weeks: W.weeks };
}
for (const [code, f] of Object.entries(bg)) for (const a of f.ahead) {
  const i = fcs.findIndex((r) => r.made === f.date && r.target === a.date && r.fuel === code);
  const row = { made: f.date, target: a.date, fuel: code, base: f.price, raw: a.raw, pred: a.price, method: f.method };
  if (i >= 0) fcs[i] = row; else fcs.push(row);
}
writeFileSync(fcFile, 'made,target,fuel,base,raw,pred,method\n' + fcs.map((r) => [r.made, r.target, r.fuel, r.base, r.raw, r.pred, r.method].join(',')).join('\n') + '\n');
const acc = Object.fromEntries(Object.keys(bg).map((c) => [c, accuracy(fcs, actual, c, TODAY)]));
const all1 = Object.values(acc).map((a) => a[0]).filter((a) => a.n);
const sumN = all1.reduce((x, a) => x + a.n, 0), sumD = all1.reduce((x, a) => x + a.directionN, 0);
const live = {
  since: fcs.map((r) => r.made).sort()[0] ?? TODAY, n: sumN,
  mae: sumN ? all1.reduce((x, a) => x + a.mae * a.n, 0) / sumN : null,
  maeRaw: sumN ? all1.reduce((x, a) => x + a.maeRaw * a.n, 0) / sumN : null,
  naive: sumN ? all1.reduce((x, a) => x + a.naive * a.n, 0) / sumN : null,
  direction: sumD ? all1.reduce((x, a) => x + (a.direction ?? 0) * a.directionN, 0) / sumD : null,
  directionN: sumD, byFuel: acc, learned,
};
// Вчерашната прогноза за утре срещу днешната реална цена, за известието
const yesterday = Object.fromEntries(Object.keys(bg).map((c) => {
  const r = fcs.filter((x) => x.fuel === c && x.target === TODAY && (Date.parse(x.target) - Date.parse(x.made)) / 864e5 === 1)[0];
  const a = actual(c, TODAY);
  return [c, r && a != null ? { pred: r.pred, act: a } : null];
}));
console.log('Учене: ' + Object.entries(learned).map(([c, l]) => c + ' скорост ' + l.s.toFixed(2) + ' от ' + l.n + ', поправка утре ' + (l.corr[0] * 100).toFixed(1) + ' ст.').join('; '));

const latestGasoil = {};
const days7 = (d) => (Date.parse(TODAY) - Date.parse(d)) / 864e5 >= 7 && (Date.parse(TODAY) - Date.parse(d)) / 864e5 <= 10;

// --- Проверки на данните: всяка стойност се сверява с независим източник ---
const checks = [];
const ck = (ok, name, detail) => checks.push({ ok, name, detail });
const n2 = (x, d = 2) => x.toFixed(d).replace('.', ',');
{
  const stale = Object.values(bg).filter((f) => f.date !== TODAY).map((f) => f.name);
  ck(!stale.length && Object.keys(bg).length >= 4, 'Цените от Fuelo са днешни', stale.length ? 'Стари: ' + stale.join(', ') : Object.keys(bg).length + ' горива с дата ' + TODAY);
}
if (model) {
  const w = (f) => model.fuels[f]?.weekly?.at(-1);
  for (const [code, name] of [['gasoline', 'А95'], ['diesel', 'Дизел']]) {
    const b = w(code), f = bg[code];
    if (b && f) { const dd = (f.price / b[1] - 1) * 100; ck(Math.abs(dd) <= 5, name + ': Fuelo срещу бюлетина на ЕК', 'Fuelo ' + n2(f.price) + ' €, ЕК за ' + b[0] + ': ' + n2(b[1]) + ' € (' + n2(dd, 1) + '%)'); }
    if (f?.modelToday) { const dd = (f.price / f.modelToday - 1) * 100; ck(Math.abs(dd) <= 4, name + ': моделът стига до днешната цена', 'По модела ' + n2(f.modelToday) + ' €, Fuelo ' + n2(f.price) + ' € (' + n2(dd, 1) + '%)'); }
  }
  const age = (Date.parse(TODAY) - Date.parse(model.bulletin_date)) / 864e5;
  ck(age <= 14, 'Бюлетинът на ЕК е пресен', 'Последна седмица: ' + model.bulletin_date);
  for (const [code, name] of [['gasoline', 'А95'], ['diesel', 'Дизел']]) {
    const c = model.fuels[code]?.check;
    if (c) ck(c.mae < c.naive_mae, name + ': моделът бие „няма промяна“', 'За ' + c.weeks + ' седмици: грешка ' + n2(c.mae * 100) + ' ст. срещу ' + n2(c.naive_mae * 100) + ' ст.');
  }
} else ck(false, 'Модел върху историята', 'model.py не тръгна: ползва се простото правило');
// ICE: Brent за проверка и газьол (европейският ориентир за дизела). Безплатно има само днешната цена,
// затова газьолът се записва всеки ден в data/ice-gasoil.csv и така се трупа собствена история.
let gasoil = null;
try {
  const r = await fetch('https://scanner.tradingview.com/futures/scan', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify({ symbols: { tickers: ['ICEEUR:BRN1!', 'ICEEUR:ULS1!'] }, columns: ['close'] }) });
  const got = Object.fromEntries(((await r.json()).data || []).map((x) => [x.s, x.d[0]]));
  const ice = got['ICEEUR:BRN1!'], y = oil.rows.at(-1)[col('brent')];
  if (ice) { const dd = (y / ice - 1) * 100; ck(Math.abs(dd) <= 1.5, 'Brent: Yahoo срещу ICE', 'Yahoo ' + n2(y) + ' $, ICE ' + n2(ice) + ' $ (' + n2(dd, 1) + '%)'); }
  if (got['ICEEUR:ULS1!']) gasoil = got['ICEEUR:ULS1!'];
} catch {}
{
  const gf = path.join(dataDir, 'ice-gasoil.csv');
  const rows = existsSync(gf) ? readFileSync(gf, 'utf8').trim().split('\n').slice(1).filter(Boolean).map((l) => l.split(',')) : [];
  if (gasoil && !rows.some((r) => r[0] === TODAY)) rows.push([TODAY, gasoil]);
  writeFileSync(gf, 'date,usd_per_tonne\n' + rows.map((r) => r.join(',')).join('\n') + '\n');
  latestGasoil.history = rows.length;
  if (gasoil) {
    // 1 тон дизел е около 1183 литра (плътност 0,845)
    latestGasoil.eurL = gasoil * 0.845 / 1000 / fxLast;
    latestGasoil.usdT = gasoil;
    for (const c of ['diesel', 'dieselplus']) {
      const b = bg[c]?.breakdown; if (!b) continue;
      b.product = latestGasoil.eurL; b.margin = bg[c].price - b.vat - b.excise - b.product; b.productSrc = 'ICE газьол';
    }
  }
  // Проверка: американският дизел (основата на модела) и европейският газьол трябва да се движат заедно
  const old = rows.find((r) => days7(r[0]));
  if (old && gasoil) {
    const ice7 = (gasoil / +old[1] - 1) * 100, ho = oil.rows.filter((r) => r[col('diesel')] != null), hoNow = ho.at(-1)[col('diesel')], hoOld = [...ho].reverse().find((r) => r[0] <= old[0])?.[col('diesel')];
    if (hoOld) { const us7 = (hoNow / hoOld - 1) * 100; ck(Math.abs(us7 - ice7) <= 4, 'Дизел: САЩ и Европа се движат заедно', 'За седмица: ULSD ' + n2(us7, 1) + '%, ICE газьол ' + n2(ice7, 1) + '%'); }
  } else if (gasoil) ck(true, 'Европейски газьол (ICE): събира се история', n2(gasoil) + ' $/т днес, записани дни: ' + rows.length);
}
try {
  const x = await (await fetch('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml')).text();
  const ecb = +x.match(/currency='USD' rate='([\d.]+)'/)[1], day = x.match(/time='([\d-]+)'/)[1];
  const dd = (fxLast / ecb - 1) * 100;
  ck(Math.abs(dd) <= 0.7, 'Курс евро/долар срещу ЕЦБ', 'Yahoo ' + n2(fxLast, 4) + ', ЕЦБ за ' + day + ': ' + n2(ecb, 4));
} catch {}
{
  const jumps = Object.entries(bg).map(([c, f]) => { const prev = hist.filter((r) => r.fuel === c && r.date < f.date).sort((a, b) => b.date.localeCompare(a.date))[0]; return prev && Math.abs(f.price / prev.price - 1) > 0.05 ? f.name : null; }).filter(Boolean);
  ck(!jumps.length, 'Няма скокове над 5% за ден', jumps.length ? 'Скок при ' + jumps.join(', ') : 'Цените са в нормални граници');
}
const failed = checks.filter((c) => !c.ok);
console.log('Проверки: ' + (checks.length - failed.length) + ' от ' + checks.length + ' са наред' + (failed.length ? ' (' + failed.map((c) => c.name).join('; ') + ')' : ''));

const brentCh = pressure({ src: 'BZ=F', w: 1 }, 1).ch;
const latest = {
  updated: new Date().toISOString(), date: TODAY, bg, brands, countries, bno, checks, live, gasoil: latestGasoil,
  model: model ? { bulletin: model.bulletin_date, fuels: Object.fromEntries(Object.entries(model.fuels).map(([k, v]) => [k, { check: v.check, driver: v.driver, gap: v.gap }])) } : null,
  oil: { brent: oil.rows.at(-1)[col('brent')], brentWeek: brentCh, eurusd: fxLast, dieselWeek: pressure({ src: 'HO=F', w: 1 }, 1).ch, gasolineWeek: pressure({ src: 'RB=F', w: 1 }, 1).ch },
  fuelo: { calls, remaining: Number.isFinite(remaining) ? remaining : null, limit: 100 },
};
writeJson(path.join(siteData, 'latest.json'), latest);
console.log('Fuelo: ' + calls + ' заявки сега, остават ' + (Number.isFinite(remaining) ? remaining : '?') + ' за днес');

// --- ntfy: веднъж на ден ---
const eur = (x) => x.toFixed(2).replace('.', ',');
const pct = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(1).replace('.', ',') + '%';
const arrow = (d) => (d <= -0.005 ? '↓' : d >= 0.005 ? '↑' : '=');
const lines = Object.values(bg).map((f) => f.name + ': ' + eur(f.price) + ' → утре ' + eur(f.ahead[0].lo) + ' до ' + eur(f.ahead[0].hi) + ' € ' + arrow(f.ahead[0].price - f.price));
const D = bg.diesel, A = bg.gasoline;
const title = 'Горива утре: дизел ' + arrow(D.ahead[0].price - D.price) + ' ~' + eur(D.ahead[0].price) + ' €, А95 ' + arrow(A.ahead[0].price - A.price) + ' ~' + eur(A.ahead[0].price) + ' €';
const gap = (f) => { const g = model?.fuels?.[f]?.gap; return g == null ? '' : (g > 0.005 ? ' над' : g < -0.005 ? ' под' : ' около') + ' нивото, което борсата оправдава' + (Math.abs(g) > 0.005 ? ' (с ' + Math.round(Math.abs(g) * 100) + ' ст.)' : ''); };
const why = 'Защо: за седмица в евро дизелът на борсата ' + pct(latest.oil.dieselWeek) + ', бензинът ' + pct(latest.oil.gasolineWeek) + ', Brent ' + pct(latest.oil.brentWeek) + '.'
  + (model ? ' Дизелът у нас е' + gap('diesel') + ', А95 е' + gap('gasoline') + '.' : '');
const accTxt = model ? '\nТочност за 2 години: дизел ±' + n2(model.fuels.diesel.check.mae * 100, 1) + ' ст., посока ' + Math.round(model.fuels.diesel.check.direction * 100) + '% от седмиците.' : '';
const yd = yesterday.diesel;
const ydLine = yd ? '\nВчера казах за дизела ~' + n2(yd.pred) + ' €, днес е ' + n2(yd.act) + ' € (' + (Math.abs(yd.pred - yd.act) < 0.005 ? 'познато' : 'грешка ' + Math.round(Math.abs(yd.pred - yd.act) * 100) + ' ст.') + ').' : '';
const warn = failed.length ? '\nВнимание: ' + failed.map((c) => c.name).join('; ') + '.' : '';
const body = lines.join('\n') + '\n' + why + accTxt + ydLine + warn + '\nОценка, не обещание.';
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
