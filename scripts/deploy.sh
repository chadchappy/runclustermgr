#!/bin/bash

# Deployment script for Run:ai Application
set -e

# Configuration
NAMESPACE="default"
KUBECTL_CONTEXT=""  # Set this to use a specific kubectl context

echo "🚀 Deploying Run:ai Application to Kubernetes..."

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo "❌ kubectl is not installed or not in PATH"
    exit 1
fi

# Set kubectl context if specified
if [ -n "$KUBECTL_CONTEXT" ]; then
    echo "🔧 Using kubectl context: $KUBECTL_CONTEXT"
    kubectl config use-context "$KUBECTL_CONTEXT"
fi

# Show current context
echo "📍 Current kubectl context:"
kubectl config current-context

# Create namespace if it doesn't exist
echo "🏗️  Ensuring namespace exists..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Apply Kubernetes manifests
echo "📦 Applying ConfigMap and Secret..."
kubectl apply -f k8s/configmap.yaml -n "$NAMESPACE"

echo "🚀 Deploying application..."
kubectl apply -f k8s/deployment.yaml -n "$NAMESPACE"

echo "🌐 Creating services..."
kubectl apply -f k8s/service.yaml -n "$NAMESPACE"

# Wait for deployment to be ready
echo "⏳ Waiting for deployment to be ready..."
kubectl rollout status deployment/runai-app -n "$NAMESPACE" --timeout=300s

# Show deployment status
echo "📊 Deployment status:"
kubectl get pods -l app=runai-app -n "$NAMESPACE"
kubectl get services -l app=runai-app -n "$NAMESPACE"

echo ""
echo "✅ Deployment completed successfully!"
echo ""
echo "🎯 Access the application:"
echo "1. Port forward: kubectl port-forward service/runai-app 3000:3000 -n $NAMESPACE"
echo "2. Open browser: http://localhost:3000"
echo ""
echo "🔧 Useful commands:"
echo "• View logs: kubectl logs -l app=runai-app -n $NAMESPACE -f"
echo "• Get pods: kubectl get pods -l app=runai-app -n $NAMESPACE"
echo "• Describe pod: kubectl describe pod -l app=runai-app -n $NAMESPACE"
echo "• Update config: kubectl edit configmap runai-app-config -n $NAMESPACE"
