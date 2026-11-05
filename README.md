# openBatteryFlux

Free, open-source battery cell simulator. It turns a cell's datasheet envelope into
an equivalent-circuit model you can simulate, compare, calibrate, validate and
export.

This project was split from one single HTML file into two independent halves:

```
frontend/          the website (no build step, no framework)
  index.html
  css/app.css
  js/config.js     where the backend lives
  js/library.js    loads the cells from the API
  js/account.js    accounts, the account page and the admin dashboard
  js/app.js        the simulator, compare, calibrate and validation tools
backend/           the API and the cell database (runs in Docker)
  app/             FastAPI application
  data/cells.db    <-- THE CELL DATABASE: edit this file to change the cells
  tools/           CSV import/export helper
  Dockerfile
  requirements.txt
docker-compose.yml one command to run everything
vercel.json        hosting config for running the whole app on Vercel (see DEPLOY.md)
```

The frontend can be uploaded to any static host. The backend is the only part that
needs Docker, and it also serves the frontend when you run everything locally.

Three folders exist only on a working copy and are listed in `.gitignore`, so a
clone has none of them and nothing added to them can be committed by accident:

| folder | what is in it |
| --- | --- |
| `brand/` | the logo PNGs (avatar and transparent icon, 1024 px) |
| `marketing/` | the LinkedIn campaign: `linkedin/cards.html` renders the seven cards, `linkedin/posts.md` holds the copy, the PNGs are the exported images |
| `scrapers/` | the scripts that refresh the cell database from public sources, with their own guide in `scrapers/README.md` |

Everything the app needs to run is in `frontend/`, `backend/` and the two compose
files; losing those three folders costs you the artwork and the campaign, not a
working site.

---

## 1. Run it on your computer

1. Install **Docker Desktop** (free): <https://www.docker.com/products/docker-desktop/>
2. Open a terminal in this project folder.
3. Start everything:

   ```bash
   docker compose up --build
   ```

4. Open <http://localhost:8000>

That is the whole setup. The first start downloads Python and the packages, so it
takes a minute; later starts take a few seconds.

Stop it with `Ctrl+C`, or in a second terminal:

```bash
docker compose down
```

If port 8000 is already taken, open `docker-compose.yml` and change
`"8000:8000"` to `"8080:8000"`, then use <http://localhost:8080>.

**API documentation** (generated automatically) is at
<http://localhost:8000/docs>. **Health check**: <http://localhost:8000/api/health>.

---

## 2. Change the website

Everything visible lives in `frontend/`:

- text and page structure: `frontend/index.html`
- colours and layout: `frontend/css/app.css`
- behaviour: `frontend/js/app.js`
- the physics and the optimiser, shared by the page and the worker: `frontend/js/solver.js`
- simulation, comparison, calibration and validation, off the interface thread: `frontend/js/solver-worker.js`
- accounts and the admin dashboard: `frontend/js/account.js`
- backend address: `frontend/js/config.js`

The four tools compute in a Web Worker, so a calibration that takes seconds no
longer freezes the page: the interface stays scrollable and the numbers arrive
when they are ready. Nothing numeric is written twice — `solver.js` holds one
copy of the equations and the optimiser, and both the page and the worker load
it. If you serve the frontend from somewhere else, `solver-worker.js` must be
uploaded with the rest of the folder.

The folder is mounted into the container, so **save a file and refresh the
browser**. No rebuild needed. If you deploy the frontend separately, see section 5.

---

## 3. Change the cells (the database)

The app reads `backend/data/cells.db`, a normal **SQLite** database with two
tables and one convenient view:

- `cells` — one row per cell (this is what you normally edit)
- `chemistries` — the chemistry profiles (OCV curve, resistance constant,
  time constant, temperature range). Shared by every cell of that chemistry.
  They are generated from `backend/tools/chem_profiles.py`, which holds one
  table of anchor points per chemistry; `rebuild_db.py` interpolates those into
  the 101-point (1 % SOC) OCV curve stored in `ocv_json`.
