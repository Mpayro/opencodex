/**
 * Lock owner for the Windows nested live-lock regression (issue #4991).
 *
 * The regression in tests/ci-workflows/test-runner.test.ts proves that a nested Bun test
 * inherits the live test-run lock exactly and refuses an incomplete capability. It used
 * to read that capability out of its own environment, so it could only run while the
 * outer process already held a lock — and the hosted Windows batch leg sets
 * OCX_TEST_NO_QUEUE=1 precisely so that it does not. The case was therefore skipped on
 * the only platform it applies to, and the coverage existed on paper only.
 *
 * This controller supplies the missing owner instead of borrowing the lane's. It runs as
 * a plain "bun <file>" child with exactly one environment change — the no-queue opt-out
 * removed for this process and its descendants — resolves the user-scoped lock through
 * the ordinary safe path, and acquires it for its own run id. Nothing here writes an
 * owner file by hand: a fabricated capability would only prove that a child trusts what
 * it is told, which is the inverse of the contract under test.
 *
 * Two things about how it is launched are load-bearing. It must be spawned with a cwd
 * OUTSIDE the repository so Bun loads no bunfig preload into the owner itself; a
 * preloaded controller would take the same lock in tests/preload.ts and then wait on
 * itself. And it must be handed a temporary root it may write into, because every
 * fixture it generates and the foreign-owner probe it plants live there.
 *
 * Everything below runs only as an entry point. The test file imports the receipt key
 * from here, and an import must not acquire a lock or spawn anything.
 *
 * Output is one JSON line of booleans plus redacted diagnostics. The owner token never
 * reaches stdout, and child output is parsed rather than echoed.
 */
import { randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import {
  acquireTestRunLock,
  resolveWrappedTestRunLockPath,
  TEST_RUN_ID_ENV,
  TEST_RUN_LOCK_PATH_ENV,
  TEST_RUN_LOCK_TOKEN_ENV,
  TEST_RUN_NO_QUEUE_ENV,
  type TestRunLock,
} from "../../scripts/test-run-lock";
import { repoPath } from "./repo-root";

/** Shape the caller asserts on; every field must be true for the case to pass. */
export interface NestedLiveLockReceipt {
  lockOwned: boolean;
  healthyChildExited: boolean;
  healthyReceiptComplete: boolean;
  missingTokenRefused: boolean;
  wrongTokenRefused: boolean;
  wrongPathRefused: boolean;
  foreignOwnerTimedOut: boolean;
  foreignOwnerUntouched: boolean;
  ownerContentUnchanged: boolean;
  childrenReaped: boolean;
  releasedOnlyOwnLock: boolean;
  receiptRedacted: boolean;
}

export const NESTED_LIVE_LOCK_RECEIPT_KEY = "nestedLiveLockReceipt";
const CHILD_MARKER = '{"nestedLockReceipt":';
const CHILD_RECEIPT_KEYS = ["samePath", "sameRun", "sameToken", "member", "preloadRan", "guardArmed"] as const;
const CHILD_DEADLINE_MS = 15_000;
const ACQUIRE_POLL_MS = 250;
const ACQUIRE_MAX_WAIT_MS = 10_000;
const FOREIGN_POLL_MS = 100;
const FOREIGN_MAX_WAIT_MS = 300;

async function runNestedLiveLockController(tempRoot: string | undefined): Promise<void> {
  const receipt: NestedLiveLockReceipt = {
    lockOwned: false,
    healthyChildExited: false,
    healthyReceiptComplete: false,
    missingTokenRefused: false,
    wrongTokenRefused: false,
    wrongPathRefused: false,
    foreignOwnerTimedOut: false,
    foreignOwnerUntouched: false,
    ownerContentUnchanged: false,
    childrenReaped: false,
    releasedOnlyOwnLock: false,
    receiptRedacted: false,
  };
  const diagnostics: string[] = [];
  const note = (message: string): void => { diagnostics.push(message); };
  const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  let lock: TestRunLock | undefined;
  let ownerFile: string | undefined;
  let ownerBefore: string | undefined;
  let ownerToken: string | undefined;
  // Whether each spawned child was waited on, which is what reaping means for spawnSync.
  const settledChildren: boolean[] = [];

  try {
    if (process.platform !== "win32") throw new Error("the nested live-lock controller is Windows-only");
    if (!tempRoot) throw new Error("the nested live-lock controller needs a temporary root argument");
    if (process.env[TEST_RUN_NO_QUEUE_ENV] !== undefined) {
      throw new Error("the controller environment must have the no-queue opt-out removed");
    }

    // A wrapped or bare Windows run already owns this lock and handed us its complete
    // capability; joining it is the honest move, because a second owner for one path is
    // exactly the clobber this suite exists to prevent. The hosted no-queue lane has no
    // such owner, so there we resolve and acquire one of our own.
    const inheritedPath = process.env[TEST_RUN_LOCK_PATH_ENV]?.trim();
    const inheritedToken = process.env[TEST_RUN_LOCK_TOKEN_ENV]?.trim();
    const inheritedRunId = process.env[TEST_RUN_ID_ENV]?.trim();
    const joining = Boolean(inheritedPath && inheritedToken && inheritedRunId);
    const resolved = joining ? inheritedPath : resolveWrappedTestRunLockPath({ env: process.env });
    if (!resolved) throw new Error("the user-scoped Bun test lock path did not resolve");
    const lockPath = resolved;
    const runId = joining && inheritedRunId ? inheritedRunId : "nested-live-lock-" + randomUUID();

    lock = await acquireTestRunLock({
      runId,
      lockPath,
      validatedRuntimePath: true,
      env: process.env,
      joinExistingOwnerToken: joining ? inheritedToken : undefined,
      pollMs: ACQUIRE_POLL_MS,
      maxWaitMs: ACQUIRE_MAX_WAIT_MS,
    });
    const owner = lock.owner;
    if (!owner) throw new Error("the run lock produced no owner record");
    ownerToken = owner.token;
    receipt.lockOwned = true;

    // Publish the capability into our own environment so the children below inherit it the
    // way any descendant of a real run does, rather than being handed a constructed one.
    process.env[TEST_RUN_ID_ENV] = runId;
    process.env[TEST_RUN_LOCK_PATH_ENV] = lockPath;
    process.env[TEST_RUN_LOCK_TOKEN_ENV] = owner.token;

    const activeOwnerFile = join(lockPath, "owner.json");
    const activeOwnerBefore = readFileSync(activeOwnerFile, "utf8");
    ownerFile = activeOwnerFile;
    ownerBefore = activeOwnerBefore;
    receipt.ownerContentUnchanged = true;
    const confirmOwnerUnchanged = (): void => {
      const current = existsSync(activeOwnerFile) ? readFileSync(activeOwnerFile, "utf8") : null;
      if (current === activeOwnerBefore) return;
      receipt.ownerContentUnchanged = false;
      note("the owner receipt changed while a nested child ran");
    };

    const fixture = join(tempRoot, "nested-live-lock.test.ts");
    writeFileSync(fixture, [
      'import { test } from "bun:test";',
      'import { existsSync, readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'test("nested lock receipt", () => {',
      '  const path = process.env.OCX_TEST_RUN_LOCK_PATH ?? "";',
      '  const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));',
      "  console.log(JSON.stringify({ nestedLockReceipt: {",
      "    samePath: path === " + JSON.stringify(lockPath) + ",",
      "    sameRun: owner.runId === " + JSON.stringify(runId)
        + " && process.env.OCX_TEST_RUN_ID === " + JSON.stringify(runId) + ",",
      "    sameToken: owner.token === process.env.OCX_TEST_RUN_LOCK_TOKEN,",
      '    member: existsSync(join(path, "members", process.pid + "-" + owner.token)),',
      "    preloadRan: process.env.OCX_TEST_PRELOAD_PID === String(process.pid),",
      '    guardArmed: process.env.OCX_TEST_HOME_GUARD === "1",',
      "  } }));",
      "});",
      "",
    ].join("\n"));

    const args = ["test", "--preload", repoPath("tests", "preload.ts"), fixture];
    const runChild = (mutate?: (env: NodeJS.ProcessEnv) => void): SpawnSyncReturns<string> => {
      const env = { ...process.env };
      // Drop the two receipts the child is supposed to produce for itself. Inherited, they
      // would report a preload that never ran and a guard nobody armed.
      delete env.OCX_TEST_PRELOAD_PID;
      delete env.OCX_TEST_HOME_GUARD;
      mutate?.(env);
      const result = spawnSync(process.execPath, args, {
        cwd: tempRoot, env, encoding: "utf8", timeout: CHILD_DEADLINE_MS,
      });
      // spawnSync returns only after the child has been waited on, so a settled status or
      // signal IS the reap. A liveness probe on the pid would be a race against pid reuse.
      settledChildren.push(result.status !== null || result.signal !== null);
      return result;
    };
    const refusal = (result: SpawnSyncReturns<string>, needle: string, label: string): boolean => {
      const refused = result.status !== 0
        && (result.stderr ?? "").includes(needle)
        && !(result.stdout ?? "").includes(CHILD_MARKER);
      if (!refused) note(label + " was not refused (status " + String(result.status) + ")");
      return refused;
    };

    const healthy = runChild();
    receipt.healthyChildExited = healthy.status === 0;
    if (!receipt.healthyChildExited) {
      note("the healthy child exited with status " + String(healthy.status) + " signal " + String(healthy.signal));
    }
    const marker = (healthy.stdout ?? "").split("\n").find(line => line.startsWith(CHILD_MARKER));
    const nested = marker
      ? (JSON.parse(marker) as { nestedLockReceipt?: Record<string, unknown> }).nestedLockReceipt
      : undefined;
    receipt.healthyReceiptComplete = nested !== undefined
      && CHILD_RECEIPT_KEYS.every(key => nested[key] === true);
    if (!receipt.healthyReceiptComplete) note("nested receipt: " + JSON.stringify(nested ?? null));
    confirmOwnerUnchanged();

    receipt.missingTokenRefused = refusal(
      runChild(env => { delete env[TEST_RUN_LOCK_TOKEN_ENV]; }),
      "capability is incomplete",
      "a child holding no token",
    );
    confirmOwnerUnchanged();

    receipt.wrongTokenRefused = refusal(
      runChild(env => { env[TEST_RUN_LOCK_TOKEN_ENV] = randomUUID(); }),
      "exact live owner no longer matches",
      "a child holding a foreign token",
    );
    confirmOwnerUnchanged();

    receipt.wrongPathRefused = refusal(
      runChild(env => {
        env[TEST_RUN_LOCK_PATH_ENV] = win32.join(win32.dirname(lockPath), "opencodex-bun-test-not-this-host.lock");
      }),
      "refusing inherited lock access",
      "a child holding a foreign lock path",
    );
    confirmOwnerUnchanged();

    // The acquire path must wait out a live owner it does not own and then give up rather
    // than reclaim it. Planted under the temporary root so the probe can never reach the
    // real lock, and owned by this very pid so its liveness is a fact, not a fixture.
    const foreignLock = join(tempRoot, "foreign-owner.lock");
    mkdirSync(foreignLock, { recursive: true, mode: 0o700 });
    const foreignOwnerFile = join(foreignLock, "owner.json");
    const foreignOwner = JSON.stringify({
      version: 1,
      runId: "foreign-" + randomUUID(),
      token: randomUUID(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    }) + "\n";
    writeFileSync(foreignOwnerFile, foreignOwner, { encoding: "utf8", mode: 0o600 });
    try {
      await acquireTestRunLock({
        runId: "timeout-probe-" + randomUUID(),
        lockPath: foreignLock,
        env: process.env,
        pollMs: FOREIGN_POLL_MS,
        maxWaitMs: FOREIGN_MAX_WAIT_MS,
      });
      note("the controller took a lock a live foreign owner still held");
    } catch (error) {
      receipt.foreignOwnerTimedOut = describeError(error).includes("timed out after");
      if (!receipt.foreignOwnerTimedOut) note("unexpected foreign-owner failure: " + describeError(error));
    }
    receipt.foreignOwnerUntouched = existsSync(foreignOwnerFile)
      && readFileSync(foreignOwnerFile, "utf8") === foreignOwner;
    confirmOwnerUnchanged();
  } catch (error) {
    note("controller failure: " + describeError(error));
  } finally {
    receipt.childrenReaped = settledChildren.length > 0 && settledChildren.every(Boolean);
    try {
      if (lock?.acquired) {
        lock.release();
        receipt.releasedOnlyOwnLock = ownerFile !== undefined && !existsSync(ownerFile);
      } else if (lock && ownerFile !== undefined && ownerBefore !== undefined) {
        // Joined rather than acquired: leaving the other owner exactly as found IS the claim.
        receipt.releasedOnlyOwnLock = existsSync(ownerFile)
          && readFileSync(ownerFile, "utf8") === ownerBefore;
      }
    } catch (error) {
      note("release failure: " + describeError(error));
    }

    const token = ownerToken;
    const body = {
      [NESTED_LIVE_LOCK_RECEIPT_KEY]: receipt,
      diagnostics: token ? diagnostics.map(entry => entry.split(token).join("<redacted>")) : diagnostics,
    };
    receipt.receiptRedacted = token === undefined || !JSON.stringify(body).includes(token);
    process.stdout.write(JSON.stringify(body) + "\n");
    process.exitCode = diagnostics.length === 0 && Object.values(receipt).every(Boolean) ? 0 : 1;
  }
}

if (import.meta.main) await runNestedLiveLockController(process.argv[2]);
