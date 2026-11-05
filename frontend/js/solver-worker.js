/* openBatteryFlux solver worker.

   The page sends the inputs of a tool here and gets plain numbers back, so a
   simulation, a comparison, a calibration or a validation never blocks the
   thread that draws the interface. The physics itself lives in js/solver.js,
   which this worker and the page share; nothing numeric is written twice.

   Messages in:  { id, task, args }
   Messages out: { id, ok: true, result }  or  { id, ok: false, error } */

importScripts("solver.js");

var S = self.OBFSolver;
var clp = S.clp, invOcv = S.invOcv, rcSet = S.rcSet, RCS = S.RCS, met = S.met, nm = S.nm,
  predict = S.predict, predictT = S.predictT, rbv = S.rbv, pmax = S.pmax;

/* ---------- simulation ---------- */
/* The simulator reads its upright state (SM) from the solver's binding. */
function simulate(a) {
  S.bind({ SM: a.cfg });
  return a.entries.map(function (r) {
    return { i: r.i, o: S.simP(r.cell, a.prof, r.vl) };
  });
}

/* ---------- cell comparison ---------- */
function compare(a) {
  var cfg = a.cfg;
  return a.entries.map(function (e) {
    var c = e.cell;
    var o = S.sim(c, { mode: cfg.mode, C: cfg.C, T: cfg.T, soh: cfg.soh, soc0: e.soc0 });
    var n = o.t.length;
    if (n < 2) return null;
    var we = 0, wh = [0];
    for (var j = 1; j < n; j++) {
      we += (o.v[j] + o.v[j - 1]) / 2 * (o.q[j] - o.q[j - 1]);
      wh.push(we / c.m * 1000);
    }
    var h = o.t[n - 1] / 3600;
    return {
      i: e.i, id: e.id, o: o, wh: wh,
      Q: o.Q, E: o.E, sE: o.E / c.m * 1000, pA: o.E / h, sP: o.E / h / c.m * 1000,
      Tm: Math.max.apply(null, o.T), cf: Math.min.apply(null, o.cf) * 100,
      dur: h * 60, pct: o.Q / c.Ah * 100
    };
  }).filter(Boolean);
}

/* ---------- resistance and maximum power versus SOC ---------- */
function power(a) {
  var cs = a.cfg, ch = cs.mode === "charge", h = cs.soh / 100, S0 = [];
  for (var k = 0; k <= 100; k++) S0.push(k);
  return a.entries.map(function (e) {
    var c = e.cell, I = cs.C * c.Ah;
    var q = cs.isR ? null : S0.map(function (x) { return pmax(c, x / 100, cs.T, h, cs.pw, ch, cs.Tl); });
    return {
      i: e.i, id: e.id,
      nT: cs.isR ? 0 : q.filter(function (z) { return z.th; }).length,
      d: S0.map(function (x, j) { return cs.isR ? rbv(c, x / 100, cs.T, h, cs.pw, I).R * 1e3 : q[j].P; })
    };
  });
}

/* ---------- calibration ----------
   One model refitted on every loaded profile. The arithmetic is the same as
   it was on the page; only the DOM reads moved to the caller. */
