#!/bin/bash
apt-get -y update
apt-get -y install git
cat > /tmp/subscript.sh << EOF
echo "Setting up NodeJS Environment"
export NODE_ENV=production
export PATH="\$PATH:/home/ubuntu/.nvm/versions/node/v18.13.0/bin"
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
export NVM_DIR="/home/ubuntu/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && . "\$NVM_DIR/nvm.sh"
nvm install 18.13.0
nvm alias default 18.13.0
npm install -g npm@9.3.0
npm install -g pm2
npm install -g @nestjs/cli@9.1.4
npm cache clean --force
git clone https://github.com/danielba777/leitnerai-api.git /home/ubuntu/nestjs-api
cd /home/ubuntu/nestjs-api
npm install
npm run build
chown -R ubuntu:ubuntu /home/ubuntu/nestjs-api/dist
chmod -R 755 /home/ubuntu/nestjs-api/dist
pm2 start ./dist/main.js
pm2 save
EOF
chown ubuntu:ubuntu /tmp/subscript.sh && chmod a+x /tmp/subscript.sh
su - ubuntu -c "/tmp/subscript.sh"