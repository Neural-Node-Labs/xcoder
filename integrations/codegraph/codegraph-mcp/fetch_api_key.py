"""
Fetches a real CodeGraph API key for the admin account by logging in over HTTP, for use by
entrypoint.sh when CODEGRAPH_API_KEY isn't already set (the normal case in docker-compose,
where codegraph-api generates its admin's key at first boot rather than accepting a pre-set
one — see codegraph/app/db.py's seed_admin_if_missing).

Retries while codegraph-api is still starting up (its own container may report "healthy" via
Docker's healthcheck slightly before it's actually accepting connections under load), then
prints ONLY the api_key to stdout so the calling shell script can capture it directly with
`$(...)` — nothing else goes to stdout; progress/errors go to stderr.
"""
import json
import sys
import time
import urllib.request
import urllib.error

def main():
    if len(sys.argv) != 3:
        print("usage: fetch_api_key.py <api_url> <admin_password>", file=sys.stderr)
        sys.exit(2)
    api_url, password = sys.argv[1].rstrip("/"), sys.argv[2]

    deadline = time.time() + 60
    last_error = None
    while time.time() < deadline:
        try:
            req = urllib.request.Request(
                f"{api_url}/api/auth/login",
                data=json.dumps({"username": "admin", "password": password}).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = json.loads(resp.read())
                api_key = body.get("user", {}).get("api_key")
                if not api_key:
                    print(f"[codegraph-mcp] login succeeded but response had no api_key: {body}", file=sys.stderr)
                    sys.exit(1)
                print(api_key)  # stdout: exactly the key, nothing else
                return
        except (urllib.error.URLError, urllib.error.HTTPError, ConnectionError, TimeoutError) as e:
            last_error = e
            print(f"[codegraph-mcp] waiting for {api_url} to accept admin login ({e}) ...", file=sys.stderr)
            time.sleep(2)

    print(f"[codegraph-mcp] gave up waiting for {api_url} after 60s: {last_error}", file=sys.stderr)
    sys.exit(1)

if __name__ == "__main__":
    main()
