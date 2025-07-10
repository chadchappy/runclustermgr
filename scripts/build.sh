#!/bin/bash

# Build script for Run:ai Application Container
set -e

# Configuration
IMAGE_NAME="runai-app"
IMAGE_TAG="latest"
REGISTRY=""  # Set this to your container registry (e.g., "your-registry.com/")

echo "🏗️  Building Run:ai Application Container..."
echo "📦 Image: ${REGISTRY}${IMAGE_NAME}:${IMAGE_TAG}"

# Build the Docker image
echo "🔨 Building Docker image..."
docker build -t "${REGISTRY}${IMAGE_NAME}:${IMAGE_TAG}" .

# Tag with additional tags if needed
docker tag "${REGISTRY}${IMAGE_NAME}:${IMAGE_TAG}" "${REGISTRY}${IMAGE_NAME}:$(date +%Y%m%d-%H%M%S)"

echo "✅ Build completed successfully!"
echo "📋 Available images:"
docker images | grep "${IMAGE_NAME}"

# Optional: Push to registry
if [ "$1" = "--push" ]; then
    if [ -z "$REGISTRY" ]; then
        echo "❌ Registry not configured. Set REGISTRY variable to push images."
        exit 1
    fi
    
    echo "🚀 Pushing image to registry..."
    docker push "${REGISTRY}${IMAGE_NAME}:${IMAGE_TAG}"
    docker push "${REGISTRY}${IMAGE_NAME}:$(date +%Y%m%d-%H%M%S)"
    echo "✅ Push completed successfully!"
fi

echo ""
echo "🎯 Next steps:"
echo "1. Deploy to Kubernetes: ./scripts/deploy.sh"
echo "2. Access the application: kubectl port-forward service/runai-app 3000:3000"
echo "3. Open browser: http://localhost:3000"
