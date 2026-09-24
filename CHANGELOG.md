# Changelog

## v2.2.1

### Added
- Author social links (GitHub / LinkedIn / X) in the GUI topbar and an Author
  section in the README.

## v2.2.0

### Added
- **Pip-installable package.** Added `pyproject.toml`; the code now lives in a
  `mass_pii_finder/` package with `templates/` and `static/` shipped as package
  data. `pip install .` (or `pipx install .`) puts a **`mass-pii-finder`**
  command on your PATH that launches the GUI from any directory. Installable
  straight from GitHub via `pipx install git+…`.

### Changed
- Project restructured into the `mass_pii_finder` package. A thin root `app.py`
  shim keeps `python app.py` working exactly as before.

## v2.1.0

### Added
- **Full absolute URLs for endpoint findings.** Endpoint values (often bare
  relative paths like `/api/users` or `/main.12345.js`) are now resolved
  against the exact JS file they were found in, so the same path appearing in
  files served from different origins yields distinct, unambiguous URLs. Exposed
  as a new `resolved_urls` field on each endpoint finding, carried through JSON,
  SARIF, CSV, Markdown, HTML, and the GUI.
- **Clickable source links** in the GUI (findings table + detail drawer) and the
  HTML report. Source files and resolved endpoint URLs render as real `<a>`
  links (http/https/ws only), so you can jump straight to the file instead of
  reading a truncated path.

### Removed
- **Standalone CLI (`cli.py`).** The tool is now GUI-only (`python app.py`).
  All functionality — scanning, scope/auth confirmation, every report format,
  history, and diffing — is available in the web console.

### Changed
- GUI no longer shortens source URLs to a bare pathname — it shows the full URL.
- Markdown/CSV reports carry full source URLs (no longer truncated) plus the new
  resolved URLs.
- **Warm "amber ember" UI theme.** Re-graded the console from a cool blue-black /
  neon-green palette to a warm charcoal background, cream text, and a muted
  honey-amber accent, with a warm-tuned severity ramp (one cool teal note for
  LOW so severities stay distinguishable). Easier on the eyes for long sessions.

### Notes
- No change to scope enforcement, rate limiting, or the tool's read-only,
  no-credential-testing behavior. Links only point at URLs already discovered
  in-scope; nothing new is requested.

## v2.0.0
- Initial public release: multi-hop JS crawl, ~90 secret/PII patterns +
  freeform entropy heuristic, offline structural validation, scope-checked
  endpoint probing, weighted severity, JSON/HTML/SARIF/Markdown/CSV export,
  SQLite scan history, and scan-to-scan diffing.
