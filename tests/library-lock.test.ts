import assert from "node:assert/strict";
import { test } from "node:test";
import { withLibraryLock } from "../src/server/library-lock.js";

test("library lock runs tasks one at a time in call order", async () => {
  const events: string[] = [];
  let running = 0;
  const task = (name: string, delayMs: number) => withLibraryLock(async () => {
    running += 1;
    assert.equal(running, 1, "tasks must never overlap");
    events.push(`${name}:start`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    events.push(`${name}:end`);
    running -= 1;
    return name;
  });

  const results = await Promise.all([task("a", 20), task("b", 0), task("c", 5)]);

  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("a failing task does not block later tasks", async () => {
  await assert.rejects(withLibraryLock(async () => {
    throw new Error("boom");
  }), /boom/);

  assert.equal(await withLibraryLock(async () => "after"), "after");
});
