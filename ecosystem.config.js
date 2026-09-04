// PM2: pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [{
    name: 'control-actas',
    script: 'server.js',
    cwd: __dirname,
    instances: 1,
    autorestart: true,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
      PORT: 3050,
      SESSION_SECRET: 'REEMPLAZAR-POR-EL-RESULTADO-DE-openssl-rand-hex-32'
    }
  }]
};
