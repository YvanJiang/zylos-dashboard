# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-18

### Added
- Real-time agent state monitoring (idle, busy, stuck, waiting)
- Context usage, rate limit, and cost tracking with statusline data
- Tool activity feed with running tools and subagent tracking
- Actions modal: runtime switch, model/effort change, threshold, upgrade
- Full i18n support (English + Chinese) with locale toggle
- SSE-based live updates with polling fallback
- PM2 service health monitoring with ring gauges
- Communication channel stats from C4 bridge
- Trends tab with token usage, cost, message throughput charts
- Cookie-based authentication with scrypt password hashing
- Caddy reverse proxy support with X-Forwarded-Prefix handling
- Hook-based data collection (7 Claude events, 5 Codex events)
- Offline spool for hook events when dashboard is unavailable
- Graceful Codex runtime degradation (hide Claude-only panels)
- Countdown timer and auto-refresh on runtime switch
- Install/uninstall lifecycle hooks for Claude Code settings
- Ingest endpoint security: loopback + proxy header dual gate

### Security
- Ingest endpoints reject proxied requests (loopback IP + X-Forwarded-Prefix check)
- Rate limiting and IP lockout on failed login attempts
- CSRF protection on logout
- Secure cookie attributes (HttpOnly, Secure, SameSite=Strict)
