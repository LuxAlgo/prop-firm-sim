# Security Policy

## What this project does (and does not) touch

- **Zero telemetry.** The engine, CLI, and MCP server collect nothing and phone home to
  nothing. The only network calls in the repo are the CLI and MCP server fetching LuxAlgo's
  public, keyless prop-firm directory when you ask them to resolve a firm; inline specs run
  fully offline.
- **No secrets live in this repository.** CI uses GitHub-provided secrets only (`NPM_TOKEN` for
  npm publishing). Never commit tokens, API keys, or credentials - PRs containing them will be
  closed and the credentials must be rotated.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via GitHub security advisories: the
**Security → Report a vulnerability** button on this repository
(https://github.com/LuxAlgo/prop-firm-sim/security/advisories/new).

Do not open public issues or PRs for suspected vulnerabilities before a fix is released. You will
get a response through the advisory thread, and credit in the advisory if you want it.