- `cells_overview` — read-only view that also shows the calculated Wh/kg, W/kg
  and R₀ in mΩ, so you can sanity-check a row.

The `cells` columns:

| column | meaning |
| --- | --- |
| `id` | unique short name, e.g. `nmc-21700-e`. Changing it changes links to that cell |
| `chemistry` | must exist in `chemistries` (`nmc`, `nca`, `lfp`, `lmfp`, `lco`, `na`, `lto`, `lmb`, `alkaline`) |
| `name` | optional display name; leave empty to build it from chemistry/format/capacity |
| `format` | `18650`, `21700`, `Pouch`, `Prismatic`, … |
| `kind` | `Energy`, `Power` or `Balanced` |
| `capacity_ah` | nominal capacity in Ah |
| `mass_g` | cell mass in grams (used for Wh/kg and self-heating) |
| `max_c_rate` | datasheet maximum continuous C-rate |
| `resistance_factor` | power-class factor on R₀ (1 = the chemistry's default) |
| `coverage` | how much of the datasheet is digitised, in % (shown in the library) |
| `notes` | free text (source, caveats, …) |

Anything you change here shows up after a browser refresh — no restart, no rebuild.

### Option A — a graphical editor (recommended for beginners)

1. Install **DB Browser for SQLite** (free): <https://sqlitebrowser.org/>
2. Open `backend/data/cells.db`.
3. Go to the **Browse Data** tab, table `cells`.
4. Double-click a value, edit it, then press **Write Changes** (Ctrl/Cmd+S).
5. Refresh <http://localhost:8000>.

To add a cell, use **New Record**, fill the row, and give it a new `id`.
You can also browse the `cells_overview` view to see the calculated numbers.

### Option B — a spreadsheet (Excel, Numbers, Google Sheets)

The helper script needs Python 3 (already on macOS and Linux; on Windows use
`python` instead of `python3`). Run these commands from the project folder:

```bash
# 1. write the current cells to a CSV file
python3 backend/tools/import_cells.py export cells.csv

# 2. edit cells.csv in your spreadsheet and save it as CSV
#    (keep the header row and the column names)

# 3. write the rows back into the database
python3 backend/tools/import_cells.py import cells.csv

# optional: also delete cells that are no longer in the CSV
python3 backend/tools/import_cells.py import cells.csv --prune

# see what is in the database
python3 backend/tools/import_cells.py list
```

Rows are matched on `id`: existing cells are updated, new ids are added.
A wrong value stops the import and tells you the line number, so nothing is
half-written.

### Chemistry parameters (advanced)

The `chemistries` table defines the physics shared by a group of cells.The `ocv_json` column is a JSON array of **101 voltages** from 0 % to 100 % state of
charge (`[3.0, 3.04, …]`). Keep 101 numbers, keep them increasing with SOC, and
keep `v_min < nominal_v < v_max`. Editing a chemistry changes every cell that
uses it.

If you add a new chemistry id (rather than a new cell), give it a colour in
`frontend/css/app.css` (the `--c-<id>` variable near the top, in `:root` and in
all three theme blocks: light, `html[data-d="1"]` and
`html[data-d="1"][data-theme="dark"]`). Without one it still works, but its
dots and tags are neutral grey.

The library values are illustrative reference parameters, not manufacturer
data — the app's own documentation repeats this.

---

## 4. The API

The cell library is public and read-only:

| endpoint | returns |
| --- | --- |
| `GET /api/health` | `{status, cells, chemistries, accounts, mail}` — used by Docker and hosting health checks. `accounts.store` is `hosted` or `file`; `mail.ready` is true only when a verification email would actually reach a new user, and `mail.problems` names whatever is missing |
| `GET /api/library` | all chemistries and all cells (what the frontend loads) |
| `GET /api/chemistries` | the chemistry profiles, including the 101-point OCV curves |
| `GET /api/cells` | the cell rows |
| `GET /api/cells/{id}` | one cell, or 404 |

Example:

```bash
curl http://localhost:8000/api/cells/nmc-21700-e
```

The cell database is opened **read-only** by the API, so the server can never
overwrite your edits. Accounts are the only writable part:

| endpoint | who | does |
| --- | --- | --- |
| `POST /api/auth/signup` | anyone | create an account; returns a session token |
| `POST /api/auth/login` | anyone | sign in; returns a session token |
| `POST /api/auth/logout` | signed in | end that session |
| `GET /api/auth/me` | signed in | the current profile |
| `POST /api/auth/verify` | anyone | consume the email verification link |
| `POST /api/auth/verify/resend` | signed in, unverified | send the link again (60 s cooldown) |
| `POST /api/auth/password` | signed in | change your password; other sessions are signed out |
| `POST /api/auth/password/forgot` | anyone | email a single-use reset link; the answer never reveals whether the address exists |
| `POST /api/auth/password/reset` | anyone with the link | set a new password, verify the address and open a session (`410` when the link is dead) |
| `GET /api/me/stats` | signed in | own profile, tool counts and recent activity |
| `POST /api/account/profile` | signed in | change your name, position and company or university |
| `POST /api/account/delete` | signed in | delete your own account and its history; asks for the password |
| `POST /api/events` | signed in, verified | record one tool use (`simulate`, `compare`, `calibrate`, `validate`, `export`) |
| `GET /api/admin/stats?window=7\|30\|all` | administrator | totals, sign-ups, tool usage, per-user table and activity for that time window (`30` by default) |
| `POST /api/admin/users/{id}/verify` | administrator | mark an address verified without email |
| `POST /api/admin/users/{id}/role` | administrator | give the administrator role (`{"role":"admin"}`) or take it away (`{"role":"user"}`) |

Send the token as `Authorization: Bearer <token>`. The browser stores it in
`localStorage`; the server only keeps its SHA-256 digest, so a copy of the
database cannot be used to sign in.

CORS is open by default so a separately hosted frontend can call the API. To
restrict it, set the `ALLOWED_ORIGINS` environment variable (comma-separated
list of origins) in `docker-compose.yml` or in your hosting dashboard.

### Accounts, statistics and the admin dashboard

Accounts live in a second SQLite file, `backend/data/app.db`, created on the
first sign-up. `cells.db` is never touched by them. It holds users (passwords
hashed with PBKDF2-HMAC-SHA256 and a random salt), sessions, verification
tokens and one row per tool use.

> **Currently switched off.** `backend/app/accounts.py` sets
> `REQUIRE_EMAIL_VERIFICATION = False`, so every new account is created
> verified, no verification email is sent and the tools work immediately.
> Accounts that were already waiting are marked verified the next time the API
> starts. Set the flag back to `True` to restore the flow described here.

**Email verification.** When an email service is configured, a new account
starts unverified: Simulate, Compare, Calibrate and Validate show a “verify your
email” card, the API refuses to record usage, and the account page offers a
resend button. The link in the email opens `/#/verify/<token>`, works once and
expires after 24 hours. The administrator account is exempt, so the dashboard
that can fix a delivery problem is always reachable. Without any email
configuration no link can be delivered, so a new account stays locked until an
administrator presses **Verify** in the dashboard — that is what happens on a
fresh local install, and it is why no configuration is needed to start.

**The documentation page.** `/#/docs` needs an account like the tools do: a
visitor who opens it — from the navigation, a “How it works” link or a direct
link — is asked to sign up or log in first, and is taken to the page they
wanted once they are in.

**Password changes.** Any signed-in user can change their password from the
account page (current password required); every other session is signed out.
Nobody — including the administrator — can set another person's password: a
forgotten password is recovered with the emailed reset link described below.
The dashboard has a **Verify** button for accounts whose email never arrived.

**Sending the email (Resend).** Create a free account at <https://resend.com>,
add and verify your sending domain, create an API key, and set it in
`docker-compose.yml`:

```yaml
environment:
  RESEND_API_KEY: "re_..."
  OBF_MAIL_FROM: "openBatteryFlux <no-reply@your-domain.example>"
  OBF_APP_ORIGIN: "http://localhost:8000"   # the URL used in the link
```

`OBF_APP_ORIGIN` must be the address people open in the browser (your public
URL in production, not the API container). `OBF_MAIL_FROM` must use a domain
verified in Resend. For development without a Resend account, set
`OBF_MAIL_FILE=/app/data/mail.log` instead: the verification and password-reset
messages, link included, are appended to that file and no network call is made.

- **`/#/account`** (also the avatar in the header) shows your profile, role,
  member since, last sign-in and your own tool counts with recent activity.
- **`/#/admin`** is the dashboard: accounts, active users, new accounts per
  day, usage per tool, the latest activity and a table of every user with
  last-seen time and counts. A filter at the top switches the statistics
  between the **last 7 days**, the **last 30 days** and **all time** (then the
  sign-up chart is per month). Account and verified totals always describe the
  whole server. It is only served to an administrator (`403` for everyone
  else).

**Who is the administrator?** Set the email address in
`docker-compose.yml`:

```yaml
environment:
  OBF_ADMIN_EMAIL: "you@example.com"
```

Then sign up with exactly that address. If `OBF_ADMIN_EMAIL` is unset, the
**first account to sign up** becomes the administrator, which is the easiest
way to try it locally. Setting the variable later promotes that address the next
time it logs in.

When `OBF_ADMIN_EMAIL` is set, that address always holds the role — it is
promoted back at every sign-in, so a deployment can never lose the account that
can fix it — and this compose file ships with `admin@obf.com`. Other accounts
start as plain users, and the administrator can promote them from the dashboard.

**Who can make an administrator?** Only an administrator, and only from
`/#/admin`: each row of the account table has **Make admin** or **Make member**
next to **Verify** and **Delete**. Three rules keep a server from locking itself
out, and the row says so instead of offering a button:

- nobody can change their own role;
- the role of the `OBF_ADMIN_EMAIL` address comes from the configuration and
  cannot be changed in the dashboard;
- the last administrator cannot be demoted — promote a second account first.

The change is recorded in the activity feed, and it takes effect at once for
every session that account holds.

**Deleting your own account.** The account page has a **Delete account** card at
the bottom. It removes the account, every session belonging to it and its whole
activity history, and asks for the password again so a borrowed browser cannot
erase an account on its own. It cannot be undone, and nobody can restore an
account afterwards. If you are the last administrator, promote another account
first — the server needs one account that can reach the dashboard.

**Deleting another account.** The dashboard's **Delete** button removes one
account and its sessions, events and activity, asking in a dialog that names the
account first. It follows the same rules as the role buttons: nobody deletes
their own account there (use the account page, which asks for the password), the
`OBF_ADMIN_EMAIL` address is protected, and an administrator who is the only one
left keeps the button hidden until another administrator exists. Deleting from a
terminal is `accounts_cli.py delete --email …`, described in
[DEPLOY.md](DEPLOY.md#L358).

**What is tracked?** The tool a signed-in user opens (simulate, compare,
calibrate, validate) and export clicks, plus server-side sign-in and sign-up
events. `last_seen_at` is refreshed by any signed-in request. Nothing else is
stored and no third-party analytics are involved. Visitors who are not signed in
are not tracked.

**Upgrading from the version without verification.** Starting the API adds the
new columns to `app.db` automatically and marks the accounts that already
existed as verified, so nobody is locked out by the upgrade.

**Forgotten passwords.** “Forgot your password?” in the log-in dialog sends a
single-use link that expires after one hour and works once; setting the new
password signs out every open session of that account and also counts as email
verification. The answer to the request is the same whether or not the address
has an account, so the endpoint cannot be used to discover who is registered,
and a new link is only minted once per 60 seconds per address. This needs the
email settings above: on a server without them the dialog says so, and there is
no other way back into a forgotten account (nobody can set a password for
someone else), so configure email before people rely on the site.

**Deleting or resetting accounts.** Stop the service, delete
`backend/data/app.db`, start it again: all accounts and statistics are gone.
`backend/tools/accounts_cli.py` does the same jobs while the service runs and
also works against a hosted database — `ensure-admin` to create the
administrator, `delete --email <address> --yes` to remove one account (it will
not delete the last administrator), `purge --keep <email> --yes` to delete every
other account, and `check` to see what a deployment is missing.

**Before putting this online.** The API has its own rate limits — 5 wrong
passwords per address in 15 minutes, 5 accounts and 10 reset requests per caller
per hour, answered with `429` and `Retry-After` — and a 60-second cooldown on
verification and reset emails. It serves plain HTTP locally. If you expect
strangers to sign up, put it behind HTTPS, set `OBF_THROTTLE_KEY`, and still add
a limiter at your reverse proxy for traffic that never reaches the app.
Note also that on hosts with an ephemeral filesystem (Render's free plan, for
instance) `app.db` is lost on every redeploy — attach a persistent disk (on
Render, disks require a paid instance type) and set `OBF_APP_DB_PATH` to a path
on it if the accounts should survive. On a host with no writable disk at all,
set `OBF_DATABASE_URL` and `OBF_DATABASE_TOKEN` to keep accounts in a hosted
Turso database instead.

---

## 5. Put it online

For the long version — Render, Fly.io, your own server, putting the website on
Vercel while the API stays on a container host, and running the whole app on
Vercel with accounts in a hosted database — see [DEPLOY.md](DEPLOY.md).

### 5a. Everything in one place (easiest)

One Docker web service serves both the API and the website, so you get one URL
and nothing to configure. **Render** has a free plan and deploys straight from a
GitHub repository:

1. Create a free account at <https://render.com> and put this project on GitHub
   (GitHub Desktop is the easiest way if you do not use git yet).
2. In Render: **New → Web Service**, connect the repository.
3. Settings:
   - **Language / Runtime**: `Docker`
   - **Dockerfile Path**: `backend/Dockerfile`
   - **Docker Build Context Directory**: the repository root (default)
   - **Instance Type**: `Free`
   - **Health Check Path**: `/api/health`
4. **Create Web Service**. The first build takes a few minutes; then open the
   `https://your-service.onrender.com` URL.

Every `git push` redeploys automatically. The cell database is **inside the
image**, so the workflow for a cell update is: edit `backend/data/cells.db`
locally → commit/push → Render rebuilds → the new cells are live. Render's free
instances also sleep after inactivity, so the first visit of the day can take
about a minute. Accounts are written to `app.db`, which is **not** in the image:
add a persistent disk (paid instance types only) and point `OBF_APP_DB_PATH` at
it, otherwise every redeploy starts with no accounts. Add `RESEND_API_KEY`, `OBF_MAIL_FROM` and
`OBF_APP_ORIGIN` (your public URL) to the service's environment so verification
emails point at the real site.

The same Dockerfile works on other container hosts (Railway, Fly.io, Koyeb,
DigitalOcean App Platform, Google Cloud Run). Let the platform set `PORT` — the
container already listens on it.

### 5b. Frontend and backend on separate hosts

1. Deploy the backend as above (Render or another container host).
2. Open `frontend/js/config.js` and set your backend URL:

   ```js
   window.OBF_CONFIG = { apiBaseUrl: "https://your-service.onrender.com" };
   ```

3. Upload the **`frontend/` folder** to any static host — Netlify (drag and
   drop the folder into <https://app.netlify.com/drop>), Vercel, Cloudflare
   Pages, GitHub Pages, or even classic web hosting. There is no build step.

Because the backend allows all origins by default, this works immediately. For
production, set `ALLOWED_ORIGINS` on the backend to your frontend origin.

> Note: files opened directly from disk (`file://`) usually cannot call the API.
> Upload the folder or serve it over HTTP (`python3 -m http.server 8081 --directory frontend`).

### 5c. Prove the deployment works

From either route, one command checks the live site end to end — the page, the
API, the library, the SEO routes, a cell page, a sign-in attempt and a static
asset:

```bash
python3 backend/tools/smoke_test.py https://your-service.onrender.com
```

It exits non-zero on any failure and names the cause, including a Vercel
protection screen in front of the site. [DEPLOY.md §7](DEPLOY.md#L395) explains
the checks in detail.

If the site is on Vercel and accounts live in a hosted database (the only
option there — a function has no writable disk), `bash
backend/tools/vercel_setup.sh` walks the whole setup step by step: the database
and its token, proving it from your machine, the site's public origin, Resend
email delivery (domain, API key, sender), the six variables on Vercel,
deployment protection, the redeploy, this check, and the administrator account
in the hosted database.

---

## 6. If something does not work

| symptom | fix |
| --- | --- |
| The page says “The cell library could not be loaded” | The backend is not running, or `apiBaseUrl` in `frontend/js/config.js` is wrong. Open `/api/health` in the browser: it should return JSON. |
| `docker compose up` says the port is in use | Another app uses 8000. Change the left side of `"8000:8000"` in `docker-compose.yml`. |
| “Cannot connect to the Docker daemon” | Start Docker Desktop and wait until it says it is running. |
| API returns 503 “The cells table is empty” | The database has no rows. Restore `backend/data/cells.db` from the repository. |
| A cell is missing from the site | Check its `chemistry` exists, `capacity_ah` and `mass_g` are above 0, and hard-refresh the browser. |
| DB Browser cannot save | Close anything else using the file (including other DB Browser windows) and try again. |
| You signed up but `/#/admin` says “Administrators only” | Only `OBF_ADMIN_EMAIL` (or, if it is unset, the first account) starts as an administrator; another administrator can promote you from the dashboard. Check the address in `docker-compose.yml` and log in with it. |
| You forgot the password | Press **Forgot your password?** in the log-in dialog and open the link from the email (valid one hour, works once). Nobody, including the administrator, can set a password for someone else. On a server without email settings there is no recovery: configure the email settings, or stop the service, delete `backend/data/app.db` and start again (this removes all accounts and statistics). |
| The reset email never arrives | Check the spam folder, that `OBF_MAIL_FROM` uses a domain verified in Resend, and that `OBF_APP_ORIGIN` is the site people open. Wait 60 seconds before asking for another link. With `OBF_MAIL_FILE` set, the message is in that file instead. |
| The verification email never arrives | Press **Resend** on the account page; check the spam folder and that `RESEND_API_KEY`, `OBF_MAIL_FROM` and the verified domain are right. The admin can press **Verify** in the dashboard instead. |
| The tools say “Verify your email” | Open the link in the verification email, or have the administrator press **Verify** in the dashboard. Every new account starts unverified; a server without email settings cannot email the link, so the dashboard is the only way to confirm it. |
| Statistics look empty after a restart | `backend/data/app.db` is missing. It is created on the first sign-up; keep the `backend/data` volume (or `OBF_APP_DB_PATH`) so it survives. |
| Edited frontend files do not appear | Hard-refresh (Ctrl/Cmd+Shift+R). If you run without the `frontend/` mount, rebuild with `docker compose up --build`. |

Check the server logs with:

```bash
docker compose logs -f web
```

---

## 7. Running the backend without Docker (optional, for development)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
OBF_FRONTEND_DIR=frontend OBF_DB_PATH=backend/data/cells.db \
  uvicorn app.main:app --reload --app-dir backend --port 8000
```

Requires Python 3.9 or newer. Docker is still the recommended path: it is the
only thing you need installed to run the released project.

---

openBatteryFlux is community-built and free to use. Cell parameters are
illustrative reference values unless you calibrate them on your own data.
