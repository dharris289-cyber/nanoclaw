import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'container-idle-timeout',
  up(db: Database.Database) {
    // Idle-exit window in ms for the agent container. NULL (the default) or 0
    // disables idle exit — existing groups keep today's behavior, where an
    // idle container rides until host-sweep's absolute ceiling kills it.
    db.prepare('ALTER TABLE container_configs ADD COLUMN idle_timeout_ms INTEGER').run();
  },
};
