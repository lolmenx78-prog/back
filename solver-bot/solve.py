#!/usr/bin/env python3
"""
solve.py — Scheduled Cloudflare solver for animeblkom.net.

Runs inside GitHub Actions (free). Launches a REAL stealth browser
(SeleniumBase UC mode), routes it through the SAME Webshare proxy the API
uses, solves the Cloudflare Managed Challenge, then extracts cf_clearance +
the exact User-Agent + the proxy exit IP and publishes them to a GitHub Gist.

The browser-free API host then pulls that Gist and REPLAYS requests through
the same proxy IP with the same cookie+UA — no browser needed on the host.

Why the same proxy on both sides: Cloudflare binds cf_clearance to
(cookie + User-Agent + IP). Solve and reuse MUST share the exit IP, so both
the browser here and the API's forward-proxy transport use the same Webshare
endpoint.

Required env vars (set as GitHub Actions secrets):
  WEBSHARE_PROXY   host:port:user:pass   (one fixed Webshare proxy)
  GH_GIST_ID       the target gist id
  GH_TOKEN         a token with 'gist' scope
Optional:
  TARGET_URL       default https://animeblkom.net/
  CLEARANCE_TTL_MS default 1800000 (30 min)
  GIST_FILENAME    default clearance.json
"""

import json
import os
import sys
import time
import urllib.request

from seleniumbase import SB

TARGET_URL = os.environ.get("TARGET_URL", "https://animeblkom.net/")
GIST_FILENAME = os.environ.get("GIST_FILENAME", "clearance.json")
CLEARANCE_TTL_MS = int(os.environ.get("CLEARANCE_TTL_MS", str(30 * 60 * 1000)))


def parse_proxy(raw):
    """Accept host:port:user:pass OR user:pass@host:port -> dict."""
    raw = raw.strip()
    if "@" in raw:
        creds, hostport = raw.split("@", 1)
        user, pwd = creds.split(":", 1)
        host, port = hostport.split(":", 1)
    else:
        parts = raw.split(":")
        if len(parts) != 4:
            raise ValueError("WEBSHARE_PROXY must be host:port:user:pass or user:pass@host:port")
        host, port, user, pwd = parts
    return {
        "host": host,
        "port": port,
        "user": user,
        "pwd": pwd,
        "sb": f"{user}:{pwd}@{host}:{port}",  # SeleniumBase proxy string
        "url": f"http://{user}:{pwd}@{host}:{port}",
    }


def exit_ip_via_proxy(proxy):
    """Confirm the browser's egress IP == the proxy exit IP we will reuse."""
    try:
        handler = urllib.request.ProxyHandler({"http": proxy["url"], "https": proxy["url"]})
        opener = urllib.request.build_opener(handler)
        req = urllib.request.Request("http://ipv4.webshare.io/", headers={"User-Agent": "solver/ipcheck"})
        with opener.open(req, timeout=20) as r:
            return r.read().decode().strip()
    except Exception as e:
        print(f"[warn] exit IP check failed: {e}")
        return None


def publish_gist(payload):
    gist_id = os.environ["GH_GIST_ID"]
    token = os.environ["GH_TOKEN"]
    body = json.dumps(
        {"files": {GIST_FILENAME: {"content": json.dumps(payload, indent=2)}}}
    ).encode()
    req = urllib.request.Request(
        f"https://api.github.com/gists/{gist_id}",
        data=body,
        method="PATCH",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "animeblkom-solver",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"[ok] gist updated: HTTP {r.status}")


def looks_solved(sb):
    src = sb.get_page_source().lower()
    bad = ("just a moment" in src or "challenge-platform" in src or "cf-browser-verification" in src)
    return (not bad) and len(src) > 1500


def main():
    proxy = parse_proxy(os.environ["WEBSHARE_PROXY"])
    print(f"[info] target={TARGET_URL} proxy={proxy['host']}:{proxy['port']}")

    expected_ip = exit_ip_via_proxy(proxy)
    print(f"[info] proxy exit IP (expected): {expected_ip}")

    # UC mode = undetected Chrome. Headed under xvfb in CI for best pass rate.
    with SB(uc=True, headed=True, proxy=proxy["sb"], locale_code="ar") as sb:
        sb.uc_open_with_reconnect(TARGET_URL, reconnect_time=6)
        # Attempt the built-in CAPTCHA/Turnstile click if present.
        try:
            sb.uc_gui_click_captcha()
        except Exception as e:
            print(f"[info] captcha click step: {e}")

        # Poll up to ~60s for the challenge to clear.
        solved = False
        for i in range(20):
            if looks_solved(sb):
                solved = True
                break
            time.sleep(3)
            try:
                sb.uc_gui_click_captcha()
            except Exception:
                pass

        ua = sb.execute_script("return navigator.userAgent;")
        cookies = {c["name"]: c["value"] for c in sb.driver.get_cookies()}
        cf = cookies.get("cf_clearance")
        print(f"[info] solved={solved} cf_clearance={'yes' if cf else 'no'} cookies={list(cookies)}")

        if not cf:
            print("[error] no cf_clearance obtained; not publishing.")
            sys.exit(1)

        payload = {
            "host": "animeblkom.net",
            "cf_clearance": cf,
            "cookies": cookies,
            "user_agent": ua,
            "proxy": proxy["url"],
            "exit_ip": expected_ip,
            "solved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "ttl_ms": CLEARANCE_TTL_MS,
        }
        publish_gist(payload)
        print("[done] clearance published.")


if __name__ == "__main__":
    main()
