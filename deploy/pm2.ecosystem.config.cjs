module.exports = {
  apps: [
    {
      name: 'biotime-backend-prod',
      cwd: '/root/hodouri/bio_time_backend',
      script: '/usr/bin/bash',
      args: [
        '-lc',
        'set -a; source "/root/hodouri/bio_time_backend/.env.prod"; set +a; exec node dist/server.js',
      ],
      interpreter: 'none',
    },
    {
      name: 'biotime-backend-dev',
      cwd: '/root/hodouri/bio_time_backend-dev',
      script: '/usr/bin/bash',
      args: [
        '-lc',
        'set -a; source "/root/hodouri/bio_time_backend-dev/.env.dev"; set +a; exec node dist/server.js',
      ],
      interpreter: 'none',
    },
    {
      name: 'hudoori-dashboard-prod',
      cwd: '/root/hodouri/biotime_web_dashboard/build/web',
      script: '/usr/bin/bash',
      args: ['-lc', 'python3 -m http.server 8080 --bind 0.0.0.0'],
      interpreter: 'none',
    },
    {
      name: 'hudoori-dashboard-dev',
      cwd: '/root/hodouri/biotime_web_dashboard-dev/build/web',
      script: '/usr/bin/bash',
      args: ['-lc', 'python3 -m http.server 8081 --bind 0.0.0.0'],
      interpreter: 'none',
    },
  ],
};
