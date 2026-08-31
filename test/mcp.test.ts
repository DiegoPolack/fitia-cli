import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { operations, VERSION } from "@fitia/core";

test("the built MCP server negotiates stdio and declares its safety surface", async () => {
  const messages = `${[
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ]
    .map((message) => JSON.stringify(message))
    .join("\n")}\n`;

  const result = await new Promise<{ stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = execFile(
      "bun",
      [resolve("apps/mcp/dist/fitia-mcp.js")],
      {
        env: { ...process.env, FITIA_TOKEN: "" },
        timeout: 5_000,
      },
      (error, stdout, stderr) => (error ? reject(error) : resolveResult({ stdout, stderr })),
    );
    child.stdin!.end(messages);
  });

  expect(result.stderr).toBe("");
  const responses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(responses[0].result.serverInfo).toEqual({ name: "fitia", version: VERSION });
  const tools = responses[1].result.tools;
  const mcpOperations = Object.values(operations).filter((operation) => "mcpName" in operation);
  expect(tools).toHaveLength(mcpOperations.length);
  for (const operation of mcpOperations) {
    const tool = tools.find((candidate: any) => candidate.name === operation.mcpName);
    expect(tool.description.startsWith(operation.description)).toBe(true);
    expect(tool.annotations.readOnlyHint).toBe(operation.risk === "read-only");
  }
  expect(tools.find((tool: any) => tool.name === "fitia-day-summary").annotations.readOnlyHint).toBe(true);
  expect(tools.find((tool: any) => tool.name === "fitia-meal-remove").annotations.destructiveHint).toBe(true);
  expect(tools.find((tool: any) => tool.name === "fitia-meal-log").inputSchema.properties.confirm.default).toBe(false);
});
