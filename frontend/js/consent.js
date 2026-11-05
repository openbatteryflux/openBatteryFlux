/* openBatteryFlux — cookie consent and privacy controls.

   The site sets no cookies at all (see /cookies.html). The one thing here that
   is not strictly necessary is the anonymous usage counter: the rows that let
   the administrator see which cells and tools people actually use. That is
   what this module asks about, and it is the only thing it gates.

   Loaded before account.js, so the usage log can ask permission before it
   sends anything. The answer is kept in localStorage under obf_consent, with
   the policy version and the date, and 'Cookie settings' in the footer reopens
   the banner to change it.

   Two equally prominent buttons, nothing pre-selected, no "accept by scrolling"
   and no hidden reject: if the banner is dismissed without a choice, only
   essential storage is used. A Global Privacy Control or Do Not Track signal
   is treated as a refusal.
*/
window.OBFConsent = (function () {
  "use strict";

  var KEY = "obf_consent";
  var VERSION = "1";               // bump when /cookies.html changes materially
  var state = null;                // {choice:"all"|"essential", at:"YYYY-MM-DD", v:"1"}
  var box = null;                  // the #consent element
  var openedManually = false;

  function apiUrl(path) {
    var base = ((window.OBF_CONFIG && window.OBF_CONFIG.apiBaseUrl) || "").trim();
    return base.replace(/\/+$/, "") + path;
  }

  function gpcRefused() {
    try {
      if (window.navigator.globalPrivacyControl === true) return true;
      var dnt = window.navigator.doNotTrack || window.navigator.msDoNotTrack;
      return dnt === "1" || dnt === "yes" || dnt === true;
    } catch (e) { return false; }
  }

  function today() {
    try { return new Date().toISOString().slice(0, 10); } catch (e) { return ""; }
  }

  function load() {
    if (state) return state;
    state = null;
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return state;
      var parsed = JSON.parse(raw);
      var valid = parsed && (parsed.choice === "all" || parsed.choice === "essential");
      if (!valid || parsed.v !== VERSION) return state;   // policy changed: ask again
      state = { choice: parsed.choice, at: parsed.at || "", v: VERSION };
    } catch (e) { state = null; }
    return state;
  }

  function choice() { var s = load(); return s ? s.choice : null; }
  function decided() { return choice() !== null; }
  /* The only gate in the app: false means "send nothing to the usage log". */
  function canTrack() { return choice() === "all"; }

  function save(value) {
    state = { choice: value === "all" ? "all" : "essential", at: today(), v: VERSION };
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* memory only */ }
    try { document.documentElement.dataset.consent = state.choice; } catch (e) {}
    hide();
    /* Counting this visit now the visitor asked for it. visit() itself makes
       sure the same tab session is only counted once. */
    if (state.choice === "all" && window.OBFAccount && OBFAccount.visit) {
      try { OBFAccount.visit(); } catch (e) {}
    }
  }

  function button(label, value, cls) {
    return '<button type="button" class="' + cls + '" data-consent="' + value + '">' + label + "</button>";
  }

  function bannerHtml() {
    var c = choice();
    var buttons = c
      ? '<div class="cbtns">' + button("Keep anonymous statistics off", "essential", "btn") +
        button("Allow anonymous statistics", "all", "btn") + "</div>"
      : '<div class="cbtns">' + button("Accept all", "all", "btn") +
        button("Essential only", "essential", "btn") +
        '<a class="clnk" href="/cookies.html">Cookie policy</a></div>';
    var now = c
      ? '<p class="cnow">Your current choice: <b>' +
        (c === "all" ? "anonymous statistics allowed" : "essential only") +
        "</b>" + (load().at ? " (set " + load().at + ")" : "") + ".</p>"
      : "";
    return (
      '<h2 id="consent-title">Cookies and anonymous statistics</h2>' +
      "<p>We set no cookies. Your choice is only about the anonymous usage count: which cells and tools are used. " +
      "It never includes your name, your email, your IP address or anything you type into a tool.</p>" +
      buttons + now +
      '<details><summary>What the two choices mean</summary><ul>' +
      "<li><b>Essential only</b> — keeps you signed in and remembers this choice. Nothing about your visit is written to our usage log.</li>" +
      "<li><b>Accept all</b> — adds the anonymous visit, cell-view and tool-use rows, linked to a random id in this browser that the server stores only as a short hash.</li>" +
      "</ul></details>" +
      '<div class="cpanel"><p>Already counted before you changed your mind? ' +
      '<button type="button" class="btn" data-consent="forget">Delete my anonymous data</button> ' +
      '<span id="cfstate" role="status" aria-live="polite"></span></p>' +
      '<p><a href="/privacy.html">Privacy notice</a> · <a href="/cookies.html">Cookie policy</a></p></div>'
    );
  }

  function visitorId() {
    try {
      if (window.OBFAccount && OBFAccount.visitorId) {
        var id = OBFAccount.visitorId();
        if (id) return id;
      }
    } catch (e) { /* fall through to storage */ }
    try { return localStorage.getItem("obf_vid") || ""; } catch (e) { return ""; }
  }

  function forget(status) {
    var id = visitorId();
    if (!id) {
      if (status) status.textContent = "No anonymous data is linked to this browser.";
      return;
    }
    if (status) status.textContent = "Deleting…";
    fetch(apiUrl("/api/privacy/forget"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visitor: id })
    }).then(function (res) {
      if (!res.ok) throw new Error("the API answered HTTP " + res.status);
      return res.json();
    }).then(function (data) {
      if (status) {
        status.textContent = data && data.removed
          ? "Done: " + data.removed + " row(s) removed."
          : "Done: nothing was linked to this browser.";
      }
    }).catch(function (err) {
      if (status) status.textContent = "Could not delete: " + err.message + ".";
    });
  }

  function build() {
    if (box) return box;
    box = document.createElement("section");
    box.id = "consent";
    box.setAttribute("role", "region");
    box.setAttribute("aria-labelledby", "consent-title");
    box.hidden = true;
    box.addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("[data-consent]") : null;
      if (!b) return;
      var value = b.dataset.consent;
      if (value === "forget") { forget(document.getElementById("cfstate")); return; }
      save(value);
    });
    document.body.appendChild(box);
    return box;
  }

  function paint() {
    var el = build();
    el.innerHTML = bannerHtml();
  }

  function show() {
    paint();
    build().hidden = false;
  }

  function hide() {
    if (box) box.hidden = true;
    openedManually = false;
  }

  /* Footer "Cookie settings": always available, whatever the current choice. */
  function open() {
    openedManually = true;
    show();
    if (box) box.scrollIntoView({ block: "nearest" });
  }

  function init() {
    try { document.documentElement.dataset.consent = choice() || "unset"; } catch (e) {}
    /* "Cookie settings" in the page footer: reopen the banner at any time. */
    var opener = document.getElementById("cookiesettings");
    if (opener) opener.addEventListener("click", function () { open(); });
    /* On a GPC/DNT signal we keep anonymous statistics off and say so, rather
       than showing a banner that pretends a choice is still open. */
    if (!decided() && gpcRefused()) {
      save("essential");
      if (box) box.hidden = true;
      return;
    }
    if (!decided()) show();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return {
    version: VERSION,
    choice: choice,
    decided: decided,
    canTrack: canTrack,
    save: save,
    open: open,
    hide: hide,
    visitorId: visitorId,
    forget: forget
  };
})();
