#!/bin/bash

# Complete update and deployment script for Run:ai v2.23
set -e

echo "🚀 Updating Run:ai App for version 2.23 with new credentials..."
echo "📅 $(date)"
echo ""

# Configuration
NEW_SECRET="REDACTED"
NAMESPACE="default"

# Step 1: Test connection with new credentials
echo "1️⃣ Testing connection with new credentials..."
if [ -f "test-runai-curl.sh" ]; then
    chmod +x test-runai-curl.sh
    ./test-runai-curl.sh
else
    echo "⚠️ test-runai-curl.sh not found, skipping connection test"
fi
echo ""

# Step 2: Build updated React app
echo "2️⃣ Building updated React application..."
if command -v npm &> /dev/null; then
    npm install
    npm run build
    echo "✅ React app built successfully"
else
    echo "⚠️ npm not found, skipping React build"
fi
echo ""

# Step 3: Build Docker image
echo "3️⃣ Building Docker image..."
if command -v docker &> /dev/null; then
    chmod +x scripts/build.sh
    ./scripts/build.sh
    echo "✅ Docker image built successfully"
else
    echo "⚠️ Docker not found, skipping image build"
fi
echo ""

# Step 4: Update Kubernetes configuration
echo "4️⃣ Updating Kubernetes configuration..."
if command -v kubectl &> /dev/null; then
    # Apply updated ConfigMap and Secret
    kubectl apply -f k8s/configmap.yaml -n $NAMESPACE
    echo "✅ ConfigMap and Secret updated"
    
    # Deploy application
    chmod +x scripts/deploy.sh
    ./scripts/deploy.sh
    echo "✅ Application deployed"
    
    # Wait for rollout
    echo "⏳ Waiting for deployment to complete..."
    kubectl rollout status deployment/runai-app -n $NAMESPACE --timeout=300s
    
    # Show status
    echo "📊 Deployment Status:"
    kubectl get pods -l app=runai-app -n $NAMESPACE
    kubectl get services -l app=runai-app -n $NAMESPACE
    
else
    echo "❌ kubectl not found, cannot deploy to Kubernetes"
    exit 1
fi
echo ""

# Step 5: Verify deployment
echo "5️⃣ Verifying deployment..."
echo "🔍 Checking pod logs..."
kubectl logs -l app=runai-app -n $NAMESPACE --tail=20

echo ""
echo "✅ Update and deployment completed successfully!"
echo ""
echo "🎯 Next steps:"
echo "1. Port forward: kubectl port-forward service/runai-app 3000:3000 -n $NAMESPACE"
echo "2. Open browser: http://localhost:3000"
echo "3. Test the application with Run:ai v2.23"
echo ""
echo "🔧 Useful commands:"
echo "• View logs: kubectl logs -l app=runai-app -n $NAMESPACE -f"
echo "• Restart app: kubectl rollout restart deployment/runai-app -n $NAMESPACE"
echo "• Check config: kubectl describe configmap runai-app-config -n $NAMESPACE"
