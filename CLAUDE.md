# Repository guidance

- Use Bun for package management, scripts, tests, builds, and runtime.
- Run `bun run check` before shipping changes.
- Format and lint maintained files with Biome; do not add competing formatter or linter configs.
- Keep Fitia protocol and credential logic in `packages/core`.
- Keep `apps/cli` and `apps/mcp` as thin transport adapters.
- Never write diagnostics to stdout in the MCP server; stdout is JSON-RPC only.
- Preserve the CLI's versioned JSON envelope and preview-first mutation contract.
