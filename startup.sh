#!/bin/sh
set -e

echo "🚀 Starting Run:ai Application Container..."

# Set default values if not provided
export RUNAI_CONTROL_PLANE=${RUNAI_CONTROL_PLANE:-"runai.example.com"}
export RUNAI_APP_NAME=${RUNAI_APP_NAME:-"your-app-name"}
export RUNAI_APP_SECRET=${RUNAI_APP_SECRET:-"REDACTED"}

echo "📡 Control Plane: ${RUNAI_CONTROL_PLANE}"
echo "🔑 App Name: ${RUNAI_APP_NAME}"
echo "🔐 App Secret: [REDACTED]"

# Check if we're running as root and need to configure nginx
if [ "$(id -u)" = "0" ]; then
    echo "🔧 Configuring nginx with environment variables (as root)..."
    envsubst '${RUNAI_CONTROL_PLANE}' < /etc/nginx/nginx.conf.template > /etc/nginx/nginx.conf

    # Create runtime configuration for React app
    echo "⚛️  Creating runtime configuration for React app..."
    cat > /usr/share/nginx/html/config.js << EOF
window.RUNAI_CONFIG = {
  CONTROL_PLANE: "${RUNAI_CONTROL_PLANE}",
  APP_NAME: "${RUNAI_APP_NAME}",
  APP_SECRET: "${RUNAI_APP_SECRET}"
};
EOF

    # Update index.html to include the config script
    echo "📝 Updating index.html to include runtime configuration..."
    sed -i 's|</head>|  <script src="/config.js"></script>\n  </head>|' /usr/share/nginx/html/index.html

    echo "✅ Configuration complete!"
    echo "🌐 Application will be available on port 3000"

    # Execute the main command
    exec "$@"
else
    echo "⚠️  Running as non-root user, skipping configuration..."
    # Execute the main command
    exec "$@"
fi


