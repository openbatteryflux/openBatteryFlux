# Deploying openBatteryFlux

How to put this project online from the GitHub repository `openbatteryflux` —
on Vercel, or on a host that fits it better.

Commands are given for macOS/Linux (on Windows use Git Bash or WSL). Every
environment variable and every behaviour below was checked against the running
app, so the values quoted are the real ones.

---

## 1. What you are deploying

The project is two things:

| part | what it is | how it is served |
| --- | --- | --- |
| **Website** | `frontend/` — plain HTML, CSS and JS. No build step, no bundler, no `package.json`. | Any static host, or the backend |
| **API** | `backend/` — FastAPI + uvicorn, which also serves the website when `frontend/` sits next to it | A long-running container, or a plain Python process |

And it has two SQLite files:

| file | contents | needs to be writable? |
| --- | --- | --- |
| `backend/data/cells.db` | the cell library, 1288 cells (read-only) | no — it is only ever read, so a copy inside the image is enough |
| `backend/data/app.db` | accounts, sessions, events, activity statistics | **yes** — created and written on sign-up, login and every tool run |

**That last row decides everything else.** `app.db` is a plain file on disk, and
a host that gives the container a temporary filesystem throws it away on every
redeploy — taking every account with it. You point it at a persistent disk or
volume with one variable:

```
OBF_APP_DB_PATH=/some/persistent/path/app.db
```

If you do not care about accounts surviving a redeploy (a demo, a personal
test), you can leave it unset and skip all the disk steps below.

---

## 2. Pick a route

| | Route A — one service | Route B — Vercel + one service | Route C — Vercel only |
| --- | --- | --- | --- |
| **What runs where** | Website and API in one container | Website on Vercel, API in a container | Both on Vercel |
| **One URL** | yes | yes, if you proxy (B.1) | yes |
| **Accounts survive** | yes, with a disk/volume | yes, with a disk/volume | **no** |
| **Free** | Free tier with no disk (accounts lost on redeploy) | Same as A + free static hosting | Yes, with function limits |
| **Effort** | Lowest | Medium (one `vercel.json`) | Lowest — the repository already builds |
| **Good for** | The whole app, one thing to manage | A fast CDN in front, API kept simple | The library and simulator; **accounts do not work** — see §6 |

The Dockerfile already contains the website, so **Route A gives you a working
site and API with nothing else to configure**. Route B is worth it when you want
the CDN, instant previews per push, and a custom domain on the frontend.

---

## 3. Route A — everything in one container service

One Docker web service serves the API and the website on one URL.

### A.1 Render (fastest to a working site)

1. Sign in at <https://render.com> and connect the `openbatteryflux` GitHub
   repository.
2. **New → Web Service**, pick the repository.
3. Settings:

   | field | value |
   | --- | --- |
   | Language / Runtime | `Docker` |
   | Dockerfile Path | `backend/Dockerfile` |
   | Docker Build Context Directory | the repository root (the default — leave it) |
   | Health Check Path | `/api/health` |
   | Instance Type | `Free`, or `Starter` if you want a disk |

4. Add the variables from §5 under **Environment**, then **Create Web Service**.
   The first build takes a few minutes; the URL is `https://<name>.onrender.com`.
5. **Add a persistent disk for accounts** (paid instance types only — Render's
   free web services cannot attach disks):
   - **Disks → Add Disk**, mount path `/var/lib/obf`, size 1 GB.
   - Add the variable `OBF_APP_DB_PATH=/var/lib/obf/app.db`.
   - The container runs as UID `10001` (see `backend/Dockerfile`). If sign-up
     fails and the logs say the database is read-only or permission denied, the
     disk was mounted owned by `root`: open the service **Shell** and run
     `chown -R 10001:10001 /var/lib/obf`, then redeploy. This is the single most
     common first failure on every host below.

Every `git push` redeploys. `cells.db` lives inside the image, so a cell update
is: edit locally → commit → push → rebuild.

