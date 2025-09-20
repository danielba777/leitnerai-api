#!/bin/bash
set -euxo pipefail
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

AWS_REGION="eu-north-1"
INBOX_BUCKET="leitnerai-inbox-7634-8705-3303"
RESULTS_BUCKET="leitnerai-results-7634-8705-3303"
TABLE_NAME="leitnerai-jobs"
SQS_QUEUE_URL="https://sqs.eu-north-1.amazonaws.com/763487053303/leitnerai-jobs-queue"
QUEUE_URL="$SQS_QUEUE_URL"
DEEPSEEK_API_URL="https://api.deepseek.com/v1/chat/completions"
REWRITE_PROVIDER="deepseek"

{
  echo "AWS_REGION=${AWS_REGION}"
  echo "INBOX_BUCKET=${INBOX_BUCKET}"
  echo "RESULTS_BUCKET=${RESULTS_BUCKET}"
  echo "TABLE_NAME=${TABLE_NAME}"
  echo "SQS_QUEUE_URL=${SQS_QUEUE_URL}"
  echo "QUEUE_URL=${QUEUE_URL}"
  echo "DEEPSEEK_API_URL=${DEEPSEEK_API_URL}"
  echo "REWRITE_PROVIDER=${REWRITE_PROVIDER}"
} | tee -a /etc/environment

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

DEEPSEEK_API_KEY="$(aws ssm get-parameter \
  --name "/leitnerai/deepseek_api_key" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region "${AWS_REGION}")"
  
sudo -u ubuntu env \
  AWS_REGION="${AWS_REGION}" \
  INBOX_BUCKET="${INBOX_BUCKET}" \
  RESULTS_BUCKET="${RESULTS_BUCKET}" \
  TABLE_NAME="${TABLE_NAME}" \
  SQS_QUEUE_URL="${SQS_QUEUE_URL}" \
  QUEUE_URL="${QUEUE_URL}" \
  DEEPSEEK_API_URL="${DEEPSEEK_API_URL}" \
  REWRITE_PROVIDER="${REWRITE_PROVIDER}" \
  DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY}" \
  pm2 start "$APP_DIR/ecosystem.config.js" --update-env

sudo -u ubuntu pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
systemctl enable pm2-ubuntu
systemctl restart pm2-ubuntu || true

sleep 2
curl -fsS http://127.0.0.1:3000/health || true