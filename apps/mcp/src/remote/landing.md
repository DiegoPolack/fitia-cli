# Fitia CLI

An unofficial interface for using your own Fitia account from a terminal or an AI assistant.

## Remote MCP

Connect an MCP client to:

`https://fitia.cueva.io/mcp`

The hosted MCP uses Clerk OAuth. Read access and write access are separate, and every write requires explicit confirmation.

## Local CLI

The local CLI supports renewable Google login through macOS Keychain, food search, daily macros, meal suggestions, and preview-first meal changes.

```sh
git clone https://github.com/crafter-station/fitia-cli.git
cd fitia-cli
bun install
bun run build
```

[View the source and documentation on GitHub](https://github.com/crafter-station/fitia-cli)

Fitia CLI is an independent project and is not affiliated with Fitia.
