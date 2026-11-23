"""Модел на цените на колонката в България, изчислен върху реалната история.

Данни:
  - Седмичен петролен бюлетин на ЕК: средни цени в България с данъци, всяка седмица от 2005 г. (официални, в евро)
  - Борса (Yahoo): бензин RBOB, дизел ULSD, Brent и курс евро/долар, 10 години дневни цени;
    последните дни идват от docs/data/oil.json, където update.mjs вече е оправил смяната на договорите

Модел на корекцията на грешката (стандартният за предаване на цени), отделно за всяко гориво:
  дълъг срок:  P = α + β·C                (C = цена на продукта на борсата с ДДС, € за литър, средно за седмицата)
  седмица:     ΔP(t+1) = a + Σ b_i·ΔC(t−i) + γ·(P(t) − α − β·C(t))
  Изчислява се наново всяка седмица върху последните W седмици. Проверка: за последните 2 години всяка седмица
  се „предсказва“ само с данните отпреди нея и се сравнява с реалната цена и с най-простото „няма промяна“.

Пише docs/data/model.json: коефициенти, проверка, седмичната история и прогнозата по дни (в мащаба на бюлетина).
"""
import datetime as dt, io, json, os, sys, urllib.request
import numpy as np, openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
BULLETIN = 'https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx'
# Избрано с проверката: най-малка грешка за последните 2 години (виж README)
SPEC = {
    'gasoline': {'col': 'euro95', 'driver': 'RB=F', 'per': 3.78541, 'L': 3, 'W': 156},
    'diesel': {'col': 'diesel', 'driver': 'HO=F', 'per': 3.78541, 'L': 4, 'W': 208},
    'lpg': {'col': 'LPG', 'driver': 'BZ=F', 'per': 158.987, 'L': 2, 'W': 156},
}
TEST_WEEKS = 104


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def bulletin():
    wb = openpyxl.load_workbook(io.BytesIO(get(BULLETIN)), read_only=True, data_only=True)
    out = {}
    for sheet, key in [('Prices with taxes', 'with'), ('Prices wo taxes', 'wo')]:
        rows = wb[sheet].iter_rows(values_only=True)
        head = next(rows)
        idx = {c: head.index('BG_price_%s_tax_%s' % ('with' if key == 'with' else 'wo', c)) for c in ['euro95', 'diesel', 'LPG']}
        for r in rows:
            if not isinstance(r[0], dt.datetime):
                continue
            d = out.setdefault(r[0].date(), {})
            for c, i in idx.items():
                if isinstance(r[i], (int, float)) and r[i] > 0:
                    d[key + ':' + c] = r[i] / 1000
    return out


def yahoo(sym):
    d = json.loads(get('https://query1.finance.yahoo.com/v8/finance/chart/%s?range=10y&interval=1d' % sym))['chart']['result'][0]
    return {dt.datetime.fromtimestamp(t, dt.UTC).date(): c for t, c in zip(d['timestamp'], d['indicators']['quote'][0]['close']) if c is not None}


def daily_costs():
    fx, raw = yahoo('EURUSD=X'), {s: yahoo(s) for s in ['RB=F', 'HO=F', 'BZ=F']}
    # последните 2 години от oil.json (там смяната на договорите е оправена)
    oil = json.load(open(os.path.join(HERE, 'docs/data/oil.json')))
    cols = oil['cols']
    for row in oil['rows']:
        d = dt.date.fromisoformat(row[0])
        for s, c in [('RB=F', 'gasoline'), ('HO=F', 'diesel'), ('BZ=F', 'brent')]:
            if row[cols.index(c)] is not None:
                raw[s][d] = row[cols.index(c)]
        if row[cols.index('eurusd')]:
            fx[d] = row[cols.index('eurusd')]
    return {s: {d: v for d, v in ser.items() if d in fx} for s, ser in raw.items()}, fx


def week_cost(ser, t):
    """Средна цена с ДДС за седмицата преди датата на бюлетина (7 дни до t, без t)."""
    v = [x for d, x in ser.items() if t - dt.timedelta(days=7) <= d < t]
    return float(np.mean(v)) if v else None


def fit(P, C, L):
    X = np.c_[np.ones(len(C)), C]
    ab = np.linalg.lstsq(X, P, rcond=None)[0]
    u = P - X @ ab
    dP, dC = np.diff(P), np.diff(C)
    R = [[1.0] + [dC[t - 1 - i] for i in range(L)] + [u[t]] for t in range(L, len(dP))]
    b = np.linalg.lstsq(np.array(R), dP[L:], rcond=None)[0]
    return ab, b


