# Findings & Decisions

## Requirements

- User wants immediate usable local deployment on macOS.
- User provided a new Anthropic API key and asked to switch and test it.
- User asked whether `$planning-with-files` was used and requested process recording.

## Research Findings

- OpenClaw non-interactive onboarding supports API-key auth switch via `--auth-choice apiKey --anthropic-api-key`.
- Gateway service is healthy and launchd-managed; model/auth failures are isolated from service uptime.
- Previous custom provider path (`https://pikachu.claudecode.love[/v1]`) is reachable via direct curl but OpenClaw agent calls returned `403 Your request was blocked`.

## Technical Decisions

| Decision                                                             | Rationale                                     |
| -------------------------------------------------------------------- | --------------------------------------------- |
| Keep planning files in project root                                  | Required by `planning-with-files` skill       |
| Use official Anthropic provider now                                  | Fastest path to restore first-chat capability |
| Set `agents.defaults.model.primary` to `anthropic/claude-sonnet-4-6` | Force route away from blocked custom provider |
| Remove custom provider entries from config                           | Prevent accidental reuse of blocked endpoint  |

## Issues Encountered

| Issue                                                 | Resolution                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| Custom gateway blocks OpenClaw calls with 403         | Deferred as backlog; moved runtime to official Anthropic provider |
| Immediate post-restart RPC probe can fail with `1006` | Re-run health after brief delay                                   |

## Resources

- `/Users/fullmetal/Documents/codes/openclaw/task_plan.md`
- `/Users/fullmetal/Documents/codes/openclaw/findings.md`
- `/Users/fullmetal/Documents/codes/openclaw/progress.md`
- `/Users/fullmetal/.openclaw/openclaw.json`
- `/Users/fullmetal/.openclaw/logs/gateway.log`

## Gateway TODO (follow-up)

1. Capture exact request/response diff between direct `curl /v1/messages` success and OpenClaw runtime `403` failure.
2. Enable request-level debug for provider call path in OpenClaw (headers/body shape; redact secrets).
3. Verify whether gateway blocks specific User-Agent, tool-calling payloads, or structured prompt fields.
4. Build a minimal reproducible payload from OpenClaw and replay with `curl` to isolate block condition.
5. If external rule confirmed, request allowlist/relaxation on gateway side.

## Visual/Browser Findings

- N/A for this phase (CLI-only workflow).