The same Dockerfile works on Railway, Koyeb, DigitalOcean App Platform, Northflank,
Fly.io, Google Cloud Run, Azure Container Apps, Heroku, a plain VPS with
`docker compose`, or `coolify` on your own machine. Let the platform set `PORT`:
the image already listens on `${PORT:-8000}`.

One difference to know about: Render's free instances **sleep** after
inactivity, so the first visit of the day can take about a minute.

### A.2 Fly.io (a volume that survives redeploys)

```bash
fly auth login
fly launch --no-deploy --dockerfile backend/Dockerfile   # from the repository root
fly volumes create obf_data --size 1
```

In the generated `fly.toml`, check the build section and add the mount:

```toml
[build]
  dockerfile = "backend/Dockerfile"

[mounts]
  source = "obf_data"
  destination = "/var/lib/obf"
```

Then set the variables and deploy:

```bash
fly secrets set OBF_APP_DB_PATH=/var/lib/obf/app.db \
  OBF_ADMIN_EMAIL="you@example.com" \
  OBF_APP_ORIGIN="https://your-app.fly.dev"
fly deploy
fly logs          # the API logs
fly volumes list  # the volume
```

Volumes persist across deploys and restarts. If writes fail with a permission
error, the mount is owned by `root` while the app runs as UID `10001`:
`fly ssh console -C "chown -R 10001:10001 /var/lib/obf"`.

Fly's free allowance and volume pricing have changed over time — check the
current pricing page before you rely on "free".

### A.3 Your own server or VPS (Hetzner, DigitalOcean, a home machine)

The repository already ships `docker-compose.yml`, and it mounts
`./backend/data` into the container. That means **accounts persist on the host
in `backend/data/app.db` with no extra configuration** — the disk is a folder on
your machine.

```bash
git clone https://github.com/openbatteryflux/openBatteryFlux.git
cd openbatteryflux
docker compose up --build -d
docker compose logs -f web
```

Then open `http://<server-ip>:8000`. Before showing it to anyone else, put a
reverse proxy with HTTPS in front of it (Caddy is the least work: one `Caddyfile`
with `your-domain.example { reverse_proxy 127.0.0.1:8000 }`), and back up
`backend/data/app.db`.

The API has **no rate limiting** of its own (only the 60-second per-address
cooldown on verification and reset emails), so add a limiter at the proxy —
including on `/api/auth/password/forgot`.

---

## 4. Route B — the website on Vercel, the API in a container

Deploy the API first (Route A), then put the static site on Vercel.

### B.1 Proxy everything through Vercel (recommended)

The frontend then calls `/api/...` on its own origin and Vercel forwards it to
your API. You keep one public URL, no CORS configuration, and `frontend/js/config.js`
needs no edit.

1. Push the repository to GitHub (already done for you).
2. In Vercel: **Add New → Project**, import `openbatteryflux`.
3. In the project settings:

   | field | value |
   | --- | --- |
   | Framework Preset | `Other` |
   | Root Directory | `frontend` |
   | Build Command | leave empty |
   | Output Directory | leave empty (`.`) |

   There is nothing to build — Vercel uploads the folder as it is.
4. Create `frontend/vercel.json` (`vercel.json` is read from the *Root
   Directory*, so it belongs inside `frontend/`), replacing the host with your
   API's address:

   ```json
   {
     "rewrites": [
       { "source": "/api/(.*)", "destination": "https://YOUR-API.onrender.com/api/$1" },
       { "source": "/cell/(.*)", "destination": "https://YOUR-API.onrender.com/cell/$1" },
       { "source": "/robots.txt", "destination": "https://YOUR-API.onrender.com/robots.txt" },
       { "source": "/sitemap.xml", "destination": "https://YOUR-API.onrender.com/sitemap.xml" }
     ]
   }
   ```

   All four are needed: `/api/*` is the library and the accounts, `/cell/<id>` is
   the server-rendered, indexable page for one cell, and `robots.txt` and
   `sitemap.xml` come from the API so search engines see every cell.
5. Deploy, then open the Vercel URL. The site loads the library through the
   proxy; there is nothing else to set.

Because the browser only ever talks to Vercel, leave `ALLOWED_ORIGINS` on the
API at its default or set it to the Vercel origin — CORS does not apply to a
proxy.

