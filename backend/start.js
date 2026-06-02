/**
 * Hivemind boot script.
 *
 * Order matters:
 *   1. Restore DB from backup (if enabled) — BEFORE db.js opens the SQLite file
 *   2. Load main server
 */
require('dotenv').config();

(async () => {
  const githubBackup = require('./githubBackup');
  await githubBackup.init();
  // Now safe to require the main server (which opens the DB)
  require('./server');
  // Start periodic backups after server is up
  githubBackup.startPeriodicBackup();
})();
