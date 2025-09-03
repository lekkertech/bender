module.exports = {
  apps: [
    {
      name: 'slack-bot-ts',
      script: 'scripts/run-prod.sh',
      interpreter: 'bash',
      cwd: __dirname,
      watch: false,
      autorestart: true,
      kill_timeout: 20000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

