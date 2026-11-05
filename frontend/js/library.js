/* Fetches the cell library from the backend and converts it into the shape the
   app code expects. This is the only place the frontend talks to the API. */
window.OBF = window.OBF || {};

OBF.library = null;

/* Full URL for an API path, honouring js/config.js. */
OBF.apiUrl = function (path) {
  var base = ((window.OBF_CONFIG && window.OBF_CONFIG.apiBaseUrl) || "").trim();
  return base.replace(/\/+$/, "") + path;
};

/* Wake the API while the page is still loading. A serverless instance that has
   scaled to zero needs about two seconds to answer its first request, and the
   visitor would otherwise feel exactly that on their first sign-in or tool use.
   The answer is thrown away; the point is the warm instance behind it. */
OBF.wakeApi = function () {
  fetch(OBF.apiUrl("/api/health"), {
    headers: { Accept: "application/json" },
    cache: "no-store"
  }).catch(function () {});
};

OBF.loadLibrary = async function () {
  OBF.wakeApi();
  var payload;
  try {
    var res = await fetch(OBF.apiUrl("/api/library"), {
      // The API answers with an ETag and a five-minute lifetime, so a repeat
      // visit reuses the copy it already has instead of downloading 1.1 MB.
      headers: { Accept: "application/json" }
    });
    if (!res.ok) {
      /* A protected Vercel deployment answers 401 with its own JSON payload,
         never reaching this app. Recognise it so the page can explain the
         deployment rather than blaming the backend. */
      var body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      var failure = new Error("The library API answered HTTP " + res.status + ".");
      failure.status = res.status;
      failure.protected = !!(body && (body.protection ||
        (body.error && String(body.error.code) === "401")));
      throw failure;
    }
    payload = await res.json();
  } catch (err) {
    OBF.bootError(err);
    return false;
  }

  var names = {}, chemistries = {}, cells = {};

  (payload.chemistries || []).forEach(function (h) {
    if (!h || !h.id) return;
    names[h.id] = h.name || h.id;
    chemistries[h.id] = {
      V: +h.nominal_v,
      Vmax: +h.v_max,
      Vmin: +h.v_min,
      ocv: Array.isArray(h.ocv) ? h.ocv.map(Number) : [],
      rk: +h.r_k,
      r1r: +h.r1_ratio,
      tau: +h.tau_s,
      B: +h.arrhenius_b,
      dsT: [+h.temp_min_c, +h.temp_max_c]
    };
  });

  (payload.cells || []).forEach(function (c) {
    var h = chemistries[c.chemistry];
    var Ah = +c.capacity_ah, m = +c.mass_g;
    if (!h) {
      console.warn("Cell '" + c.id + "' uses the unknown chemistry '" + c.chemistry + "'. It is not shown.");
      return;
    }
    if (!h.ocv.length || !isFinite(Ah) || Ah <= 0 || !isFinite(m) || m <= 0) {
      console.warn("Cell '" + c.id + "' has incomplete numbers. It is not shown.");
      return;
    }
    var maxC = +c.max_c_rate || 0.2;
    var r0 = h.rk * (+c.resistance_factor || 1) / Ah;
    // prefer the cell's own measured/datasheet figures over chemistry defaults
    var V = (+c.nominal_voltage_v || h.V);
    var E = +c.specific_energy_wh_kg_calc || Ah * V / m * 1000;
    var P = +c.specific_power_w_kg || E * maxC;
    var brand = (c.brand || "openBatteryFlux").trim() || "openBatteryFlux";
    var bn = brand.split(" / ")[0].trim() || brand;   // English brand part
    cells[c.id] = {
      n: c.name || (c.model ? bn + " " + c.model + " · " + Ah + " Ah"
                            : bn + " " + names[c.chemistry] + " · " + Ah + " Ah"),
      s: names[c.chemistry],
      ch: c.chemistry,
      brand: brand,
      form: (c.form || "—").trim(),
      kind: c.kind,
      model: c.model || "",
      country: c.country || "",
      release: c.release || "",
      Ah: Ah,
      m: m,
      V: V,
      Vmax: h.Vmax,
      Vmin: h.Vmin,
      ocv: h.ocv,
      r0: r0,
      r1: r0 * h.r1r,
      tau: h.tau,
      B: h.B,
      hA: 0.0053 * Math.pow(m, 2 / 3),
      dsC: [0.2, maxC],
      dsT: h.dsT,
      cov: c.coverage == null ? 50 : +c.coverage,
      E: E,
      P: P,
      cyc: +c.cycle_life_cycles || null,
      ir: +c.internal_resistance_ac_mohm || null,
      cd: c.chemistry_detail || "",
      cathode: c.cathode || "",
      anode: c.anode || "",
      Vocv: +c.ocv_v || null,
      Vcut: +c.cutoff_voltage_v || null,
      Wh: +c.energy_wh || null,
      dims: [c.length_mm, c.width_mm, c.thickness_mm, c.diameter_mm]
              .map(x => x == null || x === "" ? null : +x),
      vol: +c.volume_ccm || null,
      notes: c.notes || "",
      flags: c.data_flags || ""
    };
  });

  if (!Object.keys(cells).length) {
    OBF.bootError(new Error("The database returned no usable cells."));
    return false;
  }

  OBF.library = { names: names, chemistries: chemistries, cells: cells };
  return true;
};

/* Start the download the moment this file runs rather than once app.js has
   parsed: the two requests were serialised, which cost a round trip on every
   cold visit. app.js awaits this same promise, so the fetch happens once. */
OBF.libraryReady = null;
OBF.startLibrary = function () {
  if (!OBF.libraryReady) OBF.libraryReady = OBF.loadLibrary();
  return OBF.libraryReady;
};
OBF.startLibrary();

/* The library never arrived: say so clearly instead of showing an empty app. */
OBF.bootError = function (err) {
  console.error(err);
  var box = document.getElementById("boot");
  var msg = document.getElementById("bootmsg");
  if (!box || !msg) return;
  msg.textContent = "";
  var title = document.createElement("b");
  title.style.cssText = "display:block;font-size:18px;margin-bottom:6px";
  var protectedDeployment = !!(err && err.protected);
  title.textContent = protectedDeployment
    ? "This deployment is protected"
    : "The cell library could not be loaded";
  var detail = document.createElement("div");
  detail.textContent = protectedDeployment
    ? "Vercel Authentication answered before the site could start, so no page " +
      "content is available to visitors."
    : ((err && err.message) || String(err));
  var hint = document.createElement("div");
  hint.style.cssText = "margin-top:10px;font-size:13px;color:var(--mut);max-width:46ch";
  hint.textContent = protectedDeployment
    ? "In Vercel, open the project, then Settings → Deployment Protection and set " +
      "Vercel Authentication to apply to preview deployments only (or turn it " +
      "off), then redeploy. It is a project setting: nothing in this repository " +
      "can turn it off."
    : "Start the backend, then reload. Expected answer from " +
      OBF.apiUrl("/api/library") + ". If the frontend and the backend live on different " +
      "addresses, set apiBaseUrl in frontend/js/config.js.";
  var retry = document.createElement("button");
  retry.type = "button";
  retry.textContent = "Reload";
  retry.style.cssText = "margin-top:14px;padding:8px 16px;border-radius:8px;cursor:pointer";
  retry.onclick = function () { location.reload(); };
  msg.append(title, detail, hint, retry);
};

/* The app finished starting: hide the loading overlay. */
OBF.ready = function () {
  var box = document.getElementById("boot");
  if (box) box.remove();
  document.documentElement.setAttribute("data-obf-ready", "1");
};