### B.2 Call the API directly instead

If you prefer no rewrites, point the frontend at the API and open the API to it:

1. Edit `frontend/js/config.js`:

   ```js
   window.OBF_CONFIG = { apiBaseUrl: "https://YOUR-API.onrender.com" };
   ```

2. Set `ALLOWED_ORIGINS=https://your-site.vercel.app` on the API (not `*`).
3. Set the API's `OBF_APP_ORIGIN=https://your-site.vercel.app` so the links in
   the verification and password-reset emails point at the website people use.
4. Drop the `/api` and `/cell` rewrites from `vercel.json`; keep `robots.txt` and
   `sitemap.xml` only if you set `PUBLIC_BASE_URL` on the API to the Vercel URL,
   otherwise the sitemap will advertise the API's own host.

**Netlify** works the same way and needs no configuration at all: drag the
`frontend/` folder onto <https://app.netlify.com/drop>. Cloudflare Pages and
GitHub Pages are also fine.

---

## 5. Environment variables

Set these in the platform's dashboard (Render/Railway/Koyeb/Fly/Vercel) — never
commit them.

| variable | needed? | what it does / default |
| --- | --- | --- |
| `PORT` | set by the platform | the port uvicorn listens on. The image uses `${PORT:-8000}` |
| `OBF_APP_DB_PATH` | **yes, for accounts** — unless `OBF_DATABASE_URL` is set | path of the writable `app.db`. Default `backend/data/app.db`, which is wiped on redeploy by most hosts. Point it at a disk/volume |
| `OBF_DATABASE_URL` | on serverless hosts | `turso://…` URL of a hosted Turso database. When set, accounts live there and `OBF_APP_DB_PATH` is not used. See §6 |
| `OBF_DATABASE_TOKEN` | with `OBF_DATABASE_URL` | the token from `turso db tokens create`. `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` are accepted as aliases |
| `OBF_THROTTLE_KEY` | recommended | a random string used to hash the rate-limit counters. Unset: a built-in default is used, so the limits work, but anyone holding a copy of the database can rebuild the keys |
| `OBF_ADMIN_EMAIL` | recommended | the one address that gets the `/#/admin` dashboard, and the only one that can hold that role. Unset: the **first** account to sign up becomes the administrator |
| `ALLOWED_ORIGINS` | for route B.2 | comma-separated CORS origins. Default `*` (any site may call the API). Route A and B.1 need nothing |
| `OBF_APP_ORIGIN` | for email | public website origin used in the links inside emails. Default `http://localhost:8000` — wrong in production |
| `RESEND_API_KEY` | for email | enables real email delivery through Resend |
| `OBF_MAIL_FROM` | for email | the `From:` line, e.g. `openBatteryFlux <no-reply@your-domain.example>`. Must use a domain verified in Resend |
| `OBF_MAIL_FILE` | no | writes emails to that file instead of sending them — for testing without an email account |
| `PUBLIC_BASE_URL` | for SEO | public origin used in `sitemap.xml`, `robots.txt` and canonical URLs when the app runs behind a proxy. Default: the request's own host |
| `OBF_DB_PATH` | no | path of the read-only cell library. The image already sets `/app/data/cells.db` |
| `OBF_FRONTEND_DIR` | no | folder of the website to serve. The image already sets `/app/frontend` |

### Email (optional, but decide deliberately)

Two messages are sent: the sign-up verification link and the password reset
link. They go out through Resend's HTTP API, so there is no SDK or extra
dependency.

- **With `RESEND_API_KEY` set**: new accounts start unverified and the tools stay
  locked until the link is opened. `OBF_MAIL_FROM` must use a domain you verified
  in Resend, and `OBF_APP_ORIGIN` must be the site people actually open.
