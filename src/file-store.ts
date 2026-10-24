import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { RevisionConflictError, SessionWeaveError, invariant } from './errors.js';
import { emptyState, json, mutate, safeId, validateState } from './protocol.js';
import type { Checkpoint, Message, Mutation, SessionState, SessionStore, UsageObservation } from './types.js';

type Manifest = { version: 1; sessionId: string; revision: number; messages: string[]; checkpoints: string[]; usage: UsageObservation[] };
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/** Local-filesystem store. Immutable raw/summary files become visible through one atomic manifest. */
export class FileStore implements SessionStore {
  private readonly root: string;
  constructor(root: string) { this.root = path.resolve(root); }
  private directory(id: string): string {
    emptyState(id);
    return path.join(this.root, createHash('sha256').update(id).digest('hex'));
  }
  async load(id: string): Promise<SessionState | null> {
    const directory = this.directory(id);
    let manifest: Manifest;
    try { manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')); }
    catch (error) { if (missing(error)) return null; throw error; }
    invariant(manifest.version === 1 && manifest.sessionId === id && Array.isArray(manifest.messages) && Array.isArray(manifest.checkpoints), 'Invalid session manifest.');
    const read = async <T>(kind: string, item: string): Promise<T> => {
      safeId(item);
      return JSON.parse(await readFile(path.join(directory, kind, `${item}.json`), 'utf8')) as T;
    };
    const state: SessionState = {
      version: 1, sessionId: id, revision: manifest.revision,
      messages: await Promise.all(manifest.messages.map((item) => read<Message>('raw', item))),
      checkpoints: await Promise.all(manifest.checkpoints.map((item) => read<Checkpoint>('checkpoints', item))),
      usage: manifest.usage,
    };
    validateState(state);
    return state;
  }
  private async write(file: string, contents: string): Promise<void> {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
  }
  async commit(id: string, revision: number, mutation: Mutation, signal?: AbortSignal): Promise<SessionState> {
    const directory = this.directory(id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lock = path.join(directory, 'write.lock');
    try { await mkdir(lock); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new SessionWeaveError('STORE_BUSY', 'Session has another writer or an interrupted write lock; retry after the owner exits.');
      throw error;
    }
    const temporary = path.join(directory, `manifest-${randomUUID()}.tmp`);
    try {
      const state = await this.load(id) ?? emptyState(id);
      if (state.revision !== revision) throw new RevisionConflictError();
      const next = mutate(state, mutation);
      const persist = async (kind: string, item: { id: string }): Promise<void> => {
        const folder = path.join(directory, kind);
        await mkdir(folder, { recursive: true, mode: 0o700 });
        const file = path.join(folder, `${item.id}.json`), contents = json(item);
        try { await this.write(file, contents); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(file, 'utf8') !== contents) throw error;
        }
      };
      for (const message of mutation.messages ?? []) await persist('raw', message);
      if (mutation.checkpoint) await persist('checkpoints', mutation.checkpoint);
      const manifest: Manifest = {
        version: 1, sessionId: id, revision: next.revision,
        messages: next.messages.map((message) => message.id),
        checkpoints: next.checkpoints.map((checkpoint) => checkpoint.id), usage: next.usage,
      };
      await this.write(temporary, json(manifest));
      signal?.throwIfAborted();
      await rename(temporary, path.join(directory, 'manifest.json'));
      return next;
    } finally {
      // Cleanup cannot turn an already-published transaction into an apparent failed commit.
      await rm(temporary, { force: true }).catch(() => undefined);
      // The path is the exact lock directory created above, and is never removed recursively.
      await rmdir(lock).catch(() => undefined);
    }
  }
}
