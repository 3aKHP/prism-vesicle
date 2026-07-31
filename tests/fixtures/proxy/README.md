# Provider Proxy Test Fixture Certificates

These are **test-only** self-signed TLS certificates used exclusively by the
provider proxy boundary tests under `tests/integration/providers/`. They are
NOT production secrets.

- `ca.crt` / `ca.key` — a self-signed certificate authority for the sole purpose
  of signing the leaf below. It has no real identity and is trusted only inside
  the test fixture via Bun's per-request `tls: { ca }` option.
- `leaf.crt` / `leaf.key` — a server certificate for the non-routable synthetic
  hosts `provider.test`, `ws-provider.test`, and `provider-http.test` (and
  `127.0.0.1`). These hosts never resolve in real DNS; the local CONNECT-proxy
  fixture maps them to a loopback origin.

Long validity (20 years) avoids fixture churn. Regenerate with `openssl` if
needed; never use these outside the proxy-boundary tests, and never treat them as
a trust anchor for anything except the in-process fixture.