- **Without it**: no email is sent, so a new account stays locked — every
  account starts unverified whatever the mail settings are — until an
  administrator presses **Verify** in the dashboard. There is also **no way back
  into a forgotten password** (nobody, including an administrator, can set
  another account's password). Resend has a free tier; configure it before
  strangers sign up.

Emails are also the only way to confirm an address. An administrator can press
**Verify** in the dashboard as a manual fallback.

---

## 6. Route C — the whole app on Vercel

Vercel can build and run this API as a single Vercel Function. Two files at the
repository root make that work, and both are needed:

| file | why |
| --- | --- |
| `pyproject.toml` | `[tool.vercel] entrypoint = "backend.app.main:app"`. Vercel only auto-detects an `app` at the root (`app.py`, `main.py`, …) or inside `src/`, `app/` — ours is in a package, so without this line the build stops with `[FASTAPI_ENTRYPOINT_NOT_FOUND]` |
| `requirements.txt` | `fastapi`, the only runtime dependency the API has. Vercel installs from either manifest |

The container image keeps using `backend/requirements.txt`; keep the pins in
all three places in step when you upgrade FastAPI.

The website, `/api/library`, `/api/health`, `/api/cells`, `/cell/<id>`,
`/robots.txt` and `/sitemap.xml` all work as they are: the cell library is
read-only and ships inside the deployment.

### Accounts need a database, not a disk

A Vercel function's filesystem is **read-only except `/tmp`**, and `/tmp` is
scratch space for one invocation — there are no disks or volumes
(<https://vercel.com/docs/functions/runtimes/python>). `app.db` cannot live
there, so accounts on Vercel need a hosted database. Set it up once:

> The steps below are scripted. `bash backend/tools/vercel_setup.sh` walks them
> in order: the database URL and token, the administrator address, a check that
> the database answers from your machine, the site's public origin (which every
> email link is built from), a Resend domain and API key with the sender checked
> against Resend's verified list, the six variables on Vercel (through the CLI
> when it is installed and the folder is linked, with exact dashboard steps
> otherwise), deployment protection, the redeploy, the smoke test against the
> live URL, and the administrator account in the hosted database. Re-running it
> reuses what it saved in `.env` (gitignored), so a failed run resumes instead of
> starting over. Follow the steps by hand below if you prefer.

1. Create a database and two credentials (Turso CLI, or the Turso dashboard):

   ```bash
   turso db create openbatteryflux --tursodb
   turso db show --url openbatteryflux        # turso://openbatteryflux-<org>.turso.io
   turso db tokens create openbatteryflux     # the token, shown once
   ```

2. In Vercel: **Settings → Environment Variables**, for all environments:

   | name | value |
   | --- | --- |
   | `OBF_DATABASE_URL` | the `turso://…` URL from step 1 |
   | `OBF_DATABASE_TOKEN` | the token from step 1 |

   `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` are accepted too, which is what
   Turso's own Vercel integration writes.

3. Redeploy, then open the URL in a normal browser session to confirm it loads
   for visitors: if Vercel answers with "Protected by Vercel Authentication",
   turn that protection off for production first (§9). Then open `/api/health`:
   it must end with `"accounts":{"store":"hosted"}`. If it says `"file"`,
   that deployment cannot see the variables — a deployment is built with the
   variables that exist when it is created, so saving one afterwards changes
   nothing until you redeploy again (and check the variable's environment
   checkbox: Production and Preview are separate). Until it says `hosted`,
   sign-up and login answer `503 … unable to open database file`, because the
   function's filesystem is read-only. The tables are created on
   the first request that touches them;
   there is no migration step, and any local `app.db` is left alone — the hosted
   database starts empty, so the first sign-up becomes the administrator unless
   you set `OBF_ADMIN_EMAIL`.

