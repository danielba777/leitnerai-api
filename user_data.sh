#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/user-data.log|logger -t user-data -s 2>/dev/console) 2>&1

echo "AWS_REGION=eu-north-1"                             | tee -a /etc/environment
echo "INBOX_BUCKET=leitnerai-inbox-7634-8705-3303"       | tee -a /etc/environment
echo "RESULTS_BUCKET=leitnerai-results-7634-8705-3303"  | tee -a /etc/environment
echo "QUEUE_URL=https://sqs.eu-north-1.amazonaws.com/763487053303/leitnerai-jobs" | tee -a /etc/environment
echo "TABLE_NAME=leitnerai-jobs"                         | tee -a /etc/environment

curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt-get update -y
apt-get install -y git nodejs
npm i -g pm2

APP_DIR=/home/ubuntu/nestjs-api
if [ ! -d "$APP_DIR" ]; then
  git clone --depth=1 https://github.com/danielba777/leitnerai-api.git "$APP_DIR"
fi
cd "$APP_DIR"
npm ci
npm run build
npm prune --production

cat > ecosystem.config.js <<'EOF'
module.exports = {
  apps: [{
    name: "leitnerai-api",
    script: "./dist/main.js",
    instances: 1,
    autorestart: true,
    max_memory_restart: "350M",
    env: { NODE_ENV: "production" }
  }]
}
EOF

chown -R ubuntu:ubuntu "$APP_DIR"
sudo -u ubuntu pm2 start ecosystem.config.js
sudo -u ubuntu pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
systemctl enable pm2-ubuntu