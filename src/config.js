const path = require('path');

const ROOT = path.resolve(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT || 3000),
  dataDir: path.join(ROOT, 'data'),
  dbPath: path.join(ROOT, 'data', 'app.db'),
  snapshotDir: path.join(ROOT, 'data', 'snapshots'),
  sessionSecret: process.env.SESSION_SECRET || 'file-proxy-dev-secret-change-me',
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',
  maxEditSize: 2 * 1024 * 1024,
  defaultExcludes: ['*.log', 'node_modules', '.git'],
  defaultProtects: ['web.config', 'Web.config'],
  defaultKeep: 10
};