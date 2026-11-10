import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** One owned test directory; verify its absolute parent and name before recursive cleanup. */
export async function temporaryDirectory(t, prefix) {
  const parent = path.resolve(os.tmpdir()), root = await mkdtemp(path.join(parent, prefix));
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith(prefix));
    await rm(target, { recursive: true, force: true });
  });
  return root;
}
