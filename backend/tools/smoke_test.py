#!/usr/bin/env python3
"""Smoke-test a deployed openBatteryFlux, from a URL only.

Run it after every deploy, or from CI, to answer one question: does this URL
serve the app and the API, or is something in front of it (a Vercel protection
screen, a dead function, a missing cell database) stopping visitors?

    python3 backend/tools/smoke_test.py https://your-site.example.com
    python3 backend/tools/smoke_test.py https://your-site.example.com --timeout 20

It uses only the standard library, sends no credentials and creates nothing:
the account check is a sign-in with a random address that has no account, which
must come back 401 rather than a 5xx. Every check prints one line, the exit code
is 0 only when all of them pass, and a 401 carrying Vercel's protection payload
is reported as such instead of as a generic failure.
"""
import argparse
import json
import random
import re
import string
import sys
import textwrap
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 15
UA = "openBatteryFlux-smoke-test/1.0"


class Result:
    def __init__(self):
        self.failures = 0
        self.passes = 0

    def ok(self, name: str, note: str = "") -> None:
        self.passes += 1
        print("  ok    %-22s %s" % (name, note))

    def fail(self, name: str, note: str) -> None:
        self.failures += 1
        print("  FAIL  %-22s %s" % (name, note))


def fetch(base: str, path: str, timeout: int, method: str = "GET", body=None):
    """Return (status, headers, text) or raise SystemExit on a transport error."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method)
    request.add_header("User-Agent", UA)
    request.add_header("Accept", "application/json, text/html;q=0.9, */*;q=0.8")
    if data:
        request.add_header("Content-Type", "application/json")
    # Header names arrive in whatever case the server used, so keep them folded.
    def headers_of(message) -> dict:
        return {name.lower(): value for name, value in message.items()}

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return (response.status, headers_of(response.headers),
                    response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as err:
        return err.code, headers_of(err.headers), err.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        sys.exit("Cannot reach %s%s\n  %s" % (base, path, getattr(err, "reason", err)))


def protected(status: int, text: str) -> bool:
    """True when the response is Vercel's Deployment Protection, not the app."""
    if status != 401:
        return False
    if "Protected by Vercel Authentication" in text:
        return True
    try:
        payload = json.loads(text)
    except ValueError:
        return False
    return isinstance(payload, dict) and "protection" in payload


def json_body(text: str):
    try:
        return json.loads(text)
    except ValueError:
        return None


