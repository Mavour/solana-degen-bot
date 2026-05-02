// ecosystem.config.js - PM2 Configuration for Ubuntu VPS
module.exports = {
  apps: [
    {
      name: 'solana-degen-bot',
      script: 'dist/index.js',
      interpreter: 'node',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      restart_delay: 5000,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      // Log configuration
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      log_file: 'logs/pm2-combined.log',
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      // Kill timeout sebelum force kill
      kill_timeout: 10000,
      // Graceful shutdown
      listen_timeout: 10000,
      shutdown_with_message: true,
    },
  ],
};
