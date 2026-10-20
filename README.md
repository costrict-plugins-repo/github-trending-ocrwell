# @ocrwell/skill

A skill for the [OCRWell](https://ocrwell.com) document OCR API. Works with [Claude Code](https://docs.claude.com/claude-code) and OpenAI's [Codex CLI](https://developers.openai.com/codex/skills) — both read the same `SKILL.md` format. Once installed, the agent can generate correct integration code in any language — handling authentication, the two-step upload, asynchronous polling, structured JSON extraction, error handling, rate limits, and webhook signature verification — without any further prompting.

## What it gives the agent

- The full OCRWell `/v1` endpoint reference (uploads, documents, jobs, webhooks).
- The two-step upload pattern (`POST /v1/uploads` → `PUT` to presigned URL → `POST /v1/documents`).
- Both supported structured-extraction schema formats (template and JSON Schema), plus the JSON Schema subset rules.
- The complete error catalogue, rate-limit headers, and `Retry-After` semantics.
- Webhook delivery semantics and HMAC-SHA256 signature verification steps.
- A code-generation checklist that captures the gotchas — e.g. treating `200` with `job.status: "failed"` as a job failure rather than an HTTP error.

## Install

There are two ways to install. Pick whichever fits your workflow.

### Option 1 — Claude Code plugin marketplace (recommended)

```text
/plugin marketplace add ocrwell/skill
/plugin install ocrwell@ocrwell
```

This uses Claude Code's built-in plugin system. You'll get versioning, namespacing, and `/plugin update` support out of the box. The plugin is delivered via npm under the hood, so updates are tied to npm releases of `@ocrwell/skill`.

To update later:
```text
/plugin update ocrwell@ocrwell
```

To remove:
```text
/plugin uninstall ocrwell@ocrwell
```

### Option 2 — `npx` installer (Claude Code or OpenAI Codex)

The installer works for both Claude Code and OpenAI's [Codex CLI](https://developers.openai.com/codex/skills), which reads the same `SKILL.md` format from `~/.agents/skills/` (user-wide) or `.agents/skills/` (per repo).

Run without a target flag and the installer will prompt you:
```bash
npx @ocrwell/skill install
```

Or pick a target up front:
```bash
npx @ocrwell/skill install --claude           # ~/.claude/skills/ocrwell
npx @ocrwell/skill install --codex            # ~/.agents/skills/ocrwell
npx @ocrwell/skill install --both             # both
npx @ocrwell/skill install --codex --project  # ./.agents/skills/ocrwell
```

To update, re-run with `--force`:
```bash
npx @ocrwell/skill@latest install --claude --force
```

To remove:
```bash
npx @ocrwell/skill uninstall --claude
npx @ocrwell/skill uninstall --codex --project
```

The `/plugin` marketplace flow and the `.claude-plugin/` manifest used by Option 1 are Claude Code-specific — Codex ignores them and only reads the `SKILL.md` inside the installed skill directory.

## Verify the install

Start a new session in Claude Code or Codex and ask something OCRWell-related, for example:

> Write a Python script that uploads `invoice.pdf` to OCRWell and prints the extracted text.

If the skill is loaded, the agent will follow the documented two-step upload, send `X-API-Key` from an environment variable, poll `GET /v1/jobs/{jobId}` with backoff, and treat `status: "failed"` correctly. If it instead invents the API or asks for documentation, the skill isn't being picked up:

- **Claude Code:** confirm `ocrwell` appears under `/plugin` (Option 1) or that `~/.claude/skills/ocrwell/SKILL.md` exists (Option 2), then restart the session.
- **Codex:** run `/skills` and confirm `ocrwell` is listed, or check that `~/.agents/skills/ocrwell/SKILL.md` exists, then restart the session.

## What's in this package

```
.claude-plugin/
  plugin.json         # Claude Code plugin manifest
  marketplace.json    # Marketplace catalog (used by Option 1)
skills/ocrwell/
  SKILL.md            # The skill itself — loaded into the agent's context when triggered
  reference.md        # Deeper API reference, linked from SKILL.md
bin/
  install.mjs         # The npx installer (Option 2)
```

## API key

You need an OCRWell API key to actually call the API. Create one in the OCRWell dashboard. Then expose it to your code via environment variable:

```bash
export OCRWELL_API_KEY=...
```

The skill instructs the agent to read the key from an environment variable rather than hard-coding it. Treat the key like a password — it grants full access to your organisation's documents and webhook configuration.

## Versioning

`package.json` and `.claude-plugin/marketplace.json` carry the version and are bumped together whenever the OCRWell API changes (or the skill content does). `.claude-plugin/plugin.json` deliberately omits `version` — for relative-path plugins the docs recommend keeping the version in the marketplace entry only, because the plugin manifest silently wins when both are set. Use semver: bump the patch version for content fixes, the minor version for additive API changes, and the major version for breaking changes to the OCRWell API.

## Reporting issues

If Claude Code or Codex generates wrong or outdated code for OCRWell, please file an issue at <https://github.com/ocrwell/skill/issues> with the prompt you used, the tool you used it with, and the output you got back. Include the version number from `/plugin` (Claude Code), `/skills` (Codex), or the installed `SKILL.md` frontmatter.

## License

MIT.
