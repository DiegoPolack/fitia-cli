import { spawn } from "node:child_process";
import { join } from "node:path";
import { type SessionStore, validSession } from "./credential-types.ts";
import { CliError } from "./errors.ts";

// The script is constant code. Secret JSON is sent only through the anonymous
// stdin pipe. DPAPI CurrentUser authenticates/encrypts it before any disk write.
// Unlike Credential Manager's small blob limit, this handles Firebase sessions.
const script = `
$ErrorActionPreference = 'Stop'
$mutex = $null
$held = $false
try {
  Add-Type -AssemblyName System.Security
  Add-Type -AssemblyName System.Web.Extensions
  [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
  $serializer = New-Object Web.Script.Serialization.JavaScriptSerializer
  $request = $serializer.DeserializeObject([Console]::In.ReadToEnd())
  if ($request.name -notmatch '^[a-zA-Z0-9.-]{1,80}$') { throw 'invalid' }
  $sidValue = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $mutex = New-Object Threading.Mutex($false, ('FitiaCLI-' + $sidValue + '-' + $request.name))
  try { $held = $mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $held = $true }
  if (!$held) { throw 'busy' }
  $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'FitiaCLI'
  $path = Join-Path $directory ($request.name + '.dpapi')
  $entropy = [Text.Encoding]::UTF8.GetBytes('io.cueva.fitia-cli/' + $request.name)
  if (Test-Path -LiteralPath $directory) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'invalid' }
  }
  if (Test-Path -LiteralPath $path) {
    if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'invalid' }
  }
  switch ($request.operation) {
    'read' {
      if (!(Test-Path -LiteralPath $path)) { [Console]::Out.Write('null'); break }
      if ((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'invalid' }
      $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $entropy, 'CurrentUser')
      [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
      [Array]::Clear($plain, 0, $plain.Length)
    }
    'save' {
      if ($request.expected) {
        if (![IO.File]::Exists($path)) { throw 'changed' }
        $previous = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($path), $entropy, 'CurrentUser')
        $matches = [Text.Encoding]::UTF8.GetString($previous) -ceq $request.expected
        [Array]::Clear($previous, 0, $previous.Length)
        if (!$matches) { throw 'changed' }
      }
      [IO.Directory]::CreateDirectory($directory) | Out-Null
      $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
      $acl = New-Object Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid)
      $acl.SetAccessRuleProtection($true, $false)
      $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
      [IO.Directory]::SetAccessControl($directory, $acl)
      $plain = [Text.Encoding]::UTF8.GetBytes($request.session)
      $encrypted = [Security.Cryptography.ProtectedData]::Protect($plain, $entropy, 'CurrentUser')
      [Array]::Clear($plain, 0, $plain.Length)
      $temporary = Join-Path $directory ([Guid]::NewGuid().ToString() + '.tmp')
      try {
        $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($encrypted, 0, $encrypted.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($path)) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
      } finally { if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) } }
    }
    'remove' { if ([IO.File]::Exists($path)) { [IO.File]::Delete($path) } }
    default { throw 'invalid' }
  }
} catch { exit 1 } finally { if ($held) { $mutex.ReleaseMutex() }; if ($mutex) { $mutex.Dispose() } }
`;

function storageError() {
  return new CliError(
    "CREDENTIAL_STORE_ERROR",
    "Could not access the Windows-protected Fitia session.",
    "Use the Windows account that saved the session. No plaintext fallback is used. Sign in again if the session is damaged.",
    5,
  );
}

async function invoke(operation: string, name: string, session?: string, expected?: string): Promise<string> {
  if (process.platform !== "win32") throw storageError();
  return new Promise((resolve, reject) => {
    const executable = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "";
    let failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 65536) {
        failed = true;
        child.kill();
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", () => {
      clearTimeout(timer);
      reject(storageError());
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || failed) reject(storageError());
      else resolve(output);
    });
    child.stdin.end(JSON.stringify({ operation, name, session, expected }));
  });
}

export function windowsCredentialStore(name = "session"): SessionStore {
  if (!/^[a-zA-Z0-9.-]{1,80}$/.test(name)) throw storageError();
  return {
    name: "windows-dpapi",
    async read() {
      try {
        const value: unknown = JSON.parse(await invoke("read", name));
        if (value === null) return undefined;
        if (!validSession(value)) throw storageError();
        return value;
      } catch {
        throw storageError();
      }
    },
    async save(session, expected) {
      if (!validSession(session)) throw storageError();
      await invoke("save", name, JSON.stringify(session), expected ? JSON.stringify(expected) : undefined);
    },
    async remove() {
      await invoke("remove", name);
    },
  };
}