def run(base: str, timeout: int) -> int:
    result = Result()
    print("openBatteryFlux smoke test against %s\n" % base)

    # 1. the page itself, before anything else: a protection screen must not be
    #    mistaken for a broken API.
    status, headers, text = fetch(base, "/", timeout)
    if protected(status, text):
        result.fail("GET /", "Vercel Deployment Protection answered (401)")
        print("\nThis URL is protected, so no visitor reaches the app. In Vercel:"
              "\n  Project -> Settings -> Deployment Protection -> Vercel Authentication:"
              "\n  apply it to preview deployments only, or turn it off, then redeploy."
              "\nA per-deployment URL (…-<hash>-…vercel.app) stays protected by design;"
              "\ntest the production domain instead.")
        return 1
    kind = headers.get("content-type", "")
    if status != 200:
        result.fail("GET /", "HTTP %s (expected 200)" % status)
    elif not kind.startswith("text/html"):
        result.fail("GET /", "Content-Type is %r, expected text/html" % kind)
    elif "openBatteryFlux" not in text:
        result.fail("GET /", "200 but the page does not look like this app")
    else:
        result.ok("GET /", "200 text/html, %d bytes" % len(text))

    # 2. the API and its database
    status, _, text = fetch(base, "/api/health", timeout)
    health = json_body(text)
    store = ""
    if isinstance(health, dict):
        store = (health.get("accounts") or {}).get("store", "")
    if protected(status, text):
        result.fail("GET /api/health", "Vercel Deployment Protection answered (401)")
    elif status != 200 or not isinstance(health, dict):
        result.fail("GET /api/health", "HTTP %s %s" % (status, text[:120].strip()))
    elif health.get("status") != "ok":
        result.fail("GET /api/health", "reported %r" % health.get("status"))
    elif not health.get("cells") or not health.get("chemistries"):
        result.fail("GET /api/health", "the cell library is empty: %s" % health)
    else:
        result.ok("GET /api/health", "ok, %d cells, %d chemistries, accounts: %s"
                  % (health["cells"], health["chemistries"], store or "unknown"))

    # 3. the library the browser actually needs
    status, _, text = fetch(base, "/api/library", timeout)
    library = json_body(text)
    if status != 200 or not isinstance(library, dict):
        result.fail("GET /api/library", "HTTP %s" % status)
        library = {}
    else:
        cells = library.get("cells") or []
        result.ok("GET /api/library", "%d cells, %d chemistries"
                  % (len(cells), len(library.get("chemistries") or [])))

    # 4. the SEO routes
    status, _, text = fetch(base, "/robots.txt", timeout)
    if status == 200 and "Sitemap:" in text:
        result.ok("GET /robots.txt", "200, sitemap advertised")
    else:
        result.fail("GET /robots.txt", "HTTP %s" % status)

    status, _, text = fetch(base, "/sitemap.xml", timeout)
    urls = len(re.findall(r"<loc>", text))
    if status == 200 and urls:
        result.ok("GET /sitemap.xml", "200, %d URLs" % urls)
    else:
        result.fail("GET /sitemap.xml", "HTTP %s, %d URLs" % (status, urls))

    # 5. a server-rendered cell page, using an id that really exists
    cell_id = (library.get("cells") or [{}])[0].get("id") if library else None
    if not cell_id:
        result.fail("GET /cell/<id>", "skipped: no cell id in the library")
    else:
        status, _, text = fetch(base, "/cell/%s" % cell_id, timeout)
        title = re.search(r"<title>([^<]*)</title>", text)
        if status == 200 and title:
            result.ok("GET /cell/<id>", "200, %r" % title.group(1).strip()[:48])
        else:
            result.fail("GET /cell/<id>", "HTTP %s for %s" % (status, cell_id))

    # 6. the accounts store: an unknown address must be a clean 401, not a 503.
    #    Nothing is created, and the random address keeps the check repeatable.
    suffix = "".join(random.choice(string.ascii_lowercase) for _ in range(10))
    status, headers, text = fetch(base, "/api/auth/login", timeout, method="POST",
                                  body={"email": "smoke-%s@example.invalid" % suffix,
                                        "password": "not-a-real-password"})
    detail = (json_body(text) or {}).get("detail", text[:120].strip())
    if protected(status, text):
        result.fail("POST /api/auth/login", "Vercel Deployment Protection answered (401)")
    elif status == 401:
        result.ok("POST /api/auth/login", "401 as expected (accounts reachable)")
    elif status == 429:
        result.ok("POST /api/auth/login", "429: rate limiting is active")
    elif status == 503:
        result.fail("POST /api/auth/login", "503: %s" % str(detail)[:96])
        if store == "file":
            advice = ("accounts are on a local file, which a serverless host "
                      "cannot write. Set OBF_DATABASE_URL and "
                      "OBF_DATABASE_TOKEN for Production and redeploy "
                      "(DEPLOY.md section 9).")
        elif store == "hosted":
            advice = ("the hosted database rejected the connection: check that "
                      "the token belongs to that database and has not expired "
                      "(DEPLOY.md section 9).")
        elif not store:
            advice = ("health did not report an accounts store, so this "
                      "deployment predates that check: redeploy the current "
                      "code (DEPLOY.md section 9).")
        else:
            advice = "the accounts store could not be opened (DEPLOY.md section 9)."
        for line in textwrap.wrap(advice, 72):
            print("        %s" % line)
        print("        health reported accounts: %s" % (store or "unknown"))
    else:
        result.fail("POST /api/auth/login", "HTTP %s: %s" % (status, detail))

    # 7. a static file from the deployment, to catch a broken asset path
    status, headers, _ = fetch(base, "/apple-touch-icon.png", timeout)
    icon_kind = headers.get("content-type", "")
    if status == 200 and icon_kind.startswith("image/"):
        result.ok("GET /apple-touch-icon.png", "200 %s" % icon_kind)
    else:
        result.fail("GET /apple-touch-icon.png", "HTTP %s" % status)

    print("\n%d passed, %d failed" % (result.passes, result.failures))
    if result.failures:
        print("See DEPLOY.md section 9 for what each failure means.")
        return 1
    print("The deployment serves the app, the library and the accounts API.")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Smoke-test a deployed openBatteryFlux.")
    parser.add_argument("url", help="the site's public origin, e.g. https://example.vercel.app")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help="seconds per request (default %d)" % DEFAULT_TIMEOUT)
    args = parser.parse_args(argv)
    base = args.url.strip().rstrip("/")
    if not re.match(r"^https?://", base):
        sys.exit("Give a full http(s) URL, for example https://your-site.example.com")
    return run(base, args.timeout)


if __name__ == "__main__":
    sys.exit(main())
