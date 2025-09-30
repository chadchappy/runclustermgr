#!/bin/sh

# Docker entrypoint script for Run:ai application
# Handles environment variable substitution in nginx config and React app

set -e

echo "🚀 Starting Run:ai Application Container..."

# Set default values if not provided
export RUNAI_CONTROL_PLANE=${RUNAI_CONTROL_PLANE:-"runai.example.com"}
export RUNAI_APP_NAME=${RUNAI_APP_NAME:-"your-app-name"}
export RUNAI_APP_SECRET=${RUNAI_APP_SECRET:-"REDACTED"}

echo "📡 Control Plane: ${RUNAI_CONTROL_PLANE}"
echo "🔑 App Name: ${RUNAI_APP_NAME}"
echo "🔐 App Secret: [REDACTED]"
echo "🔧 Configuring nginx with environment variables..."
echo "📡 Control Plane: ${RUNAI_CONTROL_PLANE}"
echo "🔑 App Name: ${RUNAI_APP_NAME}"

# Substitute environment variables in nginx config
envsubst '${RUNAI_CONTROL_PLANE}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

# Verify the substitution worked
echo "🔍 Nginx config after substitution:"
grep -A 5 -B 5 "proxy_pass" /etc/nginx/nginx.conf || echo "No proxy_pass found in config"
# Create runtime configuration for React app
echo "⚛️  Creating runtime configuration for React app..."
cat > /usr/share/nginx/html/config.js << EOF
window.RUNAI_CONFIG = {
  CONTROL_PLANE: "${RUNAI_CONTROL_PLANE}",
  APP_NAME: "${RUNAI_APP_NAME}",
  APP_SECRET: "${RUNAI_APP_SECRET}",
  API_BASE_URL: "https://${RUNAI_CONTROL_PLANE}",
  AUTH_URL: "https://${RUNAI_CONTROL_PLANE}/auth/realms/runai/protocol/openid-connect/token"
};
EOF

# Update index.html to include the config script
echo "📝 Updating index.html to include runtime configuration..."
sed -i 's|</head>|  <script src="/config.js"></script>\n  </head>|' /usr/share/nginx/html/index.html

echo "✅ Configuration complete!"
echo "🌐 Application will be available on port 3000"
echo "🔗 Use 'kubectl port-forward' to access: kubectl port-forward service/runai-app 3000:3000"

# Execute the main command
exec "$@"