function fit(a) {
  var c = a.cell, KDS = a.profs, KECM = a.ecm, rct = a.rct, th = a.th, idx = a.idx, u0 = a.u0;
  var n = RCS[KECM].length, P = KDS.length, O = 3 + P, TH = O + 2 * n;

  var DS = KDS.map(function (K, j) {
    var st = Math.max(1, Math.ceil(K.t.length / Math.ceil(6000 / P)));
    var d = { t: [], i: [], v: [], T: K.T ? [] : null, name: K.name };
    for (var k = 0; k < K.t.length; k += st) {
      d.t.push(K.t[k]);
      d.i.push(K.i[k] * (K.neg ? -1 : 1));
      d.v.push(K.v[k]);
      if (d.T) d.T.push(K.T[k]);
    }
    d.soc0 = u0[j] ? clp(+u0[j] / 100, 0, 1) : invOcv(c, d.v[0] + d.i[0] * c.r0);
    return d;
  });

  var rc0 = rcSet(c, KECM), e = function (x) { return Math.exp(clp(x, -1.6, 1.6)); };
  var mk = function (x) {
    var arr = new Array(TH + 2).fill(0);
    idx.forEach(function (k, j) { arr[k] = x[j]; });
    var rc = rc0.map(function (b, j) { return [b[0] * e(arr[O + 2 * j]), b[1] * e(arr[O + 1 + 2 * j])]; });
    var r1 = rc.reduce(function (q, b) { return q + b[0]; }, 0);
    return {
      dsv: DS.map(function (_, j) { return .05 * clp(arr[3 + j], -3, 3); }),
      r0: c.r0 * e(arr[0]), rc: rc, r1: n ? r1 : c.r1,
      tau: n ? rc.reduce(function (q, b) { return q + b[0] * b[1]; }, 0) / r1 : c.tau,
      Q: c.Ah * e(arr[1]), B: c.B + 400 * clp(arr[2], -3, 3),
      ecm: KECM, rct: rct, cth: e(arr[TH]), hAs: e(arr[TH + 1])
    };
  };
  var pj = function (p, j) { return Object.assign({}, p, { ds: p.dsv[j] }); };
  var thr = function (p, j) {
    var d = DS[j];
    return predictT(c, p, { t: d.t, i: d.i, soc0: d.soc0 + p.dsv[j] }, d.T[0], p.hAs, p.cth).T;
  };
  var run = function (p) { return DS.map(function (d, j) { return predict(c, pj(p, j), d); }); };
  var cost = function (x) {
    var p = mk(x), q = 0;
    DS.forEach(function (d, j) {
      var m = met(predict(c, pj(p, j), d), d.v);
      q += m.rmse * m.rmse;
      if (th && d.T) {
        var mt = met(thr(p, j), d.T);
        q += 1e-4 * mt.rmse * mt.rmse;
      }
    });
    return Math.sqrt(q / P);
  };

  var it = Math.max(300, 70 * idx.length);
  var r = nm(cost, idx.map(function () { return 0; }), idx.map(function () { return .35; }), it);
  [.15, .06, .02].forEach(function (z) {
    r = nm(cost, r.x, idx.map(function () { return z; }), it);
  });

  var p0 = mk(idx.map(function () { return 0; })), p1 = mk(r.x), V0 = run(p0), V1 = run(p1);
  var cat = function (x) { return [].concat.apply([], x); };
  var mm = function (x) {
    return x.reduce(function (q, y) { return [Math.min(q[0], y), Math.max(q[1], y)]; }, [Infinity, -Infinity]);
  };
  var M = cat(DS.map(function (d) { return d.v; }));
  var tv0 = DS.map(function (d, j) { return th && d.T ? thr(p0, j) : null; });
  var tv1 = DS.map(function (d, j) { return th && d.T ? thr(p1, j) : null; });
  var TM = cat(DS.filter(function (d) { return d.T; }).map(function (d) { return d.T; }));

  return {
    ds: DS, p0: p0, p1: p1, v0: V0, v1: V1, tv0: tv0, tv1: tv1,
    m0: met(cat(V0), M), m1: met(cat(V1), M),
    mT0: th ? met(cat(tv0.filter(Boolean)), TM) : null,
    mT1: th ? met(cat(tv1.filter(Boolean)), TM) : null,
    mp0: V0.map(function (v, j) { return met(v, DS[j].v); }),
    mp1: V1.map(function (v, j) { return met(v, DS[j].v); }),
    Tr: mm(cat(DS.map(function (d) { return d.T || [25]; }))),
    Ir: mm(cat(DS.map(function (d) { return d.i; })))
  };
}

/* ---------- validation ----------
   Predictions for every loaded profile against the chosen model. The error
   statistics are computed on the page from the arrays returned here. */
function validate(a) {
  var M = a.model, amb = a.amb;
  return a.profiles.map(function (P, pi) {
    var i = P.i.map(function (x) { return x * (P.neg ? -1 : 1); });
    var d = {
      t: P.t, i: i, v: P.v, T: P.T,
      soc0: P.soc0u ? clp(+P.soc0u / 100, 0, 1) : invOcv(M.c, P.v[0] + i[0] * M.p.r0)
    };
    var Ta = amb !== null && amb !== "" ? +amb : (P.T ? P.T[0] : 25);
    var run = function (p) {
      return P.T ? predict(M.c, Object.assign({}, p, { ds: 0 }), d)
        : predictT(M.c, p, d, Ta, p.hAs || 1, p.cth || 1).v;
    };
    var vm = run(M.p), vb = M.b ? run(M.b) : null;
    var tm = P.T ? predictT(M.c, M.p, d, Ta, M.p.hAs || 1, M.p.cth || 1).T : null;

    var cu = d.soc0;
    var soc = d.t.map(function (t, k) {
      var r = cu;
      if (k < d.t.length - 1) cu -= i[k] * (d.t[k + 1] - t) / (M.p.Q * 3600);
      return r;
    });

    return {
      i: pi, P: P, d: d, vm: vm, vb: vb, tm: tm, soc: soc,
      cr: i.map(function (x) { return Math.abs(x) / M.c.Ah; }),
      em: vm.map(function (x, k) { return (x - P.v[k]) * 1e3; }),
      eb: vb && vb.map(function (x, k) { return (x - P.v[k]) * 1e3; }),
      et: tm && tm.map(function (x, k) { return x - P.T[k]; })
    };
  });
}

var TASKS = { simulate: simulate, compare: compare, power: power, fit: fit, validate: validate };

self.onmessage = function (ev) {
  var m = ev.data || {};
  var fn = TASKS[m.task];
  if (!fn) {
    self.postMessage({ id: m.id, ok: false, error: "Unknown solver task: " + m.task });
    return;
  }
  try {
    self.postMessage({ id: m.id, ok: true, result: fn(m.args) });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: (err && err.message) || String(err) });
  }
};
