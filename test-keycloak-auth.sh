#!/bin/bash

CLUSTER_URL="https://runai.example.com"
CLIENT_ID="your-app-name"
CLIENT_SECRET="REDACTED"

echo "🔐 Testing Run:ai v2.23 Keycloak Authentication..."

# Test the specific Keycloak endpoint
AUTH_ENDPOINT="/auth/realms/runai/protocol/openid-connect/token"
echo "Testing: $CLUSTER_URL$AUTH_ENDPOINT"

AUTH_RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" -m 10 \
    -X POST \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials&client_id=$CLIENT_ID&client_secret=$CLIENT_SECRET" \
    "$CLUSTER_URL$AUTH_ENDPOINT" 2>/dev/null)

AUTH_HTTP_STATUS=$(echo $AUTH_RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
AUTH_RESPONSE_BODY=$(echo $AUTH_RESPONSE | sed -e 's/HTTPSTATUS:.*//g')

echo "Status: $AUTH_HTTP_STATUS"
echo "Response: $AUTH_RESPONSE_BODY"

if [ "$AUTH_HTTP_STATUS" = "200" ]; then
    ACCESS_TOKEN=$(echo "$AUTH_RESPONSE_BODY" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
    if [ ! -z "$ACCESS_TOKEN" ]; then
        echo "✅ Authentication successful!"
        echo "🎟️ Access token: ${ACCESS_TOKEN:0:20}..."
        
        # Test API call
        echo "🧪 Testing API call..."
        API_RESPONSE=$(curl -s -w "HTTPSTATUS:%{http_code}" -m 10 \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "Accept: application/json" \
            "$CLUSTER_URL/api/v1/clusters" 2>/dev/null)
        
        API_HTTP_STATUS=$(echo $API_RESPONSE | tr -d '\n' | sed -e 's/.*HTTPSTATUS://')
        echo "API Status: $API_HTTP_STATUS"
        
        if [ "$API_HTTP_STATUS" = "200" ]; then
            echo "✅ API call successful!"
        fi
    fi
else
    echo "❌ Authentication failed"
fi
