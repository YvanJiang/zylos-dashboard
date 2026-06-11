# Dev Plan: API key management UI (#212)

## Summary

Add an "API Keys" section to the fleet management modal from #210 so this dashboard can create, list, and revoke its own access keys from the UI. This completes the onboarding loop: create a read key here, paste it into another dashboard's add-agent form.

## Scope

**In**: admin-gated local API key CRUD, show-once plaintext create response, API key list/revoke UI inside the existing management modal, read/admin scope picker, admin-scope warning, copy button, i18n, proxy denylist.

**Out**: editing existing keys, recovering plaintext keys after creation, rotating active keys in place, changing token/session TTL behavior, producer-side changes beyond existing auth APIs.

## Existing Contracts

- `src/lib/auth.js` already owns `generateApiKey()` and `hashApiKey()`.
- `src/lib/store.js` already owns `insertApiKey`, `getApiKeyByName`, `listApiKeys`, `revokeApiKey`, and `touchApiKey`.
- `scripts/api-key.js` proves the current CLI model: duplicate names are rejected even if a previous key is revoked; revoked keys remain listed; plaintext is printed once at creation and cannot be retrieved later.
- #210 introduced the right management surface, admin-gated local routes, and explicit fleet-proxy denylist behavior. #212 should follow that shape instead of adding a new modal or settings page.

## API Design

Consumer-local routes:

- `GET /api/keys`
  - Response: `{ keys: [{ name, scope, created_at, last_used_at, revoked_at, status }] }`
  - Never includes plaintext keys or key hashes.
  - `status` is derived as `active` / `revoked` for UI convenience; timestamps remain raw ISO/SQLite strings for exact display.
- `POST /api/keys`
  - Body: `{ name, scope }`
  - Validation:
    - `name`: trim, `[\w.-]{1,64}`. Reject empty / invalid as `invalid_name`.
    - duplicate any existing key name, active or revoked, as `duplicate_name` (matches CLI; users can choose a new name).
    - `scope`: `read` or `admin`; reject otherwise as `invalid_scope`.
  - Generate key with `generateApiKey()`, store `hashApiKey(key)`, return `{ ok: true, key: { name, scope, created_at, status: "active" }, plaintext_key }`.
  - Plaintext appears exactly once in this response. Follow-up GET must not contain it.
- `DELETE /api/keys/<name>`
  - Revokes an active key by name using `store.revokeApiKey(name)`.
  - `404 { error: "unknown_key" }` if no active key exists for that name.
  - Response: `{ ok: true, keys: [...] }` so UI can refresh without a second request.

## Authorization And Proxy Boundary

- Extend `needsAdminApiAccess()`:
  - `/api/keys` and `/api/keys/<name>` require admin for every method.
  - Read-scope API sessions get `403 insufficient_scope`.
  - Browser session remains allowed.
- Extend fleet-proxy local-only denylist:
  - `/api/keys`, `/api/keys/<name>`, and encoded/normalized variants must return `403 local_endpoint_not_proxyable` before token exchange or upstream fetch.
  - Keep the #210 fail-closed behavior: decode failure or `%2f` variants are rejected.
- No key management data should appear in `/api/state`, `/api/fleet`, SSE fleet payloads, or remote proxy responses.

## Frontend Design

- Reuse the #210 management modal and add a second tab/section: `Fleet` and `API Keys`.
- Keep the top-header robot/manage button behavior unchanged from #210, including in-page remote mode semantics: the modal manages the local dashboard.
- API Keys section:
  - List rows: name, scope badge, status, created, last used.
  - Revoke button only for active keys; confirm before revoke.
  - Create form: name input + scope segmented control/select (`read`, `admin`) + create button.
  - Admin scope warning appears when `admin` is selected: it allows remote Actions/Settings/restart/upgrade paths governed by #207.
  - Show-once result panel after create:
    - plaintext key in a readonly/password-style field or mono block,
    - copy button,
    - clear/dismiss button,
    - explicit text that it will not be shown again.
- Cross-link hints:
  - In API Keys: "Use a read key when adding this dashboard from another agent."
  - In Fleet add form: "Paste a read key created on the remote dashboard."
- Disable create/revoke buttons while in-flight and restore in `finally`, matching #210's add/test handling.
- i18n en/zh for all new labels/errors; cache-bust `app.js` if changed.

## Implementation Steps

1. Add server helpers near the #210 fleet management handlers:
   - `normalizeApiKeyName`
   - `apiKeysPayload`
   - `validateApiKeyScope`
   - `handleApiKeys`
   - `handleApiKeyDelete`
2. Route `/api/keys` and `/api/keys/<name>` in `src/index.js`.
3. Extend `needsAdminApiAccess()` and fleet-proxy local-only endpoint detection.
4. Extend the modal markup and JS:
   - tabs/section switching,
   - load API keys on modal open or tab activation,
   - create/revoke handlers,
   - show-once copy panel.
5. Add i18n strings and CSS using existing modal/list/button patterns.
6. Keep CLI behavior unchanged.

## Tests

- API:
  - admin-gate: browser/admin API allowed; read API gets 403.
  - `GET /api/keys` lists active and revoked keys without hash/plaintext.
  - `POST /api/keys` creates read key and returns plaintext exactly once.
  - duplicate key name rejected, including previously revoked names.
  - invalid name/scope rejected with stable error codes.
  - admin key creation works and records scope `admin`.
  - `DELETE /api/keys/<name>` revokes active keys; second delete returns 404.
  - revoked key can no longer exchange for a session token.
- Proxy:
  - `/fleet/<agent>/api/keys`, `/fleet/<agent>/api/keys/<name>`, and encoded slash variants fail closed with `local_endpoint_not_proxyable` and remote hit count stays zero.
- Frontend static/behavior:
  - modal contains API Keys section/tab.
  - create scope control and admin warning are present.
  - plaintext panel is populated only from POST response, never from list payload.
  - copy button uses clipboard API with fallback/status.
  - in-flight create/revoke buttons disable and restore.
  - en/zh strings exist.
- Regression:
  - full `npm test`
  - `npm run check`
  - `git diff --check`

## Acceptance Checklist

- Create a read key in the producer dashboard; plaintext appears once and can be copied.
- Refresh the modal/page; the plaintext key is gone, but the key row remains listed as active.
- Use the read key from another dashboard's add-agent form; test connection reports reachable/read.
- Create an admin key and confirm the warning is visible before/while creating it.
- Revoke a key; list updates to revoked, and token exchange with that key fails.
- Read-scope API session cannot access `/api/keys`.
- `/fleet/<remote>/api/keys` never reaches the remote.

## Open Questions

- Should revoked keys stay visible by default, or should the UI default to active-only with a "show revoked" toggle? The CLI lists both, so the conservative v1 plan is to show both with revoked visually dimmed.
- Should duplicate names be blocked forever, matching CLI, or allow reuse after revoke? The plan keeps CLI-compatible "blocked forever" semantics for now.
