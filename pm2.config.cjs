module.exports = {
  apps: [{
    name: 'diiisco-node',
    script: 'dist/index.js',

    // Process management
    instances: 1,              // Single instance (P2P node should not cluster)
    autorestart: true,         // Auto-restart on crash
    max_restarts: 10,          // Limit restart attempts
    restart_delay: 5000,       // Wait 5s between restarts

    // Graceful shutdown
    kill_timeout: 10000,       // 10s for graceful shutdown
    wait_ready: true,          // Wait for process.send('ready')
    listen_timeout: 30000,     // 30s startup timeout

    // Logging
    log_file: './logs/diiisco-combined.log',
    out_file: './logs/diiisco-out.log',
    error_file: './logs/diiisco-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,

    // Environment
    env: {
      NODE_ENV: 'production'
    }
  }]
};
