# gearbox

## Install

macOS, Linux, WSL:

```bash
curl -fsSL https://unpkg.com/gearbox-code@latest/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://unpkg.com/gearbox-code@latest/install.ps1 | iex
```

These installers do not use `sudo`, admin privileges, or `npm install -g`.
They install Gearbox into a user-owned directory, create the `gearbox` command,
then start onboarding before the coding app opens.

Run without installing:

```bash
npx gearbox-code@latest
```

## First Run

Gearbox needs one provider account before it opens the coding app. The installer
runs setup automatically. You can also run it yourself:

```bash
gearbox onboard
```

Common setup commands:

```bash
gearbox auth add <api-key>                # auto-detects known key prefixes
gearbox auth add <provider> <api-key>     # anthropic, openai, google, deepseek, openrouter, groq, xai, mistral...
gearbox auth add codex                    # ChatGPT subscription through the Codex CLI
gearbox auth add codex work               # second ChatGPT account, isolated CODEX_HOME
gearbox auth add claude work              # second Claude account, isolated config
gearbox auth import                       # import credentials from env/cloud config
gearbox auth providers                    # list supported providers
gearbox auth test <id>                    # live-test a saved account
gearbox auth rm <id>                      # remove an account
```

After setup:

```bash
cd ~/your-project
gearbox
```

Launch flags: `--model <name>` pins a model, `--continue` / `-c` resumes the
latest session, `--yolo` auto-approves tool use, `--inline` keeps output in
normal terminal scrollback, `--fullscreen` forces the alt-screen UI. On a
light-background terminal, run `/theme light` inside the app.

Other useful commands:

```bash
gearbox doctor models                     # provider/model capability matrix
gearbox upgrade                           # update Gearbox to the latest version
```

No account configured means no fake/demo model: Gearbox runs onboarding first.

## Uninstall

macOS, Linux, WSL:

```bash
rm -f ~/.local/bin/gearbox
rm -f ~/.bun/bin/gearbox
rm -rf ~/.local/share/gearbox
```

Windows PowerShell:

```powershell
Remove-Item "$env:LOCALAPPDATA\Gearbox" -Recurse -Force
```

If you previously installed with npm global:

```bash
npm uninstall -g gearbox-code
```

If `gearbox` fails with `Unknown file extension ".tsx"`, an old Bun-linked
shim is still first on PATH. Remove it and reinstall:

```bash
rm -f ~/.bun/bin/gearbox
curl -fsSL https://unpkg.com/gearbox-code@latest/install.sh | bash
```

## What It Is

Gearbox is a terminal coding agent that can use the model accounts you already
pay for. It supports provider accounts, local credential storage, model routing,
session history, file edits, shell commands, MCP tools, web search, image input,
and permission gates.

Supported setup paths include API keys, detected env/cloud credentials, Azure,
and provider CLIs where available.

## Capabilities

Paste or drag an image path into the composer to attach screenshots or UI
captures. Local image attachments work with API-backed multimodal models.

Gearbox loads MCP servers from `~/.gearbox/mcp.json`, `.mcp.json`, or
`.gearbox/mcp.json`. Manage them from the command line:

```bash
gearbox mcp list                          # show configured MCP servers
gearbox mcp add <name> <cmd> [args...]    # add a server (--global for ~/.gearbox)
gearbox mcp tools                         # list the tools each server exposes
gearbox mcp paths                         # show which config files are read
gearbox mcp remove <name>                 # remove a server
```

Example MCP config:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

The built-in `web_search` tool works out of the box with DuckDuckGo, and uses
Brave or SearXNG when `BRAVE_SEARCH_API_KEY` or `SEARXNG_URL` is set.

## Develop

Requires [Bun](https://bun.sh).

```bash
bun install
bun run src/cli.tsx
bun test
bun run typecheck
```