4. Create the administrator, and clear out anything you signed up while testing.
   Add `OBF_ADMIN_EMAIL` (step 2) first: it is the role the API enforces on every
   login, so no other account can take the dashboard. Then run the CLI from your
   machine — it talks to the hosted database over the same HTTP API, so nothing
   has to be deployed or exposed:

   ```bash
   export OBF_DATABASE_URL='turso://openbatteryflux-<org>.turso.io'
   export OBF_DATABASE_TOKEN='...'
   export OBF_ADMIN_EMAIL='you@example.com'

   python3 backend/tools/accounts_cli.py check         # reachable? tables? counts?
   python3 backend/tools/accounts_cli.py ensure-admin  # prompts for the password
   python3 backend/tools/accounts_cli.py list
   python3 backend/tools/accounts_cli.py delete --email test@example.com --yes  # just one
   python3 backend/tools/accounts_cli.py purge --yes   # delete every other account
   ```

   `ensure-admin` creates the account verified with role `admin`, or promotes an
   existing one and resets its password (which ends that account's open
   sessions). The password is typed at a prompt, never passed on the command
   line, where it would stay in your shell history; `--password-file` exists for
   scripted runs. `delete` removes one account and its sessions, events and
   activity — the way to clear an account you made while testing without
   touching anybody else's — and refuses to remove the last administrator, so
   the dashboard cannot be locked by accident. The same deletion is available
   as **Delete** on each row of `/#/admin`, which needs no credentials here and
   asks in a dialog first; `purge` prints what it would
   delete unless you pass `--yes`, keeps exactly the address you name, and
   removes that account's sessions, events and activity along with the rest.
   Both `delete` and `purge` print what they would do until you pass `--yes`,
   and `ensure-admin` prints the store it used, so you can see it really
   reached the hosted database and not a stray local file.

**Verification needs email delivery.** A new account starts unverified and the
simulator tools stay locked until the link in the email is opened, which takes
`RESEND_API_KEY`, an `OBF_MAIL_FROM` address on a domain verified in Resend, and
`OBF_APP_ORIGIN` pointing at the public site (the links are built from it).
Without them the account is still created, but nothing can be delivered: the
new user hits the verify wall, which tells them an administrator has to confirm
the account, and there is no way back into a forgotten password. `/api/health`
reports the state as `mail.ready` with the missing pieces in `mail.problems`, so
check it after every deploy instead of waiting for the first complaint;
`accounts_cli.py check` says the same thing from the command line.

The wizard above covers this: it asks for the public origin, walks a Resend
domain to *Verified*, takes a sending-only API key, and checks the sender
against Resend's own domain list before it continues — so `@resend.dev`, which
only reaches your own mailbox, is caught there rather than after a user's
verification email silently never arrives.

With `OBF_DATABASE_URL` set, `backend/app/remote_db.py` opens the hosted database
instead of the file, and `backend/app/accounts.py` runs exactly the same SQL
against it — the driver speaks DB-API 2.0 over HTTP and needs no native
extension. Unset it and every host described in §3 keeps using SQLite with no
changes. Each statement is one HTTP round trip, so a sign-up costs a handful of
them; that is the price of having no disk, and it is why the account layer was
not made chattier.

If you would rather not run a second service, the alternatives are:

| approach | consequence |
| --- | --- |
| Set `OBF_APP_DB_PATH=/tmp/app.db` | **not recommended.** Accounts appear to work, then vanish between invocations: random log-outs, an empty dashboard — and because a new empty database starts with no users, whoever signs up first on a fresh instance becomes the administrator |
| Keep the library and website on Vercel and put accounts on Route A | a hybrid: the read-only library is CDN-friendly, accounts stay on a real disk |
| Leave both unset | the account endpoints answer `503 The account database is unavailable on this deployment`; the site, the library and the simulator keep working |

Either way, check the free tier of the database provider before you rely on it.

---

## 7. Verify the deployment

The quickest check is the script in the repository — no dependencies, and it
names the cause when something is wrong:

```bash
python3 backend/tools/smoke_test.py https://your-site.example.com
```

It tests the page itself, `/api/health`, the library, `robots.txt`,
`sitemap.xml`, one `/cell/<id>` page, a sign-in attempt (with a random address
that has no account, so nothing is created) and one static asset. Each check
prints a line, the exit code is 0 only if all of them pass, and a protected
deployment is reported as such instead of as a broken API (§9). Run it after
every deploy, or from CI.

The same checks by hand, against your deployed URL (replace
`https://api.example.com`):

