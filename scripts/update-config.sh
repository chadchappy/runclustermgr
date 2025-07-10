#!/bin/bash

# Configuration update script for Run:ai Application
set -e

# Configuration
NAMESPACE="default"

echo "🔧 Run:ai Application Configuration Updater"
echo ""

# Function to update configuration
update_config() {
    local control_plane="$1"
    local app_name="$2"
    local app_secret="$3"
    
    if [ -z "$control_plane" ] || [ -z "$app_name" ] || [ -z "$app_secret" ]; then
        echo "❌ Missing required parameters"
        echo "Usage: $0 <control_plane> <app_name> <app_secret>"
        echo "Example: $0 runai.example.com your-app-name REDACTED"
        exit 1
    fi
    
    echo "📝 Updating configuration..."
    echo "🌐 Control Plane: $control_plane"
    echo "🔑 App Name: $app_name"
    echo "🔐 App Secret: [REDACTED]"
    
    # Update ConfigMap
    kubectl patch configmap runai-app-config -n "$NAMESPACE" --patch "
    data:
      RUNAI_CONTROL_PLANE: \"$control_plane\"
      RUNAI_APP_NAME: \"$app_name\"
    "
    
    # Update Secret (base64 encode the secret)
    local encoded_secret=$(echo -n "$app_secret" | base64)
    kubectl patch secret runai-app-secret -n "$NAMESPACE" --patch "
    data:
      RUNAI_APP_SECRET: \"$encoded_secret\"
    "
    
    echo "✅ Configuration updated successfully!"
    
    # Restart deployment to pick up new config
    echo "🔄 Restarting deployment to apply new configuration..."
    kubectl rollout restart deployment/runai-app -n "$NAMESPACE"
    
    # Wait for rollout to complete
    echo "⏳ Waiting for rollout to complete..."
    kubectl rollout status deployment/runai-app -n "$NAMESPACE" --timeout=300s
    
    echo "✅ Application restarted with new configuration!"
}

# Function to show current configuration
show_config() {
    echo "📋 Current Configuration:"
    echo ""
    echo "ConfigMap:"
    kubectl get configmap runai-app-config -n "$NAMESPACE" -o yaml | grep -A 10 "data:"
    echo ""
    echo "Secret (base64 encoded):"
    kubectl get secret runai-app-secret -n "$NAMESPACE" -o yaml | grep -A 5 "data:"
}

# Main script logic
case "$1" in
    "show")
        show_config
        ;;
    "update")
        update_config "$2" "$3" "$4"
        ;;
    *)
        echo "Usage: $0 {show|update} [control_plane] [app_name] [app_secret]"
        echo ""
        echo "Commands:"
        echo "  show                           - Show current configuration"
        echo "  update <cp> <name> <secret>    - Update configuration"
        echo ""
        echo "Examples:"
        echo "  $0 show"
        echo "  $0 update runai.example.com your-app-name REDACTED"
        exit 1
        ;;
esac
