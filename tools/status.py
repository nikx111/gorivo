#!/usr/bin/env python3
"""ГРИГОРИВО: кратко състояние без нито една заявка към Fuelo и без вход в GitHub.
Пусни го от корена на репото (след git pull). Пусканията се четат от публичното API на GitHub.
Изход 1, ако има неуспешна проверка или днес няма успешно пускане."""
import csv, json, sys, urllib.request
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NAMES = {'gasoline': 'А95', 'gasoline98': 'А98/100', 'diesel': 'Дизел', 'dieselplus': 'Премиум дизел', 'lpg': 'Газ'}
problem = False

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'gorivo-status', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

sofia_today = (datetime.now(timezone.utc) + timedelta(hours=2)).date().isoformat()
print('== Пускания (последните 6)')
try:
    runs = get('https://api.github.com/repos/nikx111/gorivo/actions/workflows/update.yml/runs?per_page=6')['workflow_runs']
    for r in runs: print(f"  {r['created_at']} {r['event']:18} {r['status']} {r['conclusion']}")
    ok_today = [r for r in runs if r['conclusion'] == 'success' and r['created_at'][:10] == datetime.now(timezone.utc).date().isoformat()]
    if not ok_today: print('  ВНИМАНИЕ: днес още няма успешно пускане'); problem = True
except Exception as e:
    print('  не успях да прочета пусканията:', e)

l = json.load(open(REPO / 'docs/data/latest.json'))
print(f"\n== Данни: {l['date']}, обновено {l['updated']}, Fuelo {l['fuelo']}")
bad = [c for c in l['checks'] if not c['ok']]
print(f"Проверки: {len(l['checks']) - len(bad)} от {len(l['checks'])}")
for c in bad: print('  ВНИМАНИЕ:', c['name'], '|', c['detail'])
problem |= bool(bad)

h = {(r['date'], r['fuel']): float(r['price']) for r in csv.DictReader(open(REPO / 'data/history.csv')) if ':' not in r['fuel']}
print('\n== Цени по дни (Fuelo)')
for k, n in NAMES.items():
    ds = sorted(d for d, f in h if f == k)[-7:]
    print(f"  {n:14}", '  '.join(f"{d[5:]} {h[(d, k)]:.2f}" for d in ds))

rows = [r for r in csv.DictReader(open(REPO / 'data/forecasts.csv'))
        if (date.fromisoformat(r['target']) - date.fromisoformat(r['made'])).days == 1 and (r['target'], r['fuel']) in h]
last = max((r['target'] for r in rows), default=None)
print('\n== Последни проверени прогнози за утре')
for r in rows:
    if r['target'] == last:
        a = h[(r['target'], r['fuel'])]
        print(f"  {r['target']} {NAMES[r['fuel']]:14} прогноза {float(r['pred']):.3f}  реално {a:.2f}  грешка {(float(r['pred']) - a) * 100:+.1f} ст.")
lv = l.get('live') or {}
if lv.get('n'):
    print(f"Общо: {lv['n']} проверени, грешка {lv['mae'] * 100:.2f} ст. срещу {lv['naive'] * 100:.2f} ст. при „няма промяна“, посока {lv['direction'] * 100:.0f}% от {lv['directionN']}")

print('\n== Прогноза')
for k, f in l['bg'].items():
    a = f['ahead'][0]
    print(f"  {f['name']:14} днес {f['price']:.2f} → утре ~{a['price']:.3f} ({a['lo']:.2f} до {a['hi']:.2f}){'  [съмнителна цена от Fuelo]' if f.get('suspect') else ''}")

d = json.load(open(REPO / 'docs/data/discounts.json'))
exp = [b for b, v in d['brands'].items() if v.get('valid_to') and v['valid_to'] < sofia_today]
soon = [f"{b} до {v['valid_to']}" for b, v in d['brands'].items() if v.get('valid_to') and v['valid_to'] >= sofia_today]
print(f"\n== Отстъпки с карти: проверени {d['checked']}; изтекли: {', '.join(exp) or 'няма'}; изтичат: {', '.join(soon) or 'няма'}")
try:
    code = urllib.request.urlopen('https://nikx111.github.io/gorivo/', timeout=30).status
    print('\n== Сайтът:', code)
except Exception as e:
    print('\n== Сайтът не отговаря:', e); problem = True
sys.exit(1 if problem else 0)