```bash
# 1. The API is alive and the library is loaded (expect 200 + a cell count)
curl -s -w " status=%{http_code}\n" https://api.example.com/api/health
#    -> {"status":"ok","cells":1288,"chemistries":8} status=200

# 2. The library the browser needs
curl -s -o /dev/null -w "library=%{http_code}\n" https://api.example.com/api/library

# 3. SEO routes (route B: check them on the Vercel URL too)
curl -s -o /dev/null -w "sitemap=%{http_code}\n" https://api.example.com/sitemap.xml
curl -s https://api.example.com/robots.txt

# 4. A server-rendered cell page (use any id from /api/cells)
curl -s https://api.example.com/cell/<cell-id> | grep -o "<title>[^<]*</title>"
#    -> <title>... · openBatteryFlux</title>

# 5. The website itself (route A: the same host; route B: the Vercel URL)
curl -s -o /dev/null -w "site=%{http_code}\n" https://api.example.com/
```

Then in a browser:

1. The page loads with no "The cell library could not be loaded" message.
2. **Library** lists cells and one opens.
3. **Sign up** with the `OBF_ADMIN_EMAIL` address.
4. `/#/admin` opens (it must not say "Administrators only").
5. **Log out and log in again** — if this fails, `OBF_APP_DB_PATH` is wrong or
   the disk is not writable.
6. **Redeploy, then log in again.** This is the check that proves the persistent
   disk works. On a host without one, the account is simply gone.
7. Ask for a password reset and open the link: it must point at your public
   website, which proves `OBF_APP_ORIGIN` is right.

---

## 8. Updating a deployed site

| what you changed | what to do |
| --- | --- |
| Cells (edit `cells.db`, re-import) | commit `backend/data/cells.db` and push. The library is **inside the image**, so the host rebuilds and the new cells go live |
| `frontend/` files | Route A: push (rebuild). Route B: push (Vercel redeploys in seconds) |
| `backend/` code | push; the host rebuilds |
| Account data | nothing — it lives on the disk/volume, outside the image |

Accounts and statistics are deliberately **not** in the repository:
`.gitignore` excludes `backend/data/app.db` (plus its `-journal`/`-wal`/`-shm`
siblings and `mail.log`), so pushing the project can never publish user data.

If your local copy is not a git checkout yet (this folder is not one), set it up
once:

```bash
cd openbatteryflux
git init
git add .
git commit -m "openBatteryFlux"
git branch -M main
git remote add origin https://github.com/openbatteryflux/openBatteryFlux.git
git push -u origin main
```

---

## 9. Troubleshooting

