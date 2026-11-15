import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Clip state in one JSON file (data/state.json). Small: one record per Drive file the swiper has seen.
 * Writes are synchronous and atomic (tmp + rename) so a crash never leaves half a file.
 *
 * clip = {
 *   id (Drive file id), name, streamer, streamerFolderId, size, mimeType, createdTime, durationMs, width, height,
 *   webViewLink, folderLink,
 *   status: new | maybe | queued | processing | done | trashed | error | gone,
 *   crmTicketId, crmSynced (false = CRM update pending),
 *   localclipTaskId, outputs: [{clipId, driveId, name, webViewLink, hookTitle}],
 *   progress, error, history: [{at, text, by}], firstSeenAt, decidedAt
 * }
 */
export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    this.clips = new Map();
    this.lastSyncAt = null;
    this.lastSyncError = null;
    if (existsSync(this.file)) {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const clip of data.clips || []) this.clips.set(clip.id, clip);
      this.lastSyncAt = data.lastSyncAt || null;
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify({ lastSyncAt: this.lastSyncAt, clips: [...this.clips.values()] }, null, 1),
    );
    renameSync(tmp, this.file);
  }

  get(id) {
    return this.clips.get(id);
  }

  all() {
    return [...this.clips.values()];
  }

  put(clip) {
    this.clips.set(clip.id, clip);
    this.save();
    return clip;
  }

  update(id, patch, historyText, by) {
    const clip = this.clips.get(id);
    if (!clip) return null;
    Object.assign(clip, patch);
    if (historyText) {
      clip.history = [...(clip.history || []), { at: new Date().toISOString(), text: historyText, by: by || null }];
    }
    this.save();
    return clip;
  }
}
