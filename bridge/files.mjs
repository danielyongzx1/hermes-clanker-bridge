import { constants, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, realpath, lstat, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_FILE_BYTES, assertId } from './protocol.mjs';

const inside = (root, candidate) => { const rel = path.relative(root, candidate); return !rel.startsWith('..') && !path.isAbsolute(rel); };
export class WorkspaceFiles {
  constructor(root, objects) { this.root = path.resolve(root); this.objects = path.resolve(objects); }
  async init() {
    await mkdir(this.root, { recursive: true }); await mkdir(this.objects, { recursive: true });
    if ((await lstat(this.root)).isSymbolicLink() || (await lstat(this.objects)).isSymbolicLink()) throw new Error('Workspace and object roots must not be symlinks.');
    this.root = await realpath(this.root); this.objects = await realpath(this.objects);
  }
  async directory(sessionId) {
    const dir = path.join(this.root, assertId(sessionId));
    await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink() || !inside(this.root, await realpath(dir))) throw new Error('Unsafe workspace directory.');
    return dir;
  }
  async safeFile(sessionId, relative) {
    const dir = await this.directory(sessionId);
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Unsafe file path.');
    const file = path.resolve(dir, relative);
    if (!inside(dir, file)) throw new Error('File escapes workspace.');
    let current = dir;
    for (const component of relative.split('/')) {
      current = path.join(current, component);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Symlink file transfer is not allowed.');
    }
    if (!inside(dir, await realpath(file))) throw new Error('File escapes workspace.');
    return file;
  }
  async object(version) {
    if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('Invalid file version.');
    const file = path.join(this.objects, version);
    if ((await lstat(file)).isSymbolicLink() || !inside(this.objects, await realpath(file))) throw new Error('Unsafe stored file.');
    return file;
  }
  async snapshot(sessionId, relative, id) {
    const file = await this.safeFile(sessionId, relative);
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
    const temp = path.join(this.objects, `.part-${randomUUID()}`);
    const hash = createHash('sha256'); let size = 0;
    try {
      await pipeline(createReadStream(file, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) }), new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) return callback(new Error('File exceeds 20 MB.'));
          hash.update(chunk); callback(null, chunk);
        },
      }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const version = hash.digest('hex');
      const target = path.join(this.objects, version);
      try { await lstat(target); await rm(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; await rename(temp, target); }
      return { id: id ?? createHash('sha256').update(relative).digest('hex'), name: path.basename(relative), path: relative, size, version };
    } finally { await rm(temp, { force: true }); }
  }
  async upload(sessionId, uploadId, name, source) {
    assertId(uploadId);
    const safeName = String(name ?? 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-140) || 'file';
    const relative = `${uploadId}_${safeName}`;
    const dir = await this.directory(sessionId);
    const temp = path.join(this.objects, `.part-${randomUUID()}`);
    let size = 0;
    try {
      await pipeline(source, new Transform({ transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > MAX_FILE_BYTES ? Object.assign(new Error('File exceeds 20 MB.'), { status: 413 }) : null, chunk);
      } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      await this.directory(sessionId);
      const target = path.join(dir, relative);
      try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Unsafe upload destination.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(temp, target);
      return await this.snapshot(sessionId, relative, uploadId);
    } finally { await rm(temp, { force: true }); }
  }
  async list(sessionId) {
    const dir = await this.directory(sessionId); const files = [];
    const visit = async (relative = '') => {
      const entries = await readdir(path.join(dir, relative), { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= 1000) throw new Error('Workspace has more than 1000 transferable files.');
        if (entry.isSymbolicLink() || entry.name === '.git') continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { await this.safeFile(sessionId, rel); await visit(rel); }
        else if (entry.isFile()) { const file = await this.snapshot(sessionId, rel); if (file) files.push(file); }
      }
    };
    await visit(); return files;
  }
}