| symptom | cause and fix |
| --- | --- |
| Build succeeds, page says "The cell library could not be loaded" | The browser could not reach `/api/library`. Open `/api/health` yourself; on route B.2 check `apiBaseUrl` in `frontend/js/config.js` and `ALLOWED_ORIGINS` |
| Sign-up returns 500 and the log says the database is read-only / permission denied | The disk or volume is mounted owned by `root` while the app runs as UID `10001`. `chown -R 10001:10001 <mount path>` from the platform's shell, then redeploy |
| Accounts disappear after every deploy | `OBF_APP_DB_PATH` is unset or points outside the disk. It must be a path **on** the mounted volume |
| A container host reports a port error | Do not hard-code the port: the platform sets `PORT`, and the image already listens on it |
| `/api/health` returns 503 "The cells table is empty" | `cells.db` is missing or empty in the build. Commit `backend/data/cells.db` and redeploy |
| The site shows "Protected by Vercel Authentication", or raw JSON containing `"protection"` and `vercel_auth_callback` | Vercel **Deployment Protection** is answering before the app runs, so no visitor ever reaches it. In the project: **Settings → Deployment Protection → Vercel Authentication** → apply it to preview deployments only, or turn it off, then redeploy. `vercel curl` and protection-bypass tokens only let *you* through — they do not make the deployment public. The page now says this itself instead of showing the JSON |
| Vercel build fails with `[FASTAPI_ENTRYPOINT_NOT_FOUND]` | The root `pyproject.toml` is missing, or its `[tool.vercel] entrypoint` does not read `backend.app.main:app`. It must point at a module and the FastAPI instance inside it, separated by a colon |
| Sign-up or login returns 503 "The account database is unavailable on this deployment", and `/api/health` ends with `"accounts":{"store":"file"}` on Vercel | This deployment has no hosted database: it tried the local file, which a Vercel function cannot write, and the function log says `unable to open database file`. Set `OBF_DATABASE_URL` and `OBF_DATABASE_TOKEN` (or the `TURSO_*` pair) for **Production** and redeploy — variables saved after a deployment was built are not seen by it. `/api/health` says which store is in use: `"hosted"` means the function sees them. If `/api/health` has no `accounts` field at all, the deployment is older than this check — redeploy the current commit before looking for anything else. On a container host the same message means `OBF_APP_DB_PATH` or its directory is wrong for UID `10001` |
| Sign-up or login returns 503 "The account database is unavailable on this deployment", and `/api/health` says `"accounts":{"store":"hosted"}` | The *hosted* database rejected the connection; the function log has the driver's reason. Check the token belongs to that database, that it has not expired, and that the URL is the `turso://…` one from `turso db show --url` |
| The 503 says "OBF_DATABASE_URL is set but the turso_serverless driver is not installed" | The dependency was not installed on the host. It is in all three manifests — redeploy without a build cache, or `pip install turso_serverless` |
| Accounts appear to save but are missing after a reload, or on another instance | `OBF_DATABASE_URL` points somewhere else than the database you are inspecting, or the token is for a different one |
| `429 Too many attempts` on sign-in, sign-up or a reset request | The built-in limits in §10. Wait for the `Retry-After` seconds. A correct password is refused while the block lasts, so nothing is broken — the counters are in the `throttle` table if you need to see or clear one |
| Sitemap and canonical URLs show the platform's internal hostname | Set `PUBLIC_BASE_URL=https://your-public-domain` |
| Verification or reset email never arrives | Open `/api/health` first: `mail.ready: false` names the missing piece in `mail.problems` — no `RESEND_API_KEY`, a sender still on the `resend.dev` test domain, or an `OBF_APP_ORIGIN` still pointing at localhost. On Vercel, variables saved after a deployment was built are not seen by it, so redeploy. Then check spam and the verified domain; requests are rate-limited to one per address per 60 seconds |
| The first visit of the day takes a minute | Free instances sleep when idle. Upgrade, or accept the cold start |
| "Administrators only" after signing up | You did not sign up with the `OBF_ADMIN_EMAIL` address. Another administrator can promote you from the dashboard |

---

## 10. Before you invite strangers

- **HTTPS** everywhere; both routes above give it for free.
- **Rate limiting** is built in, and the counters live in the accounts database,
  so every instance of a serverless deployment agrees on them:

  | what | limit | block |
  | --- | --- | --- |
  | wrong passwords, per address | 5 in 15 minutes | 15 minutes |
  | wrong passwords, per caller | 20 in 15 minutes | 15 minutes |
  | accounts created, per caller | 5 in an hour | 1 hour |
  | reset links, per address | 5 in an hour | 1 hour |
  | reset links, per caller | 10 in an hour | 1 hour |

  A refused request gets `429` with a `Retry-After` header; the sixth wrong
  password is blocked even if it is the right one. The sign-in form says how
  many attempts are left once three have failed, and the sign-up confirmation
  says when a network is down to its last sign-ups. Counters are keyed digests of
  the address or email address, never the values themselves, and a counter that
  has been quiet for a day is deleted. Set `OBF_THROTTLE_KEY` so those digests
  cannot be rebuilt from a copy of the database. Calls made from your own
  terminal through `accounts_cli.py` are never limited.

  This is not a substitute for a limiter at the proxy if you expect real abuse:
  a CDN or reverse-proxy limit still catches traffic that never reaches the API,
  and `/api/library` is deliberately public and unthrottled.
- **`ALLOWED_ORIGINS`**: leave it as `*` only if you use a proxy (route B.1) or
  truly intend to let any site call the API.
- **Secrets** (`RESEND_API_KEY`) belong in the platform's environment settings.
  `.env` and `*.db` files are already git-ignored; do not paste keys into issues
  or commits.