def step(P, C, ab, b, L):
    """Промяна за следващата седмица от последните стойности на P и C (списъци, последният е „сега“)."""
    dC = np.diff(C)
    feats = [1.0] + [dC[-1 - i] for i in range(L)] + [P[-1] - ab[0] - ab[1] * C[-1]]
    return float(np.dot(b, feats))


def main():
    today = dt.date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else dt.datetime.now(dt.timezone(dt.timedelta(hours=2))).date()
    bul = bulletin()
    costs, _ = daily_costs()
    dates = sorted(bul)
    last = dates[-1]
    res = {'updated': dt.datetime.now(dt.UTC).isoformat(), 'bulletin_date': last.isoformat(), 'fuels': {}}
    w = bul[last]
    res['taxes'] = {}
    for f, c in [('gasoline', 'euro95'), ('diesel', 'diesel')]:
        if 'with:' + c in w and 'wo:' + c in w:
            vat = w['with:' + c] / 6
            res['taxes'][f] = {'with': w['with:' + c], 'wo': w['wo:' + c], 'vat': vat, 'excise': w['with:' + c] - w['wo:' + c] - vat}

    for fuel, s in SPEC.items():
        ser = {d: v / s['per'] * 1.2 for d, v in costs[s['driver']].items()}
        T = [t for t in dates if 'with:' + s['col'] in bul[t] and t >= dt.date(2015, 1, 1)]
        P = np.array([bul[t]['with:' + s['col']] for t in T])
        C = np.array([week_cost(ser, t) or np.nan for t in T])
        keep = ~np.isnan(C)
        T, P, C = [t for t, k in zip(T, keep) if k], P[keep], C[keep]
        L, W = s['L'], s['W']

        # Проверка без надникване напред
        back = []
        for t in range(len(P) - TEST_WEEKS - 1, len(P) - 1):
            o = max(0, t - W)
            ab, b = fit(P[o:t + 1], C[o:t + 1], L)
            back.append([T[t + 1].isoformat(), round(float(P[t + 1] - P[t]), 4), round(step(list(P[o:t + 1]), list(C[o:t + 1]), ab, b, L), 4)])
        act, pred = np.array([x[1] for x in back]), np.array([x[2] for x in back])
        moved = np.abs(act) >= 0.005
        check = {
            'weeks': len(back),
            'mae': float(np.mean(np.abs(pred - act))),
            'naive_mae': float(np.mean(np.abs(act))),
            'direction': float(np.mean(np.sign(pred[moved]) == np.sign(act[moved]))),
            'direction_n': int(moved.sum()),
            'within_1ct': float(np.mean(np.abs(pred - act) <= 0.01)),
        }

        # Коефициенти върху последните W седмици
        ab, b = fit(P[-W - 1:], C[-W - 1:], L)

        # Напред: седмица по седмица от последния бюлетин, докато покрием днес + 7 дни.
        # Седмичната цена C(t) е известна, ако цялата седмица преди t е минала; иначе се взима средното досега.
        Pw, Cw, Tw = list(P), list(C), list(T)
        while Tw[-1] < today + dt.timedelta(days=7):
            nxt = Tw[-1] + dt.timedelta(days=7)
            Pw.append(Pw[-1] + step(Pw, Cw, ab, b, L))
            known = week_cost(ser, min(nxt, today + dt.timedelta(days=1)))
            Cw.append(known if known is not None else Cw[-1])
            Tw.append(nxt)
        path = {}
        for i in range(len(T) - 1, len(Tw) - 1):
            for k in range(7):
                d = Tw[i] + dt.timedelta(days=k)
                path[d.isoformat()] = round(Pw[i] + (Pw[i + 1] - Pw[i]) * k / 7, 4)
        res['fuels'][fuel] = {
            'driver': s['driver'], 'L': L, 'W': W,
            'alpha': float(ab[0]), 'beta': float(ab[1]), 'coef': [float(x) for x in b],
            'check': check, 'backtest': back,
            'weekly': [[t.isoformat(), round(float(p), 4)] for t, p in zip(T, P)][-260:],
            'path': {d: v for d, v in path.items() if today - dt.timedelta(days=1) <= dt.date.fromisoformat(d) <= today + dt.timedelta(days=7)},
            'gap': float(P[-1] - ab[0] - ab[1] * C[-1]),
        }
        ch = check
        print('%-8s %s: грешка %.2f ст. (без промяна %.2f), посока %.0f%% от %d седмици' % (fuel, s['driver'], ch['mae'] * 100, ch['naive_mae'] * 100, ch['direction'] * 100, ch['direction_n']))
    json.dump(res, open(os.path.join(HERE, 'docs/data/model.json'), 'w'))


if __name__ == '__main__':
    main()
