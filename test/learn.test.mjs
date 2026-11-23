// Проверка на ученето с измислени данни: известна истина, която ученето трябва да намери
import test from 'node:test';
import assert from 'node:assert/strict';
import { learn, apply, accuracy } from '../learn.mjs';

const day = (i) => new Date(Date.UTC(2026, 10, 1) + i * 864e5).toISOString().slice(0, 10);
// Цените реално падат с 0,4 ст. на ден, а суровият модел предвижда 0,8 ст. на ден (два пъти по-бързо) и е с 1 ст. над реалното
function world(nDays, { speed = 0.5, offset = 0.01 } = {}) {
  const price = (i) => 1.9 - 0.004 * i;
  const rows = [];
  for (let m = 0; m < nDays; m++) for (let h = 1; h <= 5; h++) {
    const base = price(m), raw = base - (0.004 / speed) * h + offset;
    rows.push({ made: day(m), target: day(m + h), fuel: 'diesel', base, raw, pred: raw });
  }
  const actual = (f, d) => { const i = Math.round((Date.parse(d) - Date.parse(day(0))) / 864e5); return i < nDays ? price(i) : undefined; };
  return { rows, actual, today: day(nDays - 1), price };
}

test('без данни няма поправка', () => {
  const L = learn([], () => undefined, 'diesel', '2026-11-23');
  assert.equal(L.s, 1);
  assert.deepEqual(L.corr, [0, 0, 0, 0, 0]);
});

test('с много данни намира, че моделът бърза двойно, и поправката намалява грешката', () => {
  const { rows, actual, today } = world(60, { offset: 0 });
  const L = learn(rows, actual, 'diesel', today);
  assert.ok(L.s > 0.5 && L.s < 0.75, 'скорост ' + L.s);
  const acc = accuracy(rows.map((r) => ({ ...r, pred: apply(L, r.base, r.raw, Math.round((Date.parse(r.target) - Date.parse(r.made)) / 864e5)) })), actual, 'diesel', today);
  assert.ok(acc[0].mae < acc[0].maeRaw, 'грешка ' + acc[0].mae + ' срещу ' + acc[0].maeRaw);
});

test('намира системно отместване и го поправя в обратна посока', () => {
  const { rows, actual, today } = world(60, { speed: 1, offset: 0.01 });
  const L = learn(rows, actual, 'diesel', today);
  assert.ok(L.corr[0] < -0.006 && L.corr[0] >= -0.03, 'поправка ' + L.corr[0]);
});

test('с малко данни поправките са предпазливи', () => {
  const { rows, actual, today } = world(4, { speed: 0.5, offset: 0.01 });
  const L = learn(rows, actual, 'diesel', today);
  assert.ok(L.s > 0.85, 'скорост ' + L.s);
  assert.ok(Math.abs(L.corr[0]) < 0.008, 'поправка ' + L.corr[0]);
});

test('поправките са ограничени дори при луди данни', () => {
  const { rows, actual, today } = world(60, { speed: 0.05, offset: 0.2 });
  const L = learn(rows, actual, 'diesel', today);
  assert.ok(L.s >= 0.3 && L.s <= 2);
  assert.ok(L.corr.every((c) => Math.abs(c) <= 0.03));
});

import { band, weekdays, weekdayShift, dayKind } from '../learn.mjs';

test('диапазонът започва от проверката на модела и расте с дните напред', () => {
  const b1 = band([], () => undefined, 'diesel', '2026-11-23', 1, 0.02), b5 = band([], () => undefined, 'diesel', '2026-11-23', 5, 0.02);
  assert.ok(b1 >= 0.005 && b5 > b1, b1 + ' ' + b5);
});

test('диапазонът се стеснява, когато реалните прогнози са точни', () => {
  const { rows, actual, today } = world(40, { speed: 1, offset: 0 });
  const exact = rows.map((r) => ({ ...r, pred: actual('diesel', r.target) ?? r.pred }));
  assert.ok(band(exact, actual, 'diesel', today, 1, 0.03) < 0.03 * Math.sqrt(1 / 7));
});

test('намира, че цените скачат в понеделник', () => {
  const series = [];
  let p = 1.8;
  for (let i = 0; i < 56; i++) { const d = day(i); if (dayKind(d) === 1) p += 0.01; series.push([d, +p.toFixed(3)]); }
  const W = weekdays(series);
  assert.ok(W.eff[1] > 0.005, 'понеделник ' + W.eff[1]);
  assert.ok(Math.abs(W.eff[3]) < 0.003, 'сряда ' + W.eff[3]);
  assert.ok(weekdayShift(W, '2026-11-22', 1) > 0.005, 'неделя към понеделник');
});

test('празниците се разпознават', () => {
  assert.equal(dayKind('2026-12-25'), 7);
  assert.equal(dayKind('2026-11-23'), 1);
});
