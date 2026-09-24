module.exports = {
  apps: [{
    name: 'file-proxy',
    script: 'src/server.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      PORT: 9006,
      SESSION_SECRET: 'change-this-in-production',
      ADMIN_USER: 'admin',
      ADMIN_PASS: 'admin123'
    }
  }]
};