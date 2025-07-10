#!/bin/bash

# Run:ai API credentials
APP_NAME="your-app-name"
APP_SECRET="REDACTED"
CONTROL_PLANE_URL="https://runai.example.com"
WORKLOAD_ID="e05068ab-650e-4e7e-a3a1-bec2f36dcfee"

echo "🔐 Authenticating with Run:ai..."

# Get authentication token
TOKEN_RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials&client_id=${APP_NAME}&client_secret=${APP_SECRET}" \
  "${CONTROL_PLANE_URL}/auth/realms/runai/protocol/openid-connect/token")

# Extract access token
ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | jq -r '.access_token')

if [ "$ACCESS_TOKEN" = "null" ] || [ -z "$ACCESS_TOKEN" ]; then
    echo "❌ Failed to get access token"
    echo "Response: $TOKEN_RESPONSE"
    exit 1
fi

echo "✅ Authentication successful"

# First, list all distributed workloads to see what's available
echo "📋 Listing all distributed workloads:"
ALL_WORKLOADS=$(curl -s -X GET \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "${CONTROL_PLANE_URL}/api/v1/workloads/distributed")

echo "$ALL_WORKLOADS" | jq '.workloads[] | {id: .id, name: .name, status: .status}'

echo ""
echo "🔍 Fetching specific distributed workload: $WORKLOAD_ID"

# Get workload information
WORKLOAD_RESPONSE=$(curl -s -X GET \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  "${CONTROL_PLANE_URL}/api/v1/workloads/distributed/${WORKLOAD_ID}")

echo "📋 Workload Information:"
echo "$WORKLOAD_RESPONSE" | jq '.'

# Extract and highlight GPU configuration if present
echo ""
echo "🎯 GPU Configuration:"
echo "$WORKLOAD_RESPONSE" | jq '.spec.compute // "No compute section found"'

# Look for gpuRequestType specifically
GPU_REQUEST_TYPE=$(echo "$WORKLOAD_RESPONSE" | jq -r '.spec.compute.gpuRequestType // "not found"')
GPU_DEVICES_REQUEST=$(echo "$WORKLOAD_RESPONSE" | jq -r '.spec.compute.gpuDevicesRequest // "not found"')
GPU_PORTION_REQUEST=$(echo "$WORKLOAD_RESPONSE" | jq -r '.spec.compute.gpuPortionRequest // "not found"')

echo ""
echo "🔧 Key GPU Fields:"
echo "  gpuRequestType: $GPU_REQUEST_TYPE"
echo "  gpuDevicesRequest: $GPU_DEVICES_REQUEST"
echo "  gpuPortionRequest: $GPU_PORTION_REQUEST"
