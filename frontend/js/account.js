/* openBatteryFlux — accounts, sessions and dashboards.

   Real authentication against the openBatteryFlux API. Sessions are Bearer
   tokens (see backend/app/main.py): the API returns a random token on login,
   sign-up and password reset; we keep it in localStorage and send it as
   "Authorization: Bearer <token>" with every account request. The API never
   sets cookies, so nothing here relies on them.

   The old demo version of this app stored a fake user in obf_user. That is
   gone: obf_user is now only a read cache for the signed-in user returned by
   /api/auth/me, and obf_token is the real session.
*/
(function () {
  "use strict";

  var STORAGE_TOKEN = "obf_token";
  var STORAGE_USER = "obf_user";
  var STORAGE_REDIRECT = "obf_redirect";
  var EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  var sessionToken = null;   // null = not read yet, "" = signed out
  var userCache = undefined; // undefined = not read yet
  var userPromise = null;    // in-flight /api/auth/me request
  var authMode = "login";    // the tab currently shown in the #auth dialog
  var adminWindow = "all";   // dashboard window selector (7, 30, all)
  var adminActSpan = "all";  // Activity chart filter (all, 30, 7) — its own, not the dashboard window
  var adminShowAll = false;  // Accounts section: the ten most active by default
  var adminData = null;      // last dashboard payload, for the cell detail dialog

  /* ---------------------------------------------------------------- helpers */

  var AMP = "&" + "amp;";
  var QUOT = "&" + "quot;";
  var LT = "&" + "lt;";
  var GT = "&" + "gt;";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, AMP)
      .replace(/"/g, QUOT)
      .replace(/</g, LT)
      .replace(/>/g, GT);
  }

  function getToken() {
    if (sessionToken === null) {
      try { sessionToken = localStorage.getItem(STORAGE_TOKEN) || ""; }
      catch (e) { sessionToken = ""; }
    }
    return sessionToken || "";
  }

  function setToken(value) {
    sessionToken = value || "";
    try {
      if (sessionToken) localStorage.setItem(STORAGE_TOKEN, sessionToken);
      else localStorage.removeItem(STORAGE_TOKEN);
    } catch (e) { /* private mode: session dies with the page */ }
  }

  function getCachedUser() {
    if (userCache !== undefined) return userCache;
    try {
      var raw = localStorage.getItem(STORAGE_USER);
      userCache = raw ? JSON.parse(raw) : null;
    } catch (e) { userCache = null; }
    return userCache;
  }

  function setCachedUser(user) {
    userCache = user || null;
    try {
      if (user) localStorage.setItem(STORAGE_USER, JSON.stringify(user));
      else localStorage.removeItem(STORAGE_USER);
    } catch (e) { /* ignore */ }
  }

  function closeModal(dlg) {
    if (!dlg) return;
    if (typeof dlg.close === "function") { try { dlg.close(); } catch (e) {} }
    else dlg.removeAttribute("open");
  }

  function openModal(dlg) {
    if (!dlg) return;
    if (typeof dlg.showModal === "function") { try { dlg.showModal(); } catch (e) {} }
    else dlg.setAttribute("open", "");
  }

  /* Every authenticated call goes through request(): it adds the Bearer header
     and turns a non-2xx answer into an Error whose message is the server's
     detail (or HTTP status). 401 clears the local session, because the token
     has expired or was revoked. */
  function request(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
    var method = (opts.method || "GET").toUpperCase();
    var body = opts.body;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    var tok = getToken();
    if (tok && !opts.keepSession) headers["Authorization"] = "Bearer " + tok;

    return fetch(window.OBF.apiUrl(path), {
      method: method,
      headers: headers,
      credentials: "omit",
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (res) {
      var text = "";
      var data = null;
      return res.text().then(function (t) {
        text = t;
        try { data = text ? JSON.parse(text) : null; }
        catch (e) { data = null; }
        if (res.ok) return data;

        if (res.status === 401 && tok && !opts.keepSession) {
          forgetSession();
        }
        var msg = (data && data.detail) || text || ("Request failed (HTTP " + res.status + ").");
        var err = new Error(msg);
        err.status = res.status;
        err.data = data;
        throw err;
      });
    });
  }

  /* -------------------------------------------------------------- session */

  function forgetSession() {
    setToken(null);
    setCachedUser(null);
    renderAuthBox();
  }

  /* Fetch the signed-in user. With no token this resolves to null without a
     network call, which is what the router's gate depends on. */
  function fetchUser() {
    if (!getToken()) return Promise.resolve(null);
    if (userPromise) return userPromise;
    userPromise = request("/api/auth/me")
      .then(function (data) {
        var u = (data && data.user) || null;
        setCachedUser(u);
        renderAuthBox();
        return u;
      })
      .catch(function (err) {
        if (err.status !== 401) console.error("Failed to fetch user:", err);
        setCachedUser(null);
        renderAuthBox();
        return null;
      })
      .then(function (u) {
        userPromise = null;
        return u;
      });
    return userPromise;
  }

  function remember(hash) {
    try { localStorage.setItem(STORAGE_REDIRECT, hash); } catch (e) { /* ignore */ }
  }

  function consumeRedirect() {
    var target = null;
    try {
      target = localStorage.getItem(STORAGE_REDIRECT);
      localStorage.removeItem(STORAGE_REDIRECT);
    } catch (e) { /* ignore */ }
    return target && /^#\//.test(target) ? target : null;
  }

  /* Re-run the router so gated views react to a changed session without a full
     page reload. route() listens to hashchange; if the hash did not move we
     dispatch the event ourselves. */
  function refreshApp(target) {
    try {
      if (target && target !== location.hash) location.hash = target;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } catch (e) {
      location.reload();
    }
  }

  /* ----------------------------------------------------------------- header */

  /* The home CTA offers the tools to users who already have an account, and
     keeps the sign-up pitch for visitors. Runs on every session change. */
  function renderHomeCta(u) {
    var cta = document.getElementById("cta");
    if (!cta) return;
    if (!u) {
      cta.innerHTML =
        "<h2>See what your cell really does.</h2>" +
        "<p>Create a free account and run your first simulation in a minute.</p>" +
        '<a class="btn lg" href="#/sim">Create your free account →</a>';
      return;
    }
    if (u.role === "admin" || u.email_verified) {
      cta.innerHTML =
        "<h2>What will you simulate next?</h2>" +
        "<p>You are signed in. Pick a tool and put your cells to work.</p>" +
        '<div class="obf-tools">' +
          '<a class="ot" href="#/compare"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5v14h18"/><path d="M6 7c5 0 8 3 10 8"/><path d="M6 11c4 0 7 1 9 4s3 3 5 3" stroke-dasharray="3 3"/></svg><span>Compare</span></a>' +
          '<a class="ot" href="#/sim"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5v14h18"/><path d="M6 8c5 0 7 2 9 6s3 3 5 3"/></svg><span>Simulate</span></a>' +
          '<a class="ot" href="#/calibrate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg><span>Calibrate</span></a>' +
          '<a class="ot" href="#/validate"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12l4 4 10-10"/><path d="M4 20h16"/></svg><span>Validate</span></a>' +
        "</div>";
    } else {
      cta.innerHTML =
        "<h2>Confirm your email to unlock the tools.</h2>" +
        "<p>You are signed in. Open the verification link we emailed you, and the tools unlock.</p>" +
        '<div class="nb-cta">' +
          '<a class="btn lg" href="#" onclick="window.OBFAccount.showVerifyWall();return false">Verify my email</a>' +
          '<a class="btn lg" href="#/account">My account</a>' +
        "</div>";
    }
  }

  function renderAuthBox() {
    var u = getCachedUser();
    var box = document.getElementById("authbox");
    if (!box) return "";
    renderHomeCta(u);

    if (!u) {
      box.innerHTML =
        '<div class="auth-box">' +
          '<button type="button" id="li" class="btn" onclick="window.OBFAccount.openAuth(\'login\')">Log in</button>' +
          '<button type="button" id="su" class="btn bp" onclick="window.OBFAccount.openAuth(\'signup\')">Sign up free</button>' +
        '</div>';
      return box.innerHTML;
    }

    var initial = (u.name || u.email || "?").trim().charAt(0).toUpperCase();
    box.innerHTML =
      '<div class="um">' +
        '<button type="button" class="av" id="umbt" aria-haspopup="true" aria-expanded="false" aria-label="Account menu">' +
          esc(initial) +
        '</button>' +
        '<div class="ummenu" id="ummenu" hidden>' +
          '<a href="#/account">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>' +
            "<span>Your account</span>" +
          "</a>" +
          (u.role === "admin"
            ? '<a href="#/admin">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' +
                "<span>Admin dashboard</span>" +
              "</a>"
            : "") +
          '<button type="button" id="umlo">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>' +
            "<span>Log out</span>" +
          "</button>" +
        '</div>' +
      '</div>';

    var bt = document.getElementById("umbt");
    var menu = document.getElementById("ummenu");
    if (bt && menu) {
      bt.onclick = function (e) {
        e.stopPropagation();
        var open = menu.hasAttribute("hidden");
        menu.toggleAttribute("hidden", !open);
        bt.setAttribute("aria-expanded", open ? "true" : "false");
      };
    }
    var lo = document.getElementById("umlo");
    if (lo) {
      lo.onclick = function (e) {
        e.stopPropagation();
        menu.hidden = true;
        bt.setAttribute("aria-expanded", "false");
        logout();
      };
    }
    if (!document.__obfUmWired) {
      document.__obfUmWired = true;
      document.addEventListener("click", function () {
        var m = document.getElementById("ummenu");
        var b = document.getElementById("umbt");
        if (!m || !b) return;
        m.hidden = true;
        b.setAttribute("aria-expanded", "false");
      });
    }
    return box.innerHTML;
  }

  /* ------------------------------------------------------------ auth dialog */

  function renderAuthDialog() {
    var su = authMode === "signup";
    var tabs = document.querySelectorAll("#atab button");
    tabs.forEach(function (b) {
      b.setAttribute("aria-pressed", b.dataset.t === authMode ? "true" : "false");
    });
    // The name, position and company/university belong to the sign-up form; a
    // returning account signs in with the email and password alone.
    ["nl", "pl", "ol"].forEach(function (id) {
      var field = document.getElementById(id);
      if (field) field.hidden = !su;
    });
    var at = document.getElementById("at");
    if (at) at.textContent = su ? "Create your account" : "Welcome back";
    var as = document.getElementById("as");
    if (as) as.textContent = su
      ? "It is free, and the tools unlock once you confirm the address."
      : "Sign in to keep using the tools.";
    var aerr = document.getElementById("aerr");
    if (aerr) aerr.textContent = "";
    var asub = document.getElementById("asub");
    if (asub) asub.textContent = su ? "Create free account" : "Log in";
    var ap = document.getElementById("ap");
    if (ap) ap.setAttribute("autocomplete", su ? "new-password" : "current-password");
    var aforgot = document.getElementById("aforgot");
    if (aforgot) aforgot.hidden = su;
  }

  function openAuth(type, emailHint) {
    authMode = type === "signup" ? "signup" : "login";
    renderAuthDialog();
    if (emailHint) {
      var hint = document.getElementById("ae");
      if (hint) hint.value = emailHint;
    }
    openModal(document.getElementById("auth"));
    var first = authMode === "signup" ? "an" : "ae";
    var focus = document.getElementById(first);
    if (focus) setTimeout(function () { focus.focus(); }, 40);
  }

  function submitAuth() {
    var email = (document.getElementById("ae").value || "").trim().toLowerCase();
    var password = document.getElementById("ap").value || "";
    var name = (document.getElementById("an").value || "").trim();
    var position = (document.getElementById("apos").value || "").trim();
    var organisation = (document.getElementById("ao").value || "").trim();
    var err = document.getElementById("aerr");
    var btn = document.getElementById("asub");

    if (!EMAIL_RE.test(email)) { if (err) err.textContent = "Enter a valid email address."; return; }
    if (!password) { if (err) err.textContent = "Enter a password."; return; }
    if (authMode === "signup" && password.length < 8) {
      if (err) err.textContent = "Password must have at least 8 characters.";
      return;
    }
    if (authMode === "signup" && !position) {
      if (err) err.textContent = "Tell us your position, for example student or engineer.";
      var pos = document.getElementById("apos");
      if (pos) pos.focus();
      return;
    }
    if (err) err.textContent = "";
    btn.disabled = true;

    var path = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    var body = { email: email, password: password };
    if (authMode === "signup") {
      body.name = name;
      body.position = position;
      body.organisation = organisation;
    }

    request(path, { method: "POST", body: body })
      .then(function (data) {
        setToken(data.token);
        setCachedUser(data.user);
        renderAuthBox();
        closeModal(document.getElementById("auth"));
        if (authMode === "signup" && data.user && !data.user.email_verified) {
          var sent = data.verification === "sent";
          var worksHere = data.user.role === "admin";
          var could_not = data.verification === "failed"
            ? "The verification email could not be sent."
            : "This server cannot send email.";
          alertMessage(
            sent ? "Check your inbox" : "Confirm your account",
            (sent
              ? "A verification link is on its way to " + data.user.email + ". " +
                "Open it to unlock the tools."
              : "The account " + data.user.email + " is not confirmed yet. " + could_not + " " +
                (worksHere
                  ? "You hold the administrator role on this deployment, so nothing is " +
                    "waiting on anyone else: open the dashboard and press Verify on your " +
                    "own row. The tools unlock immediately."
                  : "Another administrator has to confirm it from the dashboard. The tools " +
                    "unlock as soon as they do.")) +
            (data.notice ? "\n\n" + data.notice : ""),
            sent || !worksHere ? null : { label: "Open the dashboard", href: "#/admin" }
          );
        }
        // after signing in, open the page that asked for the login; home if there was none
        refreshApp(consumeRedirect() || "#/");
      })
      .catch(function (ex) {
        if (err) err.textContent = ex.message;
      })
      .finally(function () { btn.disabled = false; });
  }

  function alertMessage(title, message, action) {
    var dlg = document.createElement("dialog");
    dlg.innerHTML =
      '<div class="ad">' +
        '<h2 style="margin:10px 0 6px;font-size:22px">' + esc(title) + "</h2>" +
        '<p style="white-space:pre-line;color:var(--mut)">' + esc(message) + "</p>" +
        (action
          ? '<a class="btn bp wide" href="' + esc(action.href) + '" data-go>' +
            esc(action.label) + "</a>"
          : "") +
        '<button type="button" class="bp wide" data-ok>OK</button>' +
      "</div>";
    document.body.appendChild(dlg);
    var done = function () { closeModal(dlg); dlg.remove(); };
    dlg.addEventListener("click", function (e) {
      var go = e.target.closest("[data-go]");
      if (e.target === dlg || e.target.closest("[data-ok]")) done();
      else if (go) {
        e.preventDefault();
        var href = go.getAttribute("href") || "";
        done();
        if (href) location.hash = href;
      }
    });
    openModal(dlg);
  }

  /* ---------------------------------------------------------- forgot dialog */

  function openForgot() {
    var err = document.getElementById("fperr");
    if (err) { err.textContent = ""; err.className = "warn"; }
    openModal(document.getElementById("fpw"));
  }

  function submitForgot() {
    var email = (document.getElementById("fpe").value || "").trim().toLowerCase();
    var err = document.getElementById("fperr");
    var btn = document.getElementById("fpsub");
    if (!EMAIL_RE.test(email)) { if (err) err.textContent = "Enter a valid email address."; return; }
    err.textContent = "";
    btn.disabled = true;
    request("/api/auth/password/forgot", { method: "POST", body: { email: email } })
      .then(function (data) {
        err.className = "ok";
        err.textContent = data.message || "If that address has an account, a reset link is on its way.";
        setTimeout(function () { closeModal(document.getElementById("fpw")); }, 2600);
      })
      .catch(function (ex) {
        err.className = "warn";
        err.textContent = ex.message;
      })
      .finally(function () { btn.disabled = false; });
  }

  /* -------------------------------------------------------------- log out */

  function logout() {
    var tok = getToken();
    if (tok) {
      request("/api/auth/logout", { method: "POST", keepSession: true }).catch(function () {});
    }
    setToken(null);
    setCachedUser(null);
    renderAuthBox();
    try {
      if (window.OBF && OBF.library && OBF.library.cells) history.replaceState(null, "", "#/");
      refreshApp(null);
    } catch (e) { location.reload(); }
  }

  /* -------------------------------------------------------- verify wall */

  function showVerifyWall() {
    var wall = document.getElementById("verify-wall");
    if (!wall) return;
    var u = getCachedUser();
    // An administrator can confirm accounts from the dashboard, so an
    // unverified administrator is not blocked by anything: offer the dashboard
    // instead of telling them to wait for "an administrator".
    var admin = !!(u && u.role === "admin");
    wall.innerHTML =
      '<div class="vbanner" style="max-width:480px;margin:40px auto;background:var(--panel);padding:20px;border-radius:12px;text-align:center">' +
        '<h2>Email verification required</h2>' +
        '<p id="verify-lead" style="margin:6px 0 10px;color:var(--mut)">Confirm your email address to use the tools. ' +
        'We emailed a link to <b>' + esc(u && u.email || "") + "</b>. " +
        'If it has not arrived within a few minutes, check the spam folder and press ' +
        'Resend below.</p>' +
        '<p id="verify-msg" class="vmsg"></p>' +
        '<div class="acct-actions" style="justify-content:center">' +
          (admin
            ? '<a class="btn bp" id="vvadmin" href="#/admin">Confirm it in the dashboard</a>'
            : "") +
          '<button type="button" class="btn bp" id="vvresend">Resend verification email</button>' +
          '<button type="button" class="btn" id="vvok">OK</button>' +
        "</div>" +
      "</div>";
    wall.style.display = "block";
    var ok = document.getElementById("vvok");
    if (ok) ok.onclick = hideVerifyWall;
    var adminLink = document.getElementById("vvadmin");
    if (adminLink) adminLink.onclick = hideVerifyWall;
    var resend = document.getElementById("vvresend");
    if (resend) resend.onclick = resendVerifyAndShow;
    if (admin) {
      var ownLead = document.getElementById("verify-lead");
      if (ownLead) ownLead.innerHTML =
        "This account is not confirmed yet, but you hold the administrator role, so " +
        "nothing is waiting on anyone else: open the dashboard and press <b>Verify</b> " +
        "on the row for <b>" + esc(u.email) + "</b>. The tools unlock immediately.";
    }
    // Say what can actually happen here: without a mail service the link is
    // never sent, and only an administrator can confirm the account.
    request("/api/me/stats")
      .then(function (d) {
        var lead = document.getElementById("verify-lead");
        if (!lead || admin || !d || d.mail_configured !== false) return;
        lead.innerHTML =
          'This account is not confirmed yet, and this server cannot send email. ' +
          'Ask the administrator to confirm <b>' + esc(u && u.email || "") + "</b> " +
          'from the dashboard; the tools unlock as soon as the account is confirmed.';
        var button = document.getElementById("vvresend");
        if (button) button.style.display = "none";
      })
      .catch(function () {});
  }

  function hideVerifyWall() {
    var wall = document.getElementById("verify-wall");
    if (wall) wall.style.display = "none";
  }

  function resendVerifyAndShow() {
    var msg = document.getElementById("verify-msg");
    if (msg) { msg.textContent = "Sending…"; msg.className = "vmsg"; }
    request("/api/auth/verify/resend", { method: "POST", body: {} })
      .then(function () {
        if (msg) { msg.textContent = "A new verification link has been emailed to you."; msg.className = "vmsg vok"; }
      })
      .catch(function (ex) {
        if (msg) { msg.textContent = ex.message; msg.className = "vmsg vno"; }
      });
  }

  /* ------------------------------------------------------------- pages */

  function renderVerify(hashToken) {
    var box = document.getElementById("verifybody");
    if (!box) return;
    var value = (hashToken || "").trim();
    if (!value) {
      box.innerHTML = '<div class="card pnl vno"><h2>Invalid link</h2><p>This verification link is missing its token.</p></div>';
      return;
    }
    box.innerHTML = '<p class="note">Confirming your email address…</p>';
    request("/api/auth/verify", { method: "POST", body: { token: value } })
      .then(function (data) {
        box.innerHTML =
          '<div class="card pnl vbanner">' +
            "<h2>" + (data.already ? "Already verified" : "Email confirmed") + "</h2>" +
            "<p>" + esc(data.name || "") + " · " + esc(data.email || "") +
            (data.already
              ? " was already verified."
              : " is now verified. The tools are unlocked.") +
            "</p>" +
            '<div class="acct-actions"><a class="btn bp" href="#/sim">Start simulating →</a></div>' +
          "</div>";
        setCachedUser(null); // the stored user said unverified; /me below pulls a fresh copy
        fetchUser();
      })
      .catch(function (ex) {
        box.innerHTML =
          '<div class="card pnl vno"><h2>Verification failed</h2><p>' + esc(ex.message) +
          '</p><div class="acct-actions"><a class="btn" href="#/">Back to the home page</a></div></div>';
      });
  }

  function renderReset(hashToken) {
    var box = document.getElementById("resetbody");
    if (!box) return;
    var value = (hashToken || "").trim();
    if (!value) {
      box.innerHTML = '<div class="card pnl vno"><h2>Invalid link</h2><p>This reset link is missing its token.</p></div>';
      return;
    }
    box.innerHTML =
      '<div class="card pnl"><h2>Choose a new password</h2>' +
      '<form class="pw" id="resetf" novalidate>' +
        '<label>New password<input id="rn" type="password" autocomplete="new-password" placeholder="8 characters minimum"></label>' +
        '<label>Repeat it<input id="rr" type="password" autocomplete="new-password"></label>' +
        '<p id="rerr" class="warn" role="alert"></p>' +
        '<button type="submit" class="bp">Set new password</button>' +
      "</form></div>";
    document.getElementById("resetf").addEventListener("submit", function (e) {
      e.preventDefault();
      var p1 = document.getElementById("rn").value || "";
      var p2 = document.getElementById("rr").value || "";
      var err = document.getElementById("rerr");
      if (p1.length < 8) { err.textContent = "Password must have at least 8 characters."; return; }
      if (p1 !== p2) { err.textContent = "The two passwords do not match."; return; }
      err.textContent = "";
      this.querySelector("button").disabled = true;
      request("/api/auth/password/reset", { method: "POST", body: { token: value, new_password: p1 } })
        .then(function (data) {
          setToken(data.token);
          setCachedUser(data.user);
          renderAuthBox();
          box.innerHTML =
            '<div class="card pnl vbanner"><h2>Password reset</h2>' +
            "<p>Your new password is set and you are signed in.</p>" +
            '<div class="acct-actions"><a class="btn bp" href="#/sim">Continue →</a></div></div>';
        })
        .catch(function (ex) { err.textContent = ex.message; });
    });
  }

  /* Fallback for any leftover inline call from the old fragment: re-render the
     reset page from the current hash. */
  function confirmReset() {
    var parts = (location.hash || "").split("/");
    renderReset(parts[parts.length - 1] || "");
  }

  /* ------------------------------------------------- account page */

  function renderAccount() {
    var box = document.getElementById("accbody");
    if (!box) return Promise.resolve();
    box.innerHTML = '<p class="note">Loading your profile…</p>';
    return request("/api/me/stats")
      .then(function (data) {
        box.innerHTML = accountBody(data);
        wireAccount(box);
      })
      .catch(function (ex) {
        if (ex.status === 401) { box.innerHTML = ""; return; }
        box.innerHTML = '<div class="card pnl vno"><h2>Could not load your profile</h2><p>' + esc(ex.message) + "</p></div>";
      });
  }

  var TOOL_LABELS = {
    simulate: "Simulations", compare: "Comparisons", calibrate: "Calibrations",
    validate: "Validations", export: "Exports", library: "Library"
  };

  function accountBody(d) {
    var u = d.user || {};
    var initials = (u.name || u.email || "?").trim().charAt(0).toUpperCase();
    var roleBadge = '<span class="role' + (u.role === "admin" ? " admin" : "") + '">' + esc(u.role || "user") + "</span>";
    var verifiedBadge = u.email_verified
      ? '<span class="role avok" style="background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)">Email verified</span>'
      : '<span class="role avno" style="background:color-mix(in srgb,var(--warn) 18%,transparent);color:var(--warn)">Email not verified</span>';

    var knead = 0;
    var chips = Object.keys(TOOL_LABELS).map(function (k) {
      var n = d.counts && d.counts[k] || 0;
      knead += n;
      return '<div class="kpi"><small>' + TOOL_LABELS[k] + "</small><b>" + n + "</b></div>";
    }).join("");

    var recent = (d.recent && d.recent.length)
      ? '<ul class="feed">' + d.recent.map(function (ev) {
          return "<li><span><b>" + esc(TOOL_LABELS[ev.kind] || ev.kind || "activity") + "</b>" +
            (ev.detail ? " · " + esc(ev.detail) : "") + "</span><time>" + esc(fmtStamp(ev.created_at)) + "</time></li>";
        }).join("") + "</ul>"
      : '<p class="empty">No activity yet. Run a simulation, calibration or export and it shows up here.</p>';

    return (
      '<div class="card pnl vbanner" style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
        '<div style="width:56px;height:56px;border-radius:50%;display:grid;place-items:center;font-size:24px;font-weight:800;color:var(--onacc);background:var(--acc)">' + esc(initials) + "</div>" +
        '<div style="flex:1;min-width:200px">' +
          "<h2 style='margin:0 0 2px;font-size:20px'>" + esc(u.name || "?") + "</h2>" +
          "<p style='margin:0;color:var(--mut)'>" + esc(u.email || "") + "</p>" +
        "</div>" +
        "<div>" + roleBadge + " " + verifiedBadge + "</div>" +
      "</div>" +
      '<div class="acct-grid">' +
        '<div class="card pnl"><h2>Tool usage</h2>' +
          '<div class="kpis">' + chips + "</div>" +
          '<p class="dash-note">' + knead + ' tool uses recorded in total ' +
          (d.mail_configured ? "" : "(email is not configured on this server, so an administrator confirms new accounts)") + "</p>" +
          "<h2 style='margin-top:18px'>Recent activity</h2>" +
          recent +
        "</div>" +
        '<div class="card pnl"><h2>Profile</h2>' +
          '<dl class="kv">' +
            kv("Member since", fmtStamp(u.created_at)) +
            kv("Role", esc(u.role || "user")) +
            kv("Position", u.position) +
            kv("Company or university", u.organisation) +
            kv("Email verified", u.email_verified ? "Yes" : "No") +
            kv("Last login", fmtStamp(u.last_login_at)) +
            kv("Last seen", fmtStamp(u.last_seen_at)) +
          "</dl>" +
          '<div class="card pnl acct-pw" style="margin-top:14px"><h2>Profile details</h2>' +
            '<form class="pw" id="nf" novalidate>' +
              '<label>Display name<input id="nn" value="' + esc(u.name || "") + '" maxlength="80" autocomplete="name"></label>' +
              '<label>Position<input id="npos" value="' + esc(u.position || "") + '" placeholder="e.g. student, engineer" maxlength="80" autocomplete="organization-title" required></label>' +
              '<label>Company or university <span class="opt">optional</span><input id="norg" value="' + esc(u.organisation || "") + '" maxlength="120" autocomplete="organization"></label>' +
              '<p id="nerr" class="warn" role="alert"></p>' +
              '<button type="submit" class="bp">Save details</button>' +
            "</form></div>" +
          '<div class="card pnl acct-pw" style="margin-top:14px"><h2>Change password</h2>' +
            '<form class="pw" id="cpf" novalidate>' +
              '<label>Current password<input id="cpc" type="password" autocomplete="current-password"></label>' +
              '<label>New password<input id="cpn" type="password" autocomplete="new-password" placeholder="8 characters minimum"></label>' +
              '<label>Repeat new password<input id="cpr" type="password" autocomplete="new-password"></label>' +
              '<p id="cperr" class="warn" role="alert"></p>' +
              '<button type="submit" class="bp">Update password</button>' +
            "</form></div>" +
        "</div>" +
      "</div>" +
      '<div class="card pnl"><h2>Email</h2>' +
        '<p class="dash-note">We email you in exactly two cases: to confirm this address, and to send a password-reset link that someone asked for. There is no newsletter, no digest and no marketing.</p>' +
        '<form class="pw" id="emf" novalidate>' +
          '<label class="chk" style="display:flex;gap:8px;align-items:flex-start;font-size:14px;color:var(--mut)"><input type="checkbox" id="emoff"' + (u.email_off ? " checked" : "") + '><span>Unsubscribe from account email</span></label>' +
          '<p class="note" style="font-size:12.5px;color:var(--mut);margin:6px 0 0">With this on, we send nothing at all: no reminders, no news. Password-reset links are still delivered, because without them a forgotten password would lock you out of your own account; delete the account below to stop those as well.</p>' +
          '<p id="emerr" class="warn" role="alert"></p>' +
          '<button type="submit" class="bp">Save email setting</button>' +
        "</form>" +
      "</div>" +
      '<div class="card pnl"><h2>Privacy</h2>' +
        '<ul class="xl">' +
          '<li><a class="docl" href="/privacy.html">Privacy notice</a> — what is stored, for how long, and your rights.</li>' +
          '<li><a class="docl" href="/cookies.html">Cookie policy</a> — we set no cookies, and it lists what is kept in your browser.</li>' +
          '<li><a class="docl" href="/terms.html">Terms of service</a> — including the engineering and safety disclaimer.</li>' +
        "</ul>" +
        '<p class="dash-note">The button below deletes the anonymous usage rows for this browser. It is not tied to your account, so it also works when you are signed out. Deleting the account removes everything linked to it.</p>' +
        '<div class="acct-actions"><button type="button" class="btn" id="forget">Delete my anonymous usage data</button><span id="forgetstate" role="status" aria-live="polite" style="margin-left:10px;font-size:13px;color:var(--mut)"></span></div>' +
      "</div>" +
      '<div class="card pnl acct-danger"><h2>Delete account</h2>' +
        "<p class='empty'>This permanently removes your account and its session, and cannot be undone. " +
        "Your cell library and this page are unaffected.</p>" +
        '<form class="pw" id="delf" novalidate>' +
          '<label>Confirm by typing your password<input id="delpw" type="password" autocomplete="current-password"></label>' +
          '<p id="delerr" class="warn" role="alert"></p>' +
          '<button type="submit" class="bp danger">Delete my account</button>' +
        "</form></div>"
    );
  }

  function kv(k, v) {
    return "<div><dt>" + esc(k) + "</dt><dd>" + (v ? esc(v) : '<span style="color:var(--mut)">—</span>') + "</dd></div>";
  }

  function fmtStamp(stamp) {
    if (!stamp) return null;
    var m = String(stamp).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return String(stamp);
    return m[2] + "/" + m[3] + "/" + m[1] + " " + m[4] + ":" + m[5];
  }

  function wireAccount(box) {
    var cpf = document.getElementById("cpf");
    if (cpf) {
      cpf.addEventListener("submit", function (e) {
        e.preventDefault();
        var cur = document.getElementById("cpc").value || "";
        var p1 = document.getElementById("cpn").value || "";
        var p2 = document.getElementById("cpr").value || "";
        var err = document.getElementById("cperr");
        if (!cur) { err.textContent = "Enter your current password."; return; }
        if (p1.length < 8) { err.textContent = "Password must have at least 8 characters."; return; }
        if (p1 !== p2) { err.textContent = "The two new passwords do not match."; return; }
        err.textContent = "";
        var btn = cpf.querySelector("button");
        btn.disabled = true;
        request("/api/auth/password", { method: "POST", body: { current_password: cur, new_password: p1 } })
          .then(function () {
            err.className = "ok vok";
            err.textContent = "Password updated. Other sessions were signed out.";
            cpf.querySelectorAll("input").forEach(function (i) { i.value = ""; });
          })
          .catch(function (ex) { err.className = "warn"; err.textContent = ex.message; })
          .finally(function () { btn.disabled = false; });
      });
    }

    var delf = document.getElementById("delf");
    if (delf) {
      delf.addEventListener("submit", function (e) {
        e.preventDefault();
        var pass = document.getElementById("delpw").value || "";
        var err = document.getElementById("delerr");
        if (!pass) { err.textContent = "Enter your password to confirm."; return; }
        err.textContent = "";
        var btn = delf.querySelector("button");
        btn.disabled = true;
        btn.textContent = "Deleting…";
        request("/api/account/delete", { method: "POST", body: { password: pass } })
          .then(function () {
            setToken(null);
            setCachedUser(null);
            renderAuthBox();
            alertMessage("Account deleted", "Your account and its data were removed.");
            refreshApp(null);
          })
          .catch(function (ex) { err.textContent = ex.message; btn.textContent = "Delete my account"; })
          .finally(function () { btn.disabled = false; });
      });
    }

    var emf = document.getElementById("emf");
    if (emf) {
      emf.addEventListener("submit", function (e) {
        e.preventDefault();
        var off = document.getElementById("emoff").checked;
        var err = document.getElementById("emerr");
        var btn = emf.querySelector("button");
        err.textContent = "";
        err.className = "";
        btn.disabled = true;
        request("/api/account/email", { method: "POST", body: { off: off } })
          .then(function (res) {
            if (res && res.user) setCachedUser(res.user);
            err.className = "ok vok";
            err.textContent = off
              ? "Account email is off. A password-reset link is still sent if you ask for one."
              : "Account email is on again.";
          })
          .catch(function (ex) { err.className = "warn"; err.textContent = ex.message; })
          .finally(function () { btn.disabled = false; });
      });
    }

    var forget = document.getElementById("forget");
    if (forget) {
      forget.addEventListener("click", function () {
        var status = document.getElementById("forgetstate");
        if (window.OBFConsent && OBFConsent.forget) OBFConsent.forget(status);
      });
    }

    var nf = document.getElementById("nf");
    if (nf) {
      nf.addEventListener("submit", function (e) {
        e.preventDefault();
        var name = (document.getElementById("nn").value || "").trim();
        var position = (document.getElementById("npos").value || "").trim();
        var organisation = (document.getElementById("norg").value || "").trim();
        var err = document.getElementById("nerr");
        // A save leaves "Details saved." in this line, styled as success; a
        // refused edit has to take the styling back or the warning reads green.
        if (!name) { err.className = "warn"; err.textContent = "Enter a name."; return; }
        if (!position) {
          err.className = "warn";
          err.textContent = "Tell us your position, for example student or engineer.";
          document.getElementById("npos").focus();
          return;
        }
        err.textContent = "";
        var btn = nf.querySelector("button");
        btn.disabled = true;
        request("/api/account/profile", {
          method: "POST",
          body: { name: name, position: position, organisation: organisation }
        })
          .then(function (u) {
            setCachedUser(u);
            renderAuthBox();
            // Reload the page body so the profile summary shows the new values,
            // and say so afterwards: the reload replaces the form this message
            // lives in, which would wipe it if it came first.
            renderAccount().then(function () {
              var fresh = document.getElementById("nerr");
              if (fresh) { fresh.className = "ok vok"; fresh.textContent = "Details saved."; }
            });
          })
          .catch(function (ex) { err.className = "warn"; err.textContent = ex.message; })
          .finally(function () { btn.disabled = false; });
      });
    }
  }

  /* --------------------------------------------------------------- admin */

  function renderAdmin(windowKey) {
    if (windowKey) adminWindow = String(windowKey).toLowerCase();
    var box = document.getElementById("adminbody");
    if (!box) return;
    box.innerHTML = '<p class="note">Loading the dashboard…</p>';
    return request("/api/admin/stats?window=" + encodeURIComponent(adminWindow))
      .then(function (d) { adminData = d; paintAdmin(); })
      .catch(function (ex) {
        if (ex.status === 403) {
          box.innerHTML = '<div class="card pnl vno"><h2>For administrators only</h2><p>' + esc(ex.message) + "</p></div>";
        } else {
          box.innerHTML = '<div class="card pnl vno"><h2>Could not load the dashboard</h2><p>' + esc(ex.message) + "</p></div>";
        }
      });
  }

  /* Redraw the payload already in hand. The activity chart's own filter and
     "show all accounts" only change what is displayed, and each of them used to
     cost a full round of dashboard queries against the account database. */
  function paintAdmin() {
    var box = document.getElementById("adminbody");
    if (!box || !adminData) return;
    box.innerHTML = adminBody(adminData);
    wireAdminGlobal();
  }

  var WINDOW_KEYS = [["7", "7 days"], ["30", "30 days"], ["all", "All time"]];

  var TOOL_META = {
    simulate:  { tag: "Simulate",  color: "var(--acc)" },
    compare:   { tag: "Compare",   color: "var(--c-nca)" },
    calibrate: { tag: "Calibrate", color: "var(--c-lfp)" },
    validate:  { tag: "Validate",  color: "var(--c-na)" },
    export:    { tag: "Export",    color: "var(--c-lto)" },
    library:   { tag: "Library",   color: "var(--c-alkaline)" }
  };
  var TOOL_ICON = {
    simulate: "sim", compare: "cmp", calibrate: "cal", validate: "val", export: "exp", library: "lib"
  };

  function top_kpis(t) {
    return (
      kpi("Users", t.users, "total on the server") +
      kpi("New in window", t.new, "sign-ups") +
      kpi("Active", t.active, "24 h: " + (t.active_24h || 0)) +
      kpi("Admins", t.admins, "") +
      kpi("Verified", t.verified, "of users") +
      kpi("Events", t.events, "tool uses + account events")
    );
  }

  /* ---------------------------------------------------------------- helpers */

  function adKpi(label, val, sub) {
    return (
      '<div class="card pnl adkpi">' +
        '<span class="adkpi-lab">' + esc(label) + '</span>' +
        '<span class="adkpi-val">' + (val == null ? '—' : val) + '</span>' +
        (sub ? '<span class="adkpi-sub">' + esc(sub) + '</span>' : '') +
      '</div>'
    );
  }

  function adBar(n, max, color) {
    var pct = max ? Math.max(3, Math.round(n / max * 100)) : 0;
    return '<div class="adbar"><i style="width:' + pct + '%;background:' + color + '"></i></div>';
  }

  function adTrafficChart(traffic, days, emptyText) {
    if (!traffic || !traffic.length) return '<p class="empty">' + esc(emptyText || 'No traffic data yet.') + '</p>';
    var maxV = 1;
    traffic.forEach(function (b) { var s = (b.users || 0) + (b.guests || 0); if (s > maxV) maxV = s; });
    var bars = traffic.map(function (b, i) {
      var u = b.users || 0, g = b.guests || 0, tot = u + g;
      var hu = Math.max(0, Math.round(u / maxV * 100));
      var hg = Math.max(0, Math.round(g / maxV * 100));
      var last = i === traffic.length - 1;
      return (
        '<div class="adtbar' + (last ? ' last' : '') + '" title="' + esc(b.date) + ': ' + u + ' users, ' + g + ' guests">' +
          '<div class="adtbar-u" style="height:' + hu + '%"></div>' +
          '<div class="adtbar-g" style="height:' + hg + '%"></div>' +
        '</div>'
      );
    }).join('');
    var first = traffic[0] || {}, last = traffic[traffic.length - 1] || {};
    return (
      '<div class="adchart">' + bars + '</div>' +
      '<div class="adchart-foot">' +
        '<span>' + esc(first.date || '') + '</span>' +
        '<div class="adchart-leg">' +
          '<span class="adchart-dot u"></span>Users ' +
          '<span class="adchart-dot g"></span>Guests' +
        '</div>' +
        '<span>' + esc(last.date || '') + '</span>' +
      '</div>'
    );
  }

  function adSignupChart(signups) {
    if (!signups || !signups.length) return '<p class="empty">No sign-ups in this window.</p>';
    var maxV = 1;
    signups.forEach(function (s) { if (s.count > maxV) maxV = s.count; });
    var bars = signups.map(function (s, i) {
      var h = Math.max(3, Math.round(s.count / maxV * 100));
      return '<div class="adsbar' + (i === signups.length - 1 ? ' last' : '') + '" style="height:' + h + '%" title="' + esc(s.date) + ': ' + s.count + '"></div>';
    }).join('');
    return (
      '<div class="adchart">' + bars + '</div>' +
      '<div class="adchart-foot"><span>' + esc((signups[0] || {}).date || '') + '</span><span>' + esc((signups[signups.length - 1] || {}).date || '') + '</span></div>'
    );
  }



  function adminBody(d) {
    adminData = d;
    var t   = d.totals   || {};
    var win = d.window   || {};
    var aud = d.audience || { users: {}, guests: {} };
    var tools   = d.tools   || [];
    var cells   = d.cells   || { overall: [], users: [], guests: [] };
    var traffic = d.traffic || [];
    var signups = d.signups || [];
    var recent  = d.recent  || [];
    var users   = d.users   || [];
    var guests  = d.guests  || [];

    /* ---- window selector ---- */
    var winSel =
      '<div class="seg admwin">' +
      WINDOW_KEYS.map(function (w) {
        return '<button type="button" data-window="' + w[0] + '" aria-pressed="' + (w[0] === win.key ? 'true' : 'false') + '">' + w[1] + '</button>';
      }).join('') +
      '</div>';

    /* ---- top KPIs ---- */
    var kpis =
      '<div class="kpis">' +
        adKpi('Total users',   t.users,      'on this server') +
        adKpi('New',           t.new,        'sign-ups in window') +
        adKpi('Active',        t.active,     '24 h: ' + (t.active_24h || 0)) +
        adKpi('Verified',      t.verified,   'of ' + t.users + ' users') +
        adKpi('User visits',   aud.users.visits,  win.label) +
        adKpi('Guest visits',  aud.guests.visits, win.label) +
        adKpi('Cell views',    (aud.users.views || 0) + (aud.guests.views || 0), 'users + guests') +
        adKpi('Tool opens',    aud.users.opens,   'signed-in only') +
        adKpi('Sign-up walls', aud.guests.gates,  'guests blocked') +
      '</div>';

    /* ---- audience split ---- */
    var totalVisits = (aud.users.visits || 0) + (aud.guests.visits || 0) || 1;
    var uPct = Math.round((aud.users.visits || 0) / totalVisits * 100);
    var gPct = 100 - uPct;
    var audienceHtml =
      '<div class="card pnl">' +
        '<h2>Audience</h2>' +
        '<div class="adaud">' +
          '<div class="adaud-half">' +
            '<span class="adaud-label">Signed-in users</span>' +
            '<span class="adaud-big">' + (aud.users.people || 0) + '</span>' +
            '<span class="adaud-sub">' + (aud.users.visits || 0) + ' visits · ' + (aud.users.views || 0) + ' cell views · ' + (aud.users.uses || 0) + ' cell uses</span>' +
          '</div>' +
          '<div class="adaud-div"></div>' +
          '<div class="adaud-half">' +
            '<span class="adaud-label">Anonymous guests</span>' +
            '<span class="adaud-big guest">' + (aud.guests.people || 0) + '</span>' +
            '<span class="adaud-sub">' + (aud.guests.visits || 0) + ' visits · ' + (aud.guests.views || 0) + ' cell views · ' + (aud.guests.gates || 0) + ' sign-up walls</span>' +
          '</div>' +
        '</div>' +
        '<div class="adaud-bar">' +
          '<div class="adaud-bar-u" style="width:' + uPct + '%" title="Users ' + uPct + '%"></div>' +
          '<div class="adaud-bar-g" style="width:' + gPct + '%" title="Guests ' + gPct + '%"></div>' +
        '</div>' +
      '</div>';

    /* ---- traffic chart ---- */
    var trafficHtml =
      '<div class="card pnl">' +
        '<h2>Traffic <span class="adchip">' + esc(win.label || '') + '</span></h2>' +
        adTrafficChart(traffic, win.days) +
      '</div>';

    /* ---- sign-ups chart ---- */
    var signupHtml =
      '<div class="card pnl">' +
        '<h2>Sign-ups <span class="adchip">' + esc(win.label || '') + '</span></h2>' +
        adSignupChart(signups) +
      '</div>';

    /* ---- per-tool panel ---- */
    var totalOpens = 0;
    tools.forEach(function (tool) { totalOpens += tool.opens || 0; });
    var toolRows = tools.map(function (tool) {
      var meta  = TOOL_META[tool.kind] || { tag: tool.kind, color: 'var(--acc)' };
      var n     = tool.opens || 0;
      var pct   = totalOpens ? Math.max(3, Math.round(n / totalOpens * 100)) : 0;
      var top1  = (tool.top_cells || [])[0];
      return (
        '<div class="adtool" style="--tc:' + meta.color + '">' +
          '<div class="adtool-head">' +
            '<span class="adtool-tag">' + esc(meta.tag) + '</span>' +
            '<span class="adtool-n">' + n + ' opens</span>' +
          '</div>' +
          adBar(n, totalOpens, meta.color) +
          '<div class="adtool-meta">' +
            '<span>' + (tool.users || 0) + ' user' + (tool.users === 1 ? '' : 's') + '</span>' +
            '<span>' + (tool.cell_uses || 0) + ' cell uses</span>' +
            '<span>' + (tool.guest_gates || 0) + ' guest walls</span>' +
            (tool.last_at ? '<span>last ' + esc(fmtStamp(tool.last_at)) + '</span>' : '') +
          '</div>' +
          (top1 ? '<div class="adtool-top">' + adCellCard(top1, meta.color) + '</div>' : '') +
        '</div>'
      );
    }).join('');
    var toolsHtml =
      '<div class="card pnl">' +
        '<h2>Tools <span class="adchip">most used first</span></h2>' +
        '<div class="adtools">' + (toolRows || '<p class="empty">No tool use yet.</p>') + '</div>' +
      '</div>';

    /* ---- cells panel: same tiles as the Tools section ---- */
    /* Which cells to show. The anonymous counters cover every visitor and are
       the real popularity, so they lead, and they are all time by nature; the
       window's own rows (consented visitors only) add the audience detail for
       the cells that also appear there. Without counters — a deployment that
       has counted nothing yet — the window rows are all there is. */
    var overallCells = cells.overall || [];
    var anonCells = cells.popular || [];
    var windowById = {};
    overallCells.forEach(function (c) { windowById[c.id] = c; });
    var counted = anonCells.length > 0;
    var cellRows = (counted ? anonCells : overallCells).map(function (c) {
      var detail = windowById[c.id] || {};
      return {
        id: c.id,
        name: c.name || detail.name || c.id,
        total: c.total || 0,
        views: c.views || 0,
        uses: c.uses || 0,
        /* The counters say nothing about who, so these stay unknown unless the
           window's consented rows know this cell. */
        users: counted ? detail.users : (c.users || 0),
        guests: counted ? detail.guests : (c.guests || 0)
      };
    });
    var cellPeak = cellRows.reduce(function (m, c) { return Math.max(m, c.total); }, 0);
    var cellTiles = cellRows.map(function (cell) {
      var name = cell.name || cell.id || '—';
      var audienceKnown = cell.users != null || cell.guests != null;
      return (
        '<div class="adtool adtile-click" role="button" tabindex="0" data-adcell="' + esc(cell.id || '') + '"' +
          ' style="--tc:var(--acc)" aria-label="Details for ' + esc(name) + '">' +
          '<div class="adtool-head">' +
            '<span class="adtool-tag name" title="' + esc(name) + '">' + esc(name) + '</span>' +
          '</div>' +
          '<div class="adtool-total">' + cell.total + ' total</div>' +
          adBar(cell.total, cellPeak, 'var(--acc)') +
          '<div class="adtool-meta">' +
            '<span>' + cell.views + ' views</span>' +
            '<span>' + cell.uses + ' uses</span>' +
            (audienceKnown
              ? '<span>' + (cell.users || 0) + ' users</span>' +
                '<span>' + (cell.guests || 0) + ' guests</span>'
              : '') +
          '</div>' +
        '</div>'
      );
    }).join('');



    function adCellCard(cell, color) {
      if (!cell) return '';
      /* `count` is every logged row for the cell, so on the panels that mix
         views and uses it overstates the uses. The API sends the two apart, so
         print them apart. */
      var uses = (cell.uses == null ? cell.count : cell.uses) || 0;
      var views = typeof cell.views === 'number' ? cell.views : null;
      var sub = uses + ' use' + (uses === 1 ? '' : 's') +
                (views === null ? '' : ' · ' + views + ' view' + (views === 1 ? '' : 's'));
      return (
        '<div class="adtool-top-item" style="--c:' + color + '">' +
          '<div class="adtool-top-dot" style="background:color-mix(in srgb,' + color + ' 18%,transparent);color:' + color + '">' +
            esc((cell.name || '?').charAt(0).toUpperCase()) +
          '</div>' +
          '<div class="adtool-top-meta">' +
            '<b title="' + esc(cell.name || '') + '">' + esc(cell.name || cell.id || '—') + '</b>' +
            '<small>' + sub + '</small>' +
          '</div>' +
        '</div>'
      );
    }

    var cellsHtml =
      '<div class="card pnl">' +
        '<h2>Most-used cells <span class="adchip">' +
          (counted ? 'all time · counted anonymously' : esc(win.label || '')) +
        '</span></h2>' +
        (cellTiles
          ? '<div class="adtools adtools-grid">' + cellTiles + '</div>' +
            '<p class="dash-note">How often each cell was opened or loaded into a ' +
              'tool, counted for every visitor with no identifier stored. Users and ' +
              'guests come from the usage log for ' + esc(win.label || '') + ', so they ' +
              'appear only for cells that consenting visitors used in that window.</p>'
          : '<p class="empty">No cell activity yet: neither the anonymous counters ' +
            'nor the usage log has anything to show.</p>') +
      '</div>';
    /* ---- live feed ---- */
    var ACTION_ICON = { visit: '🌐', view: '👁', use: '⚡', gate: '🔒', open: '▶', account: '👤' };
    var feedHtml =
      '<div class="card pnl">' +
        '<h2>Live feed <span class="adchip">' + esc(win.label || '') + '</span></h2>' +
        (recent.length
          ? '<ul class="adfeed">' + recent.map(function (ev) {
              var icon = ACTION_ICON[ev.action] || '·';
              var isGuest = ev.audience === 'guest';
              return (
                '<li class="adfeed-item' + (isGuest ? ' guest' : '') + '">' +
                  '<span class="adfeed-ic">' + icon + '</span>' +
                  '<span class="adfeed-body">' +
                    '<b>' + esc(ev.who || '?') + '</b>' +
                    (ev.tool ? ' · <span class="adtag" style="--tc:' + (TOOL_META[ev.tool] || { color: 'var(--acc)' }).color + '">' + esc((TOOL_META[ev.tool] || { tag: ev.tool }).tag) + '</span>' : '') +
                    (ev.cell ? ' · <em>' + esc(ev.cell) + '</em>' : '') +
                    (ev.detail ? ' · ' + esc(ev.detail) : '') +
                  '</span>' +
                  '<time class="adfeed-time">' + esc(fmtStamp(ev.created_at)) + '</time>' +
                '</li>'
              );
            }).join('') + '</ul>'
          : '<p class="empty">No activity in this window.</p>') +
      '</div>';

    /* ---- accounts: the ten most active as tiles, the rest behind a button ---- */
    var meIsAdmin = getCachedUser() || {};
    var ranked = users.slice().sort(function (a, b) {
      return (b.total_events || 0) - (a.total_events || 0) ||
             String(b.last_seen_at || "").localeCompare(String(a.last_seen_at || ""));
    });
    var shownUsers = adminShowAll ? ranked : ranked.slice(0, 10);
    var userPeak = ranked.reduce(function (m, u) { return Math.max(m, u.total_events || 0); }, 0);
    var userRows = shownUsers.map(function (u) {
      var actions = '';
      if (u.id === meIsAdmin.id) {
        actions = '<span class="rowwhy">you</span>';
        /* An administrator can confirm any address, so they can confirm their
           own: without this button a deployment that cannot send email would
           leave the operator's account unverified for ever, with nobody above
           them to press it. */
        if (!u.email_verified) {
          actions += '<button type="button" class="rowbtn" data-auid="' + u.id + '" data-verify>Verify</button>';
        }
      } else if (d.admin_email && u.email && String(u.email).toLowerCase() === String(d.admin_email).toLowerCase()) {
        actions = '<span class="rowwhy">protected</span>';
      } else {
        actions += u.role !== 'admin'
          ? '<button type="button" class="rowbtn" data-auid="' + u.id + '" data-role="admin">Promote</button>'
          : '<button type="button" class="rowbtn" data-auid="' + u.id + '" data-role="user">Demote</button>';
        if (!u.email_verified) {
          actions += '<button type="button" class="rowbtn" data-auid="' + u.id + '" data-verify>Verify</button>';
        }
        /* The last administrator cannot be deleted, so the button is not
           offered until somebody else can keep the dashboard reachable. */
        var otherAdmins = users.filter(function (x) {
          return x.role === 'admin' && x.id !== u.id;
        }).length;
        if (u.role !== 'admin' || otherAdmins) {
          actions += '<button type="button" class="rowbtn danger" data-auid="' + u.id + '" data-delete>Delete</button>';
        }
      }
      if (!actions) actions = '<span class="rowwhy">—</span>';
      var fav = u.favourite_cell;
      return (
        '<div class="adtool" style="--tc:var(--acc)">' +
          '<div class="adtool-head">' +
            '<span class="adtool-tag name" title="' + esc(u.email || '') + '">' + esc(u.name || u.email || '—') + '</span>' +
            '<span class="adtool-n">' + (u.total_events || 0) + ' events</span>' +
          '</div>' +
          '<div class="adtool-mail">' + esc(u.email || '') + '</div>' +
          adBar(u.total_events || 0, userPeak, 'var(--acc)') +
          '<div class="adtool-meta">' +
            '<span>' + esc(u.role || 'user') + (u.email_verified ? ' · verified' : ' · unverified') + '</span>' +
            '<span>' + (u.cell_uses || 0) + ' cell uses</span>' +
            (fav ? '<span>fav ' + esc(String(fav.name || '').substring(0, 18)) + ' ×' + (fav.count || 0) + '</span>' : '') +
            (u.last_seen_at ? '<span>seen ' + esc(fmtStamp(u.last_seen_at)) + '</span>' : '') +
          '</div>' +
          '<div class="adtool-acts">' + actions + '</div>' +
        '</div>'
      );
    }).join('');
    var accountsHtml =
      '<div class="card pnl">' +
        '<h2>Accounts <span class="adchip">' + users.length + ' total · most active first</span></h2>' +
        (userRows
          ? '<div class="adtools adtools-grid">' + userRows + '</div>'
          : '<p class="empty">No accounts yet.</p>') +
        (users.length > 10
          ? '<div class="admore"><button type="button" class="btn" data-adall>' +
              (adminShowAll
                ? 'Show the 10 most active'
                : 'Show all ' + users.length + ' accounts') +
            '</button></div>'
          : '') +
      '</div>';
    /* ---- anonymous guests: same tiles as the Tools section ---- */
    var guestPeak = guests.reduce(function (m, g) { return Math.max(m, g.visits || 0); }, 0);
    var guestTiles = guests.map(function (g) {
      return (
        '<div class="adtool" style="--tc:var(--acc2)">' +
          '<div class="adtool-head">' +
            '<span class="adtool-tag name">Guest ' + esc(g.id || '') + '</span>' +
            '<span class="adtool-n">' + (g.visits || 0) + ' visits</span>' +
          '</div>' +
          adBar(g.visits || 0, guestPeak, 'var(--acc2)') +
          '<div class="adtool-meta">' +
            '<span>' + (g.views || 0) + ' cell views</span>' +
            '<span>' + (g.gates || 0) + ' sign-up walls</span>' +
            (g.first_at ? '<span>first ' + esc(fmtStamp(g.first_at)) + '</span>' : '') +
            (g.last_at ? '<span>last ' + esc(fmtStamp(g.last_at)) + '</span>' : '') +
          '</div>' +
        '</div>'
      );
    }).join('');
    var guestsHtml =
      '<div class="card pnl">' +
        '<h2>Anonymous visitors <span class="adchip">' + (aud.guests.people || 0) + ' unique</span></h2>' +
        '<p class="dash-note">Guests are identified by a random browser id stored only as a short hash — no personal data is kept.</p>' +
        (guestTiles
          ? '<div class="adtools adtools-grid">' + guestTiles + '</div>'
          : '<p class="empty">No anonymous visitors in this window.</p>') +
      '</div>';

    /* ---- footer bar ---- */
    var footer =
      '<div class="adfoot">' +
        '<span class="adfoot-live"><span class="adfoot-dot"></span>live · <b>' + esc(win.label || '') + '</b></span>' +
        '<span>generated <b>' + esc(fmtStamp(t.generated_at) || 'now') + '</b></span>' +
        '<button type="button" class="btn" data-refresh>Refresh</button>' +
      '</div>' +
      '<p class="dash-note">' +
        (d.admin_email ? 'The role of ' + esc(d.admin_email) + ' comes from the OBF_ADMIN_EMAIL setting and cannot be changed here. ' : '') +
        'Passwords are stored only as salted PBKDF2-SHA256 hashes; nobody, including an administrator, can read them.' +
      '</p>';

    /* ---- activity chart, with its own time filter ---- */
    var actAll = d.activity || [];
    var actSpan = adminActSpan === "7" ? 7 : adminActSpan === "30" ? 30 : 0;
    var actSlice = actSpan ? actAll.slice(-actSpan) : actAll;
    var actTotal = actSlice.reduce(function (s, b) { return s + (b.users || 0) + (b.guests || 0); }, 0);
    var actFilter =
      '<div class="seg admwin" style="margin-bottom:10px">' +
      [["all", "All time"], ["30", "30 days"], ["7", "7 days"]].map(function (f) {
        return '<button type="button" data-actspan="' + f[0] + '" aria-pressed="' + (adminActSpan === f[0] ? 'true' : 'false') + '">' + f[1] + '</button>';
      }).join('') +
      '</div>';
    var activityHtml =
      '<div class="card pnl">' +
        '<h2>Activity <span class="adchip">' + actTotal + ' events</span></h2>' +
        '<p class="dash-note" style="margin:0 0 10px">Every logged interaction per day — visits, cell views, cell uses, sign-up walls and tool opens — split into signed-in users and anonymous guests.</p>' +
        actFilter +
        adTrafficChart(actSlice, 0, 'No activity recorded yet.') +
        (d.activity_truncated
          ? '<p class="dash-note">The chart keeps the last 92 days; older activity is not plotted.</p>'
          : '') +
      '</div>';

    /* ---- assemble ---- */
    return (
      '<div class="adhead">' +
        '<div>' +
          '<h2 class="adtitle">Dashboard <span class="adtitle-win">· ' + esc(win.label || '') + '</span></h2>' +
          '<p class="sub">Signed-in users and anonymous guests, tool opens, cell activity and accounts.</p>' +
        '</div>' +
        winSel +
      '</div>' +
      kpis +
      '<div class="adrow2">' + audienceHtml + trafficHtml + '</div>' +
      '<div class="adrow2">' + toolsHtml + signupHtml + '</div>' +
      activityHtml +
      cellsHtml +
      accountsHtml +
      '<div class="adrow2">' + feedHtml + guestsHtml + '</div>' +
      footer
    );
  }

  function kpi(label, value, extra) {
    return '<div class="kpi"><span class="lab">' + esc(label) + "</span><span class='val'>" +
      (value == null ? "—" : value) + "</span>" + (extra ? "<span class='delta'>" + esc(extra) + "</span>" : "") + "</div>";
  }

  /* The numbers behind one cell, in a dialog, built from the dashboard payload. */
  function adCellDetail(cellId) {
    var cells = (adminData && adminData.cells) || {};
    var cell = null;
    (cells.overall || []).forEach(function (c) { if (!cell && c.id === cellId) cell = c; });
    /* A cell that only the anonymous counters know still gets a dialog; the
       audience numbers are simply unknown and print as —. */
    (cells.popular || []).forEach(function (c) {
      if (!cell && c.id === cellId) {
        cell = { id: c.id, name: c.name, total: c.total, views: c.views, uses: c.uses,
                 users: null, guests: null };
      }
    });
    if (!cell) return;
    var byTool = cell.by_tool || {};
    var toolRows = Object.keys(byTool).filter(function (k) { return byTool[k]; }).map(function (k) {
      var meta = TOOL_META[k] || { tag: k };
      return '<tr><td>' + esc(meta.tag) + '</td><td class="num">' + byTool[k] + '</td></tr>';
    }).join('');
    var win = (adminData && adminData.window) || {};
    var dlg = document.createElement('dialog');
    dlg.innerHTML =
      '<div class="ad">' +
        '<button type="button" class="x" data-close aria-label="Close">×</button>' +
        '<h2 style="text-transform:none;font-size:22px;color:var(--ink);margin:14px 0 2px;font-weight:800">' +
          esc(cell.name || cell.id) + '</h2>' +
        '<p class="sub" style="margin:0 0 12px;font-size:13px">' + esc(win.label || '') +
          ' · id <code>' + esc(cell.id || '') + '</code></p>' +
        '<div class="kpis">' +
          adKpi('Total', cell.total, 'views + uses') +
          adKpi('Views', cell.views, 'detail opened') +
          adKpi('Uses', cell.uses, 'loaded into a tool') +
          adKpi('Guest views', cell.guest_views, 'anonymous') +
          adKpi('Users', cell.users, 'signed in') +
          adKpi('Guests', cell.guests, 'visitors') +
        '</div>' +
        (toolRows
          ? '<table class="utable" style="margin-top:14px"><thead><tr><th>Tool</th><th class="num">Uses</th></tr></thead><tbody>' + toolRows + '</tbody></table>'
          : '<p class="dash-note">No tool has loaded this cell in the window.</p>') +
      '</div>';
    document.body.appendChild(dlg);
    dlg.showModal();
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg || (e.target.closest && e.target.closest('[data-close]'))) {
        dlg.close();
        dlg.remove();
      }
    });
  }

  function wireAdminGlobal() {
    var box = document.getElementById("adminbody");
    if (!box || box.__obfAdminWired) return;
    box.__obfAdminWired = true;
    box.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var tile = e.target.closest && e.target.closest("[data-adcell]");
      if (tile) { e.preventDefault(); adCellDetail(tile.dataset.adcell); }
    });
    box.addEventListener("click", function (e) {
      var span = e.target.closest && e.target.closest("[data-actspan]");
      if (span) { adminActSpan = span.dataset.actspan; paintAdmin(); return; }
      var all = e.target.closest && e.target.closest("[data-adall]");
      if (all) { adminShowAll = !adminShowAll; paintAdmin(); return; }
      var tile = e.target.closest && e.target.closest("[data-adcell]");
      if (tile) { adCellDetail(tile.dataset.adcell); return; }
      var w = e.target.closest && e.target.closest("[data-window]");
      if (w) {
        document.querySelectorAll("#adminbody [data-window]").forEach(function (b) {
          b.setAttribute("aria-pressed", b === w ? "true" : "false");
        });
        renderAdmin(w.dataset.window);
        return;
      }
      var refresh = e.target.closest && e.target.closest("[data-refresh]");
      if (refresh) { renderAdmin(); return; }
      var roleBtn = e.target.closest && e.target.closest("[data-auid][data-role]");
      if (roleBtn) { adminAction(roleBtn, { role: roleBtn.dataset.role }); return; }
      var verifyBtn = e.target.closest && e.target.closest("[data-auid][data-verify]");
      if (verifyBtn) { adminAction(verifyBtn, { verify: true }); return; }
      var delBtn = e.target.closest && e.target.closest("[data-auid][data-delete]");
      if (delBtn) {
        var who = ((adminData && adminData.users) || []).filter(function (u) {
          return String(u.id) === delBtn.dataset.auid;
        })[0];
        if (who) adminDeleteAccount(who);
      }
    });
  }

  /* Deleting an account cannot be undone, so it asks in a dialog that names the
     account instead of acting on a single click. */
  function adminDeleteAccount(user) {
    var dlg = document.createElement("dialog");
    dlg.innerHTML =
      '<div class="ad">' +
        '<h2 style="margin:10px 0 6px;font-size:22px">Delete this account?</h2>' +
        '<p style="color:var(--mut)"><b>' + esc(user.name || user.email || 'This account') + '</b>' +
          (user.email ? '<br>' + esc(user.email) : '') +
          '<br>Its sessions, events and activity are deleted with it. This cannot be undone.</p>' +
        '<p class="warn" role="alert" data-err></p>' +
        '<div style="display:flex;gap:10px;margin-top:14px">' +
          '<button type="button" class="btn" data-cancel style="flex:1">Cancel</button>' +
          '<button type="button" class="bp danger" data-confirm style="flex:1">Delete account</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(dlg);
    var done = function () { closeModal(dlg); dlg.remove(); };
    dlg.addEventListener("click", function (e) {
      if (e.target === dlg || (e.target.closest && e.target.closest("[data-cancel]"))) { done(); return; }
      var go = e.target.closest && e.target.closest("[data-confirm]");
      if (!go) return;
      var err = dlg.querySelector("[data-err]");
      go.disabled = true;
      go.textContent = "Deleting…";
      request("/api/admin/users/" + encodeURIComponent(user.id) + "/delete", { method: "POST", body: {} })
        .then(function () { done(); renderAdmin(); })
        .catch(function (ex) {
          err.textContent = ex.message;
          go.disabled = false;
          go.textContent = "Delete account";
        });
    });
    openModal(dlg);
  }

  function adminAction(btn, opts) {
    var id = btn.dataset.auid;
    var url = "/api/admin/users/" + encodeURIComponent(id) + (opts.verify ? "/verify" : "/role");
    var body = opts.verify ? {} : { role: opts.role };
    var busy = btn.parentElement;
    if (busy) busy.innerHTML = '<span class="rowwhy">…</span>';
    request(url, { method: "POST", body: body })
      .then(function () { renderAdmin(); })
      .catch(function (ex) {
        alertMessage("Could not change the account", ex.message);
        renderAdmin();
      });
  }

  /* ------------------------------------------------------------- tracking */

  function track(kind) {
    var u = getCachedUser();
    if (!u || !u.email_verified) return Promise.resolve(null);
    return request("/api/events", { method: "POST", body: { kind: kind } }).catch(function () {
      return null; // tracking must never break a tool
    });
  }

  /* Usage log for the administrator: visits, cell views, cells used in a tool
     and guests stopped by the sign-up wall. It works signed in or out; a guest
     is only a random id kept in this browser. Like track(), it must never
     break the page. */
  var visitorId = "";

  function getVisitorId() {
    if (visitorId) return visitorId;
    try { visitorId = localStorage.getItem("obf_vid") || ""; } catch (e) { visitorId = ""; }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(visitorId)) {
      var bytes = new Uint8Array(12);
      try { (window.crypto || window.msCrypto).getRandomValues(bytes); }
      catch (e) { for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256); }
      visitorId = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
      try { localStorage.setItem("obf_vid", visitorId); } catch (e) { /* kept in memory only */ }
    }
    return visitorId;
  }

  /* Anonymous usage rows are written only when the visitor allowed them in the
     consent banner (Accept all). "Essential only" means exactly that: nothing
     about the visit reaches the server, for signed-in accounts as well. */
  function activity(kind, tool, cell) {
    if (!(window.OBFConsent && window.OBFConsent.canTrack())) return Promise.resolve(null);
    var body = { kind: kind, visitor: getVisitorId() };
    if (tool) body.tool = tool;
    if (cell) body.cell = String(cell);
    return request("/api/activity", { method: "POST", body: body }).catch(function () { return null; });
  }

  /* One "visit" per browser tab session, however many pages it opens. Consent
     is checked first, so the tab is only marked as counted when a row is
     actually written; consent.js calls this again after a visitor accepts. */
  function visit() {
    if (!(window.OBFConsent && window.OBFConsent.canTrack())) return;
    try {
      if (sessionStorage.getItem("obf_visit")) return;
      sessionStorage.setItem("obf_visit", "1");
    } catch (e) { /* no sessionStorage: count every page load */ }
    activity("visit");
  }

  function mayUseTools() {
    var u = getCachedUser();
    return !!(u && (u.role === "admin" || u.email_verified));
  }

  /* -------------------------------------------------------------- wiring */

  function wireDialogs() {
    var dlg = document.getElementById("auth");
    if (dlg) {
      var atab = document.getElementById("atab");
      if (atab) {
        atab.addEventListener("click", function (e) {
          var b = e.target.closest ? e.target.closest("button[data-t]") : null;
          if (b) { authMode = b.dataset.t; renderAuthDialog(); }
        });
      }
      var ax = document.getElementById("ax");
      if (ax) ax.addEventListener("click", function () { closeModal(dlg); });
      var forgot = document.getElementById("aforgotlink");
      if (forgot) {
        forgot.addEventListener("click", function (e) {
          e.preventDefault();
          closeModal(dlg);
          openForgot();
        });
      }
      var form = document.getElementById("af");
      if (form) form.addEventListener("submit", function (e) { e.preventDefault(); submitAuth(); });
      dlg.addEventListener("click", function (e) { if (e.target === dlg) closeModal(dlg); });
    }

    var fpw = document.getElementById("fpw");
    if (fpw) {
      var fpf = document.getElementById("fpwf");
      if (fpf) fpf.addEventListener("submit", function (e) { e.preventDefault(); submitForgot(); });
      fpw.addEventListener("click", function (e) { if (e.target === fpw) closeModal(fpw); });
    }
  }

  function init() {
    getToken();
    getCachedUser();
    wireDialogs();
    renderAuthBox();
  }

  /* ------------------------------------------------------------ public API */

  var account = {
    user: fetchUser,
    remember: remember,
    mayUseTools: mayUseTools,
    track: track,
    activity: activity,
    visit: visit,
    visitorId: getVisitorId,
    logout: logout,
    renderAuthBox: renderAuthBox,
    openAuth: openAuth,
    showVerifyWall: showVerifyWall,
    hideVerifyWall: hideVerifyWall,
    resendVerifyAndShow: resendVerifyAndShow,
    renderVerify: renderVerify,
    renderReset: renderReset,
    confirmReset: confirmReset,
    renderAccount: renderAccount,
    renderAdmin: renderAdmin
  };

  window.OBF = window.OBF || {};
  window.OBF.account = account;
  window.OBFAccount = account;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