- **Back up `app.db`** if the accounts matter. On a disk-mounted host it is one
  file on that volume; the cell library can always be rebuilt from the repo.
- Cell parameters are illustrative reference values. Say so on the site (the
  footer already does) unless you have measured them yourself.

## 11. Where this deployment's accounts live

The live site (<https://openbatteryflux.vercel.app>) keeps accounts in the hosted
Turso database `openbatteryflux`
(`openbatteryflux-openbatteryflux.aws-eu-west-1.turso.io`), configured on Vercel
for **Production** as `OBF_DATABASE_URL` and `OBF_DATABASE_TOKEN`. Both are
stored as *sensitive*, so their values cannot be read back from the dashboard —
keep your own copy when you create the token.

`/api/health` reports `"accounts":{"store":"hosted"}` once a deployment can see
the pair. A `"file"` there means the build predates the variables: a saved
variable does nothing until the next deployment.

The administrator `openbatteryflux@gmail.com` was seeded already verified, so
sign-in works at once and no verification email is needed:

```bash
export OBF_DATABASE_URL='turso://openbatteryflux-openbatteryflux.aws-eu-west-1.turso.io'
export OBF_DATABASE_TOKEN='...'          # the token from Turso
python3 backend/tools/accounts_cli.py ensure-admin --email openbatteryflux@gmail.com
```

Add `--reset-password` to rotate the password, and run `check` to see what the
deployment still needs (an administrator address, working email delivery).

## 12. Why the deployed site is quick

The live deployment is configured by `vercel.json` at the repository root, and
each part of that file exists for a measured reason:

| part | what it does | why |
| --- | --- | --- |
| `regions: ["fra1"]` | runs the API function in Frankfurt | the default was US East (`iad1`): every request from Europe crossed the Atlantic twice, and each Turso query in `aws-eu-west-1` did too. Frankfurt sits next to both, so a request costs ~20 ms instead of ~200 ms |
| `builds` + `frontend/**` as `@vercel/static` | the website is served from Vercel's CDN | before, the Python function served every HTML, CSS, JS and image, so a page load meant eight serverless invocations and an uncompressed 146 KB `app.js`. From the CDN they are brotli-compressed, cached at the edge, and cannot be delayed by a cold function |
| `routes` | keeps `/api/*`, `/cell/*`, `/robots.txt` and `/sitemap.xml` on the function | those four are generated in Python and must not be served as files |
| `Cache-Control: max-age=600` on `/js/` and `/css/` | the browser reuses scripts and styles | a repeat visit downloads no scripts at all |
| `@vercel/python` `includeFiles` | ships `backend/data/` inside the function | without it the deployed function cannot find `cells.db` |

Matching changes live in the app itself:

- `/api/library` is serialised once per function instance, sent with an ETag and
  `Cache-Control: public, max-age=300`, so a repeat visit either reuses the copy
  it already has or gets a 304. It used to be re-read from SQLite and re-sent
  (1.1 MB) on every page load.
- `frontend/js/library.js` calls `/api/health` as soon as the page starts, so the
  function — which scales to zero and needs about two seconds to start — is
  already awake when the visitor signs in or opens a tool. The same file also
  starts the `/api/library` download itself, rather than waiting for `app.js` to
  parse: the two used to be serialised, which cost a round trip on every cold
  visit.
- `#/library` builds the first 96 cells and puts the rest behind **Show more**.
  Building all 1,308 cards at once was ~1 s of layout in one block; the first
  screenful now appears in well under 100 ms. `content-visibility: auto` on the
  cards keeps the ones scrolled past out of layout and paint, and the chart's
  link to a cell builds up to that cell in a single insertion.

**When you change a script or a stylesheet, bump its `?v=` number in
`frontend/index.html`.** Scripts and styles are cached for ten minutes and can be
served stale within that window; the query string is what makes a new file
appear immediately. HTML is always revalidated, so a deploy is picked up by the
next page load.

Everything else under `/api` stays `no-store`: accounts, sessions and tool events
are never cached, at the CDN or in the browser.
