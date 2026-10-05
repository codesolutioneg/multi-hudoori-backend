/**
 * Hudoori Multi only — never points at /root/hodouri single-company trees.
 * API: https://hr-api.hudoori.code-solution.org → 127.0.0.1:3003
 * Dashboard static: https://hr.hudoori.code-solution.org → 127.0.0.1:8083
 */
module.exports = {
  apps: [
    {
      name: 'hudoori-multi-backend',
      cwd: '/root/hudoori-multi/backend',
      script: '/usr/bin/bash',
      args: [
        '-lc',
        'set -a; source "/root/hudoori-multi/backend/.env"; set +a; exec node dist/server.js',
      ],
      interpreter: 'none',
      max_restarts: 20,
      min_uptime: '5s',
    },
    {
      name: 'hudoori-multi-dashboard',
      cwd: '/root/hudoori-multi/dashboard/build/web',
      script: '/usr/bin/bash',
      args: ['-lc', 'python3 -m http.server 8083 --bind 0.0.0.0'],
      interpreter: 'none',
      max_restarts: 20,
      min_uptime: '5s',
    },
  ],
};
