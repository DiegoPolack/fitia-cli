import { spawn } from "node:child_process";
import { join } from "node:path";

// Only a path and operation cross stdin; diagnostics never leave this helper.
const script = `
$ErrorActionPreference = 'Stop'
try {
  $r = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $item = Get-Item -LiteralPath $r.path -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe' }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($r.protect) {
    if (!$item.PSIsContainer) { throw 'unsafe' }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
    [IO.Directory]::SetAccessControl($r.path, $acl)
  }
  $acl = if ($item.PSIsContainer) { [IO.Directory]::GetAccessControl($r.path) } else { [IO.File]::GetAccessControl($r.path) }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe' }
  }
} catch { exit 1 }
`;

export async function windowsPrivatePath(path: string, protect = false): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 15000);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ path, protect }));
  });
}
