// FAZ 6: pm2 ecosystem configuration

module.exports = {
    apps: [
        {
            name: 'trading-api',
            script: 'npx',
            args: 'tsx src/server.ts',
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production',
                PORT: 3000,
            },
            error_file: './logs/api-error.log',
            out_file: './logs/api-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
        },
        {
            name: 'trading-worker',
            script: 'npx',
            args: 'tsx src/worker.ts',
            cwd: __dirname,
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '300M',
            env: {
                NODE_ENV: 'production',
            },
            error_file: './logs/worker-error.log',
            out_file: './logs/worker-out.log',
            log_date_format: 'YYYY-MM-DD HH:mm:ss',
            merge_logs: true,
        },
    ],
};
