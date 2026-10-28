import { spawn } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import path from "node:path";
import { safeAncestors, durableDirectory } from "./native-io.mjs";
const nativeUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);

async function captureNative(program, args) {
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  return await new Promise((resolve) => {
    const started = Date.now(); let output = ""; let settled = false, failed = false, failure = null;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { failed = true; failure = "deadline"; child.kill("SIGKILL"); }, 10000);
    child.stdout.on("data", (bytes) => { output += bytes.toString("utf8"); if (output.length > 4096) { failed = true; failure = "output_bound"; child.kill("SIGKILL"); } });
    child.stderr.resume(); child.once("error", () => { failed = true; failure = "startup"; });
    child.once("close", (code) => {
      const helper = { pid: child.pid ?? null, exit_code: code, signal_code: child.signalCode, elapsed_ms: Date.now() - started, failure };
      if (failed || code !== 0) finish({ state: "unknown", helper });
      else { try { const value = JSON.parse(output); finish(value.state === "unknown" ? { ...value, helper } : value); }
        catch { finish({ state: "unknown", helper: { ...helper, failure: "invalid_output" } }); } }
    });
  });
}

async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) return { state: "unknown" };
  if (process.platform === "linux") {
    try {
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!nativeUuid(boot)) return { state: "unknown" };
      let stat;
      try { stat = await readFile(`/proc/${pid}/stat`, "utf8"); }
      catch (error) { return { state: error.code === "ENOENT" ? "absent" : "unknown" }; }
      const end = stat.lastIndexOf(")");
      const start = stat.slice(end + 2).split(" ")[19];
      if (end < 0 || !/^[0-9]+$/u.test(start)) return { state: "unknown" };
      return { state: "present", identity: { platform: "linux", pid, start, boot, uid: process.getuid() } };
    } catch { return { state: "unknown" }; }
  }
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
      try { $nativeProcess=[System.Diagnostics.Process]::GetProcessById(${pid}); $start=$nativeProcess.StartTime.ToUniversalTime().Ticks.ToString();
        @{state='present';identity=@{platform='win32';pid=${pid};start=$start}} | ConvertTo-Json -Compress }
      catch [System.ArgumentException] { @{state='absent'} | ConvertTo-Json -Compress }
      catch { @{state='unknown'} | ConvertTo-Json -Compress }`;
    return await captureNative("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]) ?? { state: "unknown" };
  }
  return { state: "unknown" };
}


async function nativeOsLock(lockFile) {
  await safeAncestors(lockFile);
  let file;
  try { file = await open(lockFile, "wx", 0o600); await file.sync(); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { await file?.close(); }
  const stat = await lstat(lockFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("CMS native OS lock file must be an unlinked regular file.");
  let program, args;
  if (process.platform === "linux") {
    const helper = `process.stdout.write('{"state":"locked"}\\n'); process.stdin.setEncoding('utf8'); let buffer='';
      process.stdin.on('data', (data)=>{ buffer+=data; while(buffer.includes('\\n')) {const end=buffer.indexOf('\\n');const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line==='probe')process.stdout.write('{"state":"held"}\\n');} });
      process.stdin.on('end',()=>process.exit(0));`;
    program = "/usr/bin/flock";
    args = ["--exclusive", "--nonblock", "--conflict-exit-code", "73", "--", lockFile, process.execPath, "--input-type=module", "-e", helper];
  } else if (process.platform === "win32") {
    const encodedPath = Buffer.from(lockFile, "utf8").toString("base64");
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
      [Console]::Error.WriteLine('{"stage":"entered"}');
      $nativeLockPath=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'));
      [Console]::Error.WriteLine('{"stage":"before_open"}');
      try { $nativeStream=[System.IO.File]::Open($nativeLockPath,[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None); [Console]::Error.WriteLine('{"stage":"acquired"}') }
      catch { [Console]::Error.WriteLine((@{stage='open_failed';exception_type=$_.Exception.GetType().FullName;hresult=$_.Exception.HResult} | ConvertTo-Json -Compress)); [Console]::WriteLine('{"state":"busy"}'); exit 73 }
      try { [Console]::WriteLine('{"state":"locked"}'); while($null -ne ($line=[Console]::ReadLine())) {if($line -eq 'probe'){[Console]::WriteLine('{"state":"held"}')}} }
      finally { $nativeStream.Dispose() }`;
    program = "powershell.exe"; args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  } else throw new Error("CMS native OS locking is unavailable on this unqualified platform.");
  const started = Date.now();
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const events = { spawned_ms: null, first_stdout_ms: null, first_stderr_ms: null, exit_ms: null, close_ms: null, startup_error: null };
  let stderr = "", stderrBytes = 0;
  child.once("spawn", () => { events.spawned_ms = Date.now() - started; });
  child.once("error", (error) => { events.startup_error = typeof error.code === "string" ? error.code : "unavailable"; });
  child.once("exit", () => { events.exit_ms = Date.now() - started; });
  const completed = new Promise((resolve) => child.once("close", () => { events.close_ms = Date.now() - started; resolve(); }));
  const lines = [], waiting = []; let buffer = "", ended = false, observedState = null;
  const observation = () => ({
    pid: child.pid ?? null, observed_state: observedState, exit_code: child.exitCode,
    signal_code: child.signalCode, elapsed_ms: Date.now() - started, lock_file: lockFile,
    events: { ...events }, partial_stdout: buffer.slice(0, 2048), stderr: stderr.slice(0, 4096), stderr_bytes: stderrBytes
  });
  const helperError = (message) => Object.assign(new Error(message), { native_helper: observation() });
  const fail = () => { ended = true; for (const pending of waiting.splice(0)) pending.reject(helperError("CMS mapping is locked or its native OS lock helper is unavailable.")); };
  child.stdin.on("error", fail); // Helper death between probe/check and write must reject safely, not crash the worker on EPIPE.
  child.stderr.on("data", (data) => {
    events.first_stderr_ms ??= Date.now() - started; stderrBytes += data.length;
    if (stderr.length < 4096) stderr += data.toString("utf8").slice(0, 4096 - stderr.length);
  });
  child.once("error", fail); child.once("exit", fail);
  child.stdout.on("data", (data) => {
    events.first_stdout_ms ??= Date.now() - started;
    buffer += data.toString("utf8");
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n"); const value = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      try { observedState = JSON.parse(value).state; } catch {}
      if (waiting.length) waiting.shift().resolve(value); else lines.push(value);
    }
  });
  const nextLine = (deadline = 5000) => {
    if (lines.length) return Promise.resolve(lines.shift());
    if (ended) return Promise.reject(helperError("CMS mapping is locked or its native OS lock helper is unavailable."));
    return new Promise((resolve, reject) => {
      const item = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => { const index = waiting.indexOf(item); if (index >= 0) waiting.splice(index, 1); reject(helperError("CMS native OS lock helper response timed out.")); }, deadline);
      waiting.push(item);
    });
  };
  let releasing;
  const release = () => releasing ??= (async () => {
    try { child.stdin.end(); } catch {}
    const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
    try { await completed; } finally { clearTimeout(timer); }
  })(); // Unavailable stdin is not proof that the helper/process has exited.
  try {
    if (JSON.parse(await nextLine(15000)).state !== "locked") throw Object.assign(helperError("CMS mapping is locked by a native OS handle."), { code: "ELOCKED" });
  } catch (error) { await release(); if (error.native_helper) error.native_helper.after_cleanup = observation(); throw error; }
  return {
    async assertHeld() {
      if (ended || child.exitCode !== null || child.signalCode !== null) throw new Error("CMS native OS lock ownership is unavailable.");
      child.stdin.write("probe\n");
      if (JSON.parse(await nextLine()).state !== "held") throw new Error("CMS native OS lock ownership is unavailable.");
    }, release, observation,
  };
}

// The native entry points share this OS handle in addition to mapping fences.
// A live/paused owner cannot lose it merely because a lease timer expires.
export async function withCmsNativeLock(lockRoot, action) {
  lockRoot = path.resolve(lockRoot);
  await durableDirectory(lockRoot);
  const lock = await nativeOsLock(path.join(lockRoot, "writer.os-lock"));
  try { await lock.assertHeld(); return await action(lock.assertHeld); }
  finally { await lock.release(); }
}

export const assertCmsSafePath = safeAncestors;
export const createCmsPrivateDirectory = durableDirectory;
let ownIdentity;
export async function getCmsProcessIdentity(pid) {
  if (pid === process.pid && ownIdentity) return structuredClone(ownIdentity);
  const result = await processIdentity(pid);
  // A successful actual self start identity cannot change while this process
  // lives. Other PIDs, unknown probes and future processes never share it.
  if (pid === process.pid && result.state === "present") ownIdentity = structuredClone(result);
  return result;
}
export { nativeOsLock };
