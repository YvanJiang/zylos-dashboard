# Dev Plan: Memory browser (#213)

## Summary

Add a dashboard Memory view for browsing the agent's `~/zylos/memory/` directory. The v0.3.0 slice is phase 1 only: read-only tree browsing, Markdown rendering/raw source toggle, and recent git commit metadata. Phase 2 editing is explicitly out of this implementation except for API/UI seams that avoid painting us into a corner.

## Scope

**In phase 1**: admin-gated read-only memory APIs, safe file tree, Markdown/raw view, per-file metadata (size, mtime, sha256), recent git commit info, local and in-page remote agent support through the fleet proxy, en/zh UI strings, tests.

**Out of phase 1**: editing/saving memory files, history browsing beyond "latest commit for this file", diffs, conflict resolution UI, writing KB/artifacts, changing how Memory Sync writes files.

**Phase 2 direction**: online editing with strict conflict detection. Saves must compare the file identity the user opened (`mtimeMs` + `sha256`, or stronger if needed) against the current file before write; mismatches return a conflict response and never silently overwrite. Remote editing remains a phase 2 decision, not part of v0.3.0.

## Existing Contracts

- Memory root is fixed by Zylos convention at `~/zylos/memory/`. Use the process environment/home expansion already available in Node, but never expose absolute host paths to the browser.
- The dashboard already uses `agentPath()` for remote agent API reads and #207 uses `remoteAccess()` to gate remote Actions/Settings UI.
- `AuthGate.needsAdminApiAccess()` is the single local/consumer authorization choke point for API sessions and proxied API paths.
- `FleetProxy` currently:
  - fail-closes encoded slash variants in the proxied URL path via `normalizeProxySuffix()`,
  - blocks explicitly local-only endpoints (#210/#212),
  - allows `GET`/`HEAD` proxy reads by default,
  - allows only a narrow write whitelist.
- `FleetPoller` knows each configured remote agent's exchanged key scope via `getAgentAccess(agent.name)`.

## Phase 1 API Design

Producer endpoints, all admin-gated:

- `GET /api/memory/tree`
  - Returns a recursive tree rooted at memory root.
  - Response shape:
    - `{ root: { name: "memory", type: "directory", children: [...] } }`
    - file nodes include `{ path, name, type: "file", size_bytes, mtime, sha256, renderable }`
    - directory nodes include `{ path, name, type: "directory", children }`
  - `path` is always memory-root-relative with POSIX separators, never absolute.
  - Sort directories before files, then locale/name stable sort.
  - Hide `.git/` from the tree. Do not traverse symlinks.

- `GET /api/memory/file?path=<relative>`
  - Returns one file's content and metadata.
  - Response shape:
    - `{ path, name, size_bytes, mtime, sha256, markdown, text }`
  - `markdown` is true for `.md`/`.markdown`; the frontend renders Markdown client-side or with a small local renderer already present/added in the app.
  - Restrict phase 1 to text/markdown files. Non-renderable files return `415 { error: "unsupported_memory_file" }` or appear disabled in the UI.

- `GET /api/memory/git?path=<relative>`
  - Returns latest commit info for a file or directory:
    - `{ path, commit: { hash, short_hash, subject, author_name, author_date } | null }`
  - Implement with `git -C <memoryRoot> log -1 --format=... -- <relativePath>`.
  - If memory is not a git repo, return `{ commit: null }`, not a 500.

## Authorization And Remote Proxy

Memory contains identity, user profiles, decisions, and project/session history. Treat it as admin-only everywhere.

Authorization rules:

- Local producer:
  - Extend `needsAdminApiAccess()` so `/api/memory` and `/api/memory/*` require admin for every method.
  - Browser sessions remain allowed.
  - Read-scope API sessions get `403 insufficient_scope`.

- Consumer boundary for remote memory:
  - Extend `needsAdminApiAccess()` for proxied paths so `/fleet/<agent>/api/memory` and `/fleet/<agent>/api/memory/*` require the consumer request to be admin.
  - This prevents a read-scope session on the consumer dashboard from even attempting remote memory access.

- Remote producer authority:
  - Remote memory requests go through `agentPath('/api/memory/...')`, so the producer receives `/api/memory/...` with the remote session token generated from the configured fleet key.
  - If the configured remote key is read scope, producer `AuthGate` returns `403 insufficient_scope`.
  - The UI must also hide/disable remote Memory for `remoteAccess() !== "admin"` with a clear tooltip/status. Do not rely on UI only.

Fleet proxy policy:

- Unlike #210/#212, `/api/memory/*` is **not local-only**. It must be proxyable for `GET`/`HEAD` when the remote key is admin scope.
- Do not add it to `isLocalOnlyEndpoint()`.
- Keep write methods blocked in phase 1. `POST`/`PUT`/`DELETE` to `/fleet/<agent>/api/memory/*` should remain `403 read_only_proxy` unless phase 2 explicitly expands the whitelist.
- Keep encoded-slash fail-closed behavior for the proxied URL path. Examples:
  - `/fleet/Apollo/api%2Fmemory/tree` -> `403 local_endpoint_not_proxyable`
  - `/fleet/Apollo/api/memory%2Ftree` -> `403 local_endpoint_not_proxyable`
  - normal `/fleet/Apollo/api/memory/tree` may proxy.

## Path Safety

Both producer and consumer must validate memory paths.

Producer filesystem validation:

- Parse relative memory paths only from query parameters, never from arbitrary URL path segments beyond the fixed endpoint.
- Normalize with POSIX separators for the API contract, then resolve against `memoryRoot`.
- Reject:
  - empty path where a file is required,
  - absolute paths,
  - drive-letter paths,
  - `.` / `..` segments,
  - NUL bytes,
  - symlinks or paths whose realpath escapes `memoryRoot`,
  - directories for `/api/memory/file`.
- Use `fs.realpath`/`path.relative` after resolving, and require the final real path to stay inside the real memory root.
- Return stable errors: `invalid_memory_path`, `memory_file_not_found`, `unsupported_memory_file`.

Consumer proxy validation:

- For proxied `/api/memory/file` and `/api/memory/git`, validate the decoded `path` query with the same relative-path grammar before fetching upstream.
- This does not replace producer validation; it prevents obviously unsafe proxy requests from leaving the consumer.
- Query strings may legitimately contain encoded slashes for nested files (`reference%2Fprojects.md`), so the #210 encoded-slash fail-closed rule applies to the proxied URL **path**, not to the `path` query value.

## Frontend Design

Add a Memory tab/panel to the existing dashboard detail area, available for local agent and in-page remote agent detail.

UI shape:

- A two-pane layout:
  - left: tree of memory files/directories with size and modified time,
  - right: selected file viewer.
- File viewer:
  - header: relative path, size, modified time, sha hash short prefix, latest commit short hash/subject/date if present,
  - toggle: `Rendered` / `Raw`,
  - Markdown rendered by default for `.md`; raw source available for all supported text files.
- Initial selection:
  - Prefer `identity.md` if present, else first markdown file, else first supported text file.
- Remote behavior:
  - Uses `fetchJson('/api/memory/tree')` / `agentPath()` so in-page remote routes through `/fleet/<name>/api/memory/...`.
  - If `remoteIsReadOnly()` is true, hide or disable the Memory tab with an admin-scope explanation.
  - Standalone remote documents behave like local producer documents because `BASE_PATH` already points at that remote.
- Error states:
  - `insufficient_scope`: show admin key required.
  - `invalid_memory_path`: show invalid path.
  - missing git metadata: show no commit recorded, not an error.

Avoid placing Memory under the #210 manage modal. This is a browsing surface, not configuration.

## Implementation Steps

1. Backend helpers in `src/index.js` or a small `src/lib/memory-browser.js`:
   - resolve memory root,
   - normalize/validate relative memory path,
   - walk tree without symlinks,
   - read supported text files,
   - compute sha256 and mtime/size metadata,
   - get latest git commit metadata.
2. Add producer route handlers:
   - `/api/memory/tree`
   - `/api/memory/file`
   - `/api/memory/git`
3. Extend auth:
   - local `/api/memory*` admin gate,
   - proxied `/fleet/<agent>/api/memory*` admin gate.
4. Extend fleet proxy:
   - keep `/api/memory*` out of local-only denylist,
   - add consumer-side query-path validation for memory file/git endpoints,
   - keep all memory writes blocked by existing method policy.
5. Frontend:
   - add Memory tab or panel entry consistent with current dashboard tabs,
   - fetch tree/file/git through `agentPath()`,
   - render tree and viewer,
   - raw/render toggle,
   - remote read-only/admin-scope gating.
6. i18n and CSS.
7. Cache-bust `app.js` if frontend JS changes.

## Tests

Backend/API:

- `GET /api/memory/tree` requires admin; read API session receives `403 insufficient_scope`.
- Tree response includes known root files/directories with relative paths, sizes, mtimes, hashes; `.git` is absent.
- `GET /api/memory/file?path=identity.md` returns metadata + text and no absolute path.
- Invalid/traversal paths are rejected:
  - `../state.md`
  - `/Users/howard/zylos/memory/state.md`
  - `reference/../../.env`
  - NUL byte variant
  - symlink escape fixture.
- Non-text/unsupported file returns stable unsupported error.
- Git metadata returns latest commit shape when memory root is a git repo and null commit when not.

Proxy:

- Remote memory GET is proxyable with admin-scope remote key and reaches upstream.
- Remote memory GET with read-scope remote key returns producer `403 insufficient_scope`.
- Consumer read-scope API session calling `/fleet/<agent>/api/memory/tree` gets consumer-side `403 insufficient_scope`.
- Encoded slash variants in the proxied URL path fail closed before upstream hit:
  - `/fleet/Apollo/api%2Fmemory/tree`
  - `/fleet/Apollo/api/memory%2Ftree`
- Unsafe query paths are rejected consumer-side before upstream hit.
- Memory POST/PUT/DELETE remain blocked as `read_only_proxy`.

Frontend/static:

- Memory tab/panel exists and uses `agentPath('/api/memory/...')`.
- Remote read-only gating uses `remoteIsReadOnly()`.
- Raw/rendered toggle exists.
- en/zh strings exist.
- `app.js` cache bust updated.

Regression:

- `git diff --check`
- focused memory API/proxy/frontend tests
- `npm run check`
- full `npm test`

## Acceptance Checklist

- Local dashboard shows memory tree and can open `identity.md`, `state.md`, and `reference/projects.md`.
- Markdown render and raw source toggle both work.
- Latest git commit info appears for files in a git-backed memory root; missing commit displays gracefully.
- Read-scope API token cannot access any `/api/memory*` endpoint.
- A remote agent configured with an admin key shows its memory through in-page remote view.
- A remote agent configured with a read key does not expose Memory UI and API returns 403.
- Proxy traversal/encoded-slash probes fail before touching the remote where applicable.

## V1 Decisions

- Phase 1 is read-only only. No save buttons, no editable textarea, no phase 2 backend write route.
- Remote read-only browsing is in v1 because Howard explicitly requested it.
- Memory browser is admin-scope only, including tree metadata. There is no reduced read-scope subset.
- Latest commit metadata only. Full history/diff belongs to a later extension.
- Do not expose absolute filesystem paths in responses or UI.
