#!/bin/bash

# Test script to verify connection to Run:ai cluster using curl
# Usage: bash test-runai-curl.sh

CLUSTER_URL="https://runai.example.com"
CLIENT_ID="your-app-name"
CLIENT_SECRET="REDACTED"

echo "🚀 Testing Run:ai Cluster Connection with curl..."
echo "📍 Cluster URL: $CLUSTER_URL"
echo "🔑 Client ID: $CLIENT_ID"
echo ""

# Step 1: Test basic connectivity
echo "1️⃣ Testing basic connectivity..."
echo "   Checking if cluster is reachable..."

HEALTH_RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" -m 10 "$CLUSTER_URL/health" 2>/dev/null)
HTTP_STATUS=$(echo $HEALTH_RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
RESPONSE_BODY=$(echo $HEALTH_RESPONSE | sed -e 's/HTTPSTATUS:.*//g')

echo "   Status: $HTTP_STATUS"
if [ ! -z "$RESPONSE_BODY" ]; then
    echo "   Response: $RESPONSE_BODY"
fi
echo ""

# Step 2: Test authentication endpoints
echo "2️⃣ Testing authentication endpoints..."

AUTH_ENDPOINTS=(
    "/auth/realms/runai/protocol/openid-connect/token"
    "/oauth2/token"
    "/oauth/token" 
    "/auth/token"
    "/api/v1/oauth2/token"
    "/api/oauth2/token"
    "/api/v1/auth/token"
    "/v1/oauth2/token"
)

ACCESS_TOKEN=""
WORKING_AUTH_ENDPOINT=""

for endpoint in "${AUTH_ENDPOINTS[@]}"; do
    echo "   Trying: $CLUSTER_URL$endpoint"
    
    AUTH_RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" -m 10 \
        -X POST \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
        "$CLUSTER_URL$endpoint" 2>/dev/null)
    
    AUTH_HTTP_STATUS=$(echo $AUTH_RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    AUTH_RESPONSE_BODY=$(echo $AUTH_RESPONSE | sed -e 's/HTTPSTATUS:.*//g')
    
    echo "   Status: $AUTH_HTTP_STATUS"
    
    if [ "$AUTH_HTTP_STATUS" = "200" ]; then
        # Try to extract access token
        ACCESS_TOKEN=$(echo "$AUTH_RESPONSE_BODY" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
        
        if [ ! -z "$ACCESS_TOKEN" ]; then
            echo "   ✅ Found working auth endpoint: $endpoint"
            echo "   🎟️ Access token received: ${ACCESS_TOKEN:0:20}..."
            WORKING_AUTH_ENDPOINT="$endpoint"
            
            # Extract expires_in if available
            EXPIRES_IN=$(echo "$AUTH_RESPONSE_BODY" | grep -o '"expires_in":[0-9]*' | cut -d':' -f2)
            if [ ! -z "$EXPIRES_IN" ]; then
                echo "   ⏰ Token expires in: $EXPIRES_IN seconds"
            fi
            
            break
        fi
    else
        echo "   ❌ Auth failed: $AUTH_HTTP_STATUS"
        if [ ! -z "$AUTH_RESPONSE_BODY" ]; then
            echo "   Response: $AUTH_RESPONSE_BODY"
        fi
    fi
    echo ""
done

if [ -z "$ACCESS_TOKEN" ]; then
    echo "❌ No working authentication endpoint found!"
    echo ""
    echo "🔍 Debugging suggestions:"
    echo "1. Check if the cluster URL is correct"
    echo "2. Verify client credentials are valid"
    echo "3. Check if the cluster is accessible from your network"
    echo "4. Try accessing the cluster web UI manually: $CLUSTER_URL"
    exit 1
fi

# Step 3: Test API endpoints with authentication
echo ""
echo "3️⃣ Testing API endpoints with authentication..."

API_ENDPOINTS=(
    "/api/v1/clusters"
    "/api/clusters"
    "/clusters"
    "/api/v1/projects"
    "/api/projects"
    "/projects"
    "/api/v1/jobs"
    "/api/jobs"
    "/jobs"
    "/api/v1/workloads"
    "/api/workloads"
    "/workloads"
)

WORKING_API_ENDPOINTS=()

for api_endpoint in "${API_ENDPOINTS[@]}"; do
    echo "   Testing API: $CLUSTER_URL$api_endpoint"
    
    API_RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" -m 10 \
        -H "Authorization: Bearer $ACCESS_TOKEN" \
        -H "Accept: application/json" \
        "$CLUSTER_URL$api_endpoint" 2>/dev/null)
    
    API_HTTP_STATUS=$(echo $API_RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
    API_RESPONSE_BODY=$(echo $API_RESPONSE | sed -e 's/HTTPSTATUS:.*//g')
    
    echo "   Status: $API_HTTP_STATUS"
    
    if [ "$API_HTTP_STATUS" = "200" ]; then
        echo "   ✅ API endpoint working: $api_endpoint"
        echo "   Data preview: ${API_RESPONSE_BODY:0:200}..."
        WORKING_API_ENDPOINTS+=("$api_endpoint")
    else
        echo "   ❌ API endpoint failed: $API_HTTP_STATUS"
        if [ ! -z "$API_RESPONSE_BODY" ]; then
            echo "   Response: ${API_RESPONSE_BODY:0:200}..."
        fi
    fi
    echo ""
done

# Step 4: Test web UI accessibility
echo "4️⃣ Testing web UI accessibility..."
WEB_RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" -m 10 "$CLUSTER_URL" 2>/dev/null)
WEB_HTTP_STATUS=$(echo $WEB_RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')

echo "   Web UI Status: $WEB_HTTP_STATUS"
if [ "$WEB_HTTP_STATUS" = "200" ]; then
    echo "   ✅ Web UI is accessible"
else
    echo "   ❌ Web UI may not be accessible"
fi
echo ""

# Summary
echo "✅ Connection test completed!"
echo ""
echo "📋 Configuration Summary:"
echo "   Cluster URL: $CLUSTER_URL"
echo "   Auth Endpoint: $WORKING_AUTH_ENDPOINT"
echo "   Client ID: $CLIENT_ID"
echo "   Client Secret: [REDACTED]"
echo "   Working API Endpoints: ${#WORKING_API_ENDPOINTS[@]}"

if [ ${#WORKING_API_ENDPOINTS[@]} -gt 0 ]; then
    echo ""
    echo "🔗 Working API Endpoints:"
    for endpoint in "${WORKING_API_ENDPOINTS[@]}"; do
        echo "   - $endpoint"
    done
fi

echo ""
echo "🚀 Ready to start the React application!"
echo "   Run: npm start"
