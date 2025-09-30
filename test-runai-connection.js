#!/usr/bin/env node

/**
 * Test script to verify connection to Run:ai cluster
 * Usage: node test-runai-connection.js
 */

const axios = require('axios');

// Run:ai cluster configuration
const RUNAI_CONFIG = {
  clusterUrl: 'https://runai.example.com',
  clientId: 'your-app-name',
  clientSecret: 'REDACTED',
  appName: 'your-app-name',
};

async function testRunaiConnection() {
  console.log('🚀 Testing Run:ai Cluster Connection...');
  console.log(`📍 Cluster URL: ${RUNAI_CONFIG.clusterUrl}`);
  console.log(`🔑 Client ID: ${RUNAI_CONFIG.clientId}`);
  console.log('');

  try {
    // Step 1: Test basic connectivity
    console.log('1️⃣ Testing basic connectivity...');
    const healthResponse = await axios.get(`${RUNAI_CONFIG.clusterUrl}/health`, {
      timeout: 10000,
      validateStatus: () => true, // Accept any status code
    });
    
    console.log(`   Status: ${healthResponse.status}`);
    console.log(`   Response: ${JSON.stringify(healthResponse.data, null, 2)}`);
    console.log('');

    // Step 2: Test authentication endpoint discovery
    console.log('2️⃣ Testing authentication endpoint discovery...');
    
    // Try common OAuth2 endpoints
    const authEndpoints = [
      '/auth/realms/runai/protocol/openid-connect/token',
      '/oauth2/token',
      '/oauth/token',
      '/auth/token',
      '/api/v1/oauth2/token',
      '/api/oauth2/token',
    ];

    let authEndpoint = null;
    for (const endpoint of authEndpoints) {
      try {
        const testUrl = `${RUNAI_CONFIG.clusterUrl}${endpoint}`;
        console.log(`   Trying: ${testUrl}`);
        
        const response = await axios.post(testUrl, {
          grant_type: 'client_credentials',
          client_id: RUNAI_CONFIG.clientId,
          client_secret: RUNAI_CONFIG.clientSecret,
        }, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          transformRequest: [(data) => {
            return Object.keys(data)
              .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
              .join('&');
          }],
          timeout: 10000,
          validateStatus: (status) => status < 500, // Accept 4xx but not 5xx
        });

        if (response.status === 200 && response.data.access_token) {
          authEndpoint = endpoint;
          console.log(`   ✅ Found working auth endpoint: ${endpoint}`);
          console.log(`   🎟️ Access token received: ${response.data.access_token.substring(0, 20)}...`);
          
          if (response.data.expires_in) {
            console.log(`   ⏰ Token expires in: ${response.data.expires_in} seconds`);
          }
          
          // Step 3: Test API calls with token
          console.log('');
          console.log('3️⃣ Testing API calls with authentication...');
          
          const apiEndpoints = [
            '/api/v1/clusters',
            '/api/clusters',
            '/clusters',
            '/api/v1/projects',
            '/api/projects',
            '/projects',
          ];

          for (const apiEndpoint of apiEndpoints) {
            try {
              const apiUrl = `${RUNAI_CONFIG.clusterUrl}${apiEndpoint}`;
              console.log(`   Testing API: ${apiUrl}`);
              
              const apiResponse = await axios.get(apiUrl, {
                headers: {
                  'Authorization': `Bearer ${response.data.access_token}`,
                  'Accept': 'application/json',
                },
                timeout: 10000,
                validateStatus: () => true,
              });

              console.log(`   Status: ${apiResponse.status}`);
              if (apiResponse.status === 200) {
                console.log(`   ✅ API endpoint working: ${apiEndpoint}`);
                console.log(`   Data preview: ${JSON.stringify(apiResponse.data, null, 2).substring(0, 200)}...`);
              } else {
                console.log(`   ❌ API endpoint failed: ${apiResponse.status} - ${apiResponse.statusText}`);
              }
            } catch (apiError) {
              console.log(`   ❌ API call failed: ${apiError.message}`);
            }
          }
          
          break;
        } else {
          console.log(`   ❌ Auth failed: ${response.status} - ${response.statusText}`);
          if (response.data) {
            console.log(`   Response: ${JSON.stringify(response.data, null, 2)}`);
          }
        }
      } catch (error) {
        console.log(`   ❌ Endpoint failed: ${error.message}`);
      }
    }

    if (!authEndpoint) {
      console.log('');
      console.log('❌ No working authentication endpoint found!');
      console.log('');
      console.log('🔍 Debugging suggestions:');
      console.log('1. Check if the cluster URL is correct');
      console.log('2. Verify client credentials are valid');
      console.log('3. Check if the cluster is accessible from your network');
      console.log('4. Try accessing the cluster web UI manually');
      return;
    }

    console.log('');
    console.log('✅ Connection test completed successfully!');
    console.log('');
    console.log('📋 Configuration for your app:');
    console.log(`   Cluster URL: ${RUNAI_CONFIG.clusterUrl}`);
    console.log(`   Auth Endpoint: ${authEndpoint}`);
    console.log(`   Client ID: ${RUNAI_CONFIG.clientId}`);
    console.log('   Client Secret: [REDACTED]');

  } catch (error) {
    console.error('');
    console.error('❌ Connection test failed!');
    console.error(`Error: ${error.message}`);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('🔍 The cluster appears to be unreachable. Check the URL and network connectivity.');
    } else if (error.code === 'ENOTFOUND') {
      console.error('🔍 DNS resolution failed. Check if the cluster URL is correct.');
    } else if (error.code === 'ETIMEDOUT') {
      console.error('🔍 Connection timed out. The cluster might be slow or unreachable.');
    }
  }
}

// Run the test
testRunaiConnection().catch(console.error);
