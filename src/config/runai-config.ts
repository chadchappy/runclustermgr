// Run:ai Cluster Configuration
export const RUNAI_CONFIG = {
  // Primary cluster configuration
  clusters: [
    {
      id: 'cluster-a',
      name: 'US Demo West',
      url: 'https://runai.example.com',
      region: 'us-west-1',
      apiEndpoint: 'http://localhost:8080', // Use proxy server to avoid CORS
      websocketEndpoint: 'wss://runai.example.com/ws',
      isDefault: true,
    }
  ],
  
  // API Authentication
  auth: {
    appId: 'your-app-name',
    appSecret: 'REDACTED',
    clientId: 'your-app-name',
    clientSecret: 'REDACTED',
    appName: 'your-app-name',
    grantType: 'client_credentials',
    scope: 'openid profile email',
  },
  
  // API Configuration
  api: {
    timeout: 30000,
    retryAttempts: 3,
    retryDelay: 1000,
    authEndpoint: '/auth/realms/runai/protocol/openid-connect/token',
    baseEndpoint: '/api/v1',
    baseHeaders: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'RunAI-Cluster-Manager/1.0.0',
    },
  },
  
  // Load Balancing Configuration
  loadBalancing: {
    defaultStrategy: 'gpu-availability' as const,
    refreshInterval: 30000, // 30 seconds
    preferences: {
      minAvailableGpus: 1,
      maxUtilization: 90, // percentage
      preferredGpuTypes: ['L40s', 'A100', 'V100'],
      excludedClusters: [],
    },
    fallback: {
      enabled: true,
      strategy: 'queue' as const,
      maxWaitTime: 3600, // 1 hour
    },
  },
  
  // WebSocket Configuration
  websocket: {
    reconnectInterval: 5000,
    maxReconnectAttempts: 10,
    heartbeatInterval: 30000,
  },
  
  // UI Configuration
  ui: {
    refreshInterval: 60000, // 60 seconds
    theme: {
      primary: '#76b900', // NVIDIA green
      secondary: '#1976d2',
      error: '#d32f2f',
      warning: '#ed6c02',
      success: '#2e7d32',
    },
    charts: {
      animationDuration: 750,
      colors: ['#76b900', '#1976d2', '#ed6c02', '#d32f2f', '#2e7d32'],
    },
  },
  
  // Development/Testing Configuration
  development: {
    useMockData: false,
    enableDebugLogs: true,
    mockApiDelay: 1000,
  },
};

// Environment-specific overrides
export const getRunaiConfig = () => {
  const config = { ...RUNAI_CONFIG };

  // Runtime configuration from window object (set by docker-entrypoint.sh)
  const runtimeConfig = (window as any).RUNAI_CONFIG;

  // Override with environment variables or runtime config
  if (runtimeConfig) {
    // Use runtime configuration from container - through nginx proxy
    config.clusters[0].url = `https://${runtimeConfig.CONTROL_PLANE}`;
    config.clusters[0].apiEndpoint = `/api`; // Use nginx proxy in container
    config.auth.clientId = runtimeConfig.APP_NAME;
    config.auth.clientSecret = runtimeConfig.APP_SECRET;
    config.auth.appName = runtimeConfig.APP_NAME;
    config.auth.appId = runtimeConfig.APP_NAME;
  } else {
    // Use environment variables for development
    if (process.env.REACT_APP_RUNAI_CONTROL_PLANE) {
      config.clusters[0].url = `https://${process.env.REACT_APP_RUNAI_CONTROL_PLANE}`;
    }
    if (process.env.REACT_APP_RUNAI_APP_NAME) {
      config.auth.clientId = process.env.REACT_APP_RUNAI_APP_NAME;
      config.auth.appName = process.env.REACT_APP_RUNAI_APP_NAME;
      config.auth.appId = process.env.REACT_APP_RUNAI_APP_NAME;
    }
    if (process.env.REACT_APP_RUNAI_APP_SECRET) {
      config.auth.clientSecret = process.env.REACT_APP_RUNAI_APP_SECRET;
    }
  }

  // Override for development
  if (process.env.NODE_ENV === 'development') {
    config.development.enableDebugLogs = true;

    // Use mock data if API is not available
    if (process.env.REACT_APP_USE_MOCK_DATA === 'true') {
      config.development.useMockData = true;
    }
  }

  // Override for production
  if (process.env.NODE_ENV === 'production') {
    config.development.enableDebugLogs = false;
    config.development.useMockData = false;
  }

  return config;
};

// API Endpoints - Dynamic based on runtime configuration
export const getApiEndpoints = () => {
  const runtimeConfig = (window as any).RUNAI_CONFIG;

  // Use proxy endpoints to avoid CORS issues
  return {
    // Authentication (Keycloak OpenID Connect) - Through nginx proxy
    auth: {
      token: '/auth/realms/runai/protocol/openid-connect/token',
      refresh: '/auth/realms/runai/protocol/openid-connect/token',
      logout: '/auth/realms/runai/protocol/openid-connect/logout',
      userInfo: '/auth/realms/runai/protocol/openid-connect/userinfo',
    },

    // Clusters - Through nginx proxy
    clusters: {
      list: '/api/v1/clusters',
      get: (id: string) => `/api/v1/clusters/${id}`,
      metrics: (id: string) => `/api/v1/clusters/${id}/metrics`,
      nodes: (id: string) => `/api/v1/clusters/${id}/nodes`,
      status: (id: string) => `/api/v1/clusters/${id}/status`,
    },

    // Workloads - Through nginx proxy
    workloads: {
      list: '/api/v1/workloads',
      get: (id: string) => `/api/v1/workloads/${id}`,
      metrics: (id: string) => `/api/v1/workloads/${id}/metrics`,
    },

    // Node Pools - Through nginx proxy
    nodePools: {
      list: '/api/v1/node-pools',
      get: (id: string) => `/api/v1/node-pools/${id}`,
    },
    nodes: {
      telemetry: '/api/v1/nodes/telemetry',
    },

    // Projects - Through nginx proxy
    projects: {
      list: (clusterId: string) => `/clusters/${clusterId}/projects`,
      get: (clusterId: string, projectId: string) => `/clusters/${clusterId}/projects/${projectId}`,
      create: (clusterId: string) => `/clusters/${clusterId}/projects`,
      update: (clusterId: string, projectId: string) => `/clusters/${clusterId}/projects/${projectId}`,
      delete: (clusterId: string, projectId: string) => `/clusters/${clusterId}/projects/${projectId}`,
    },

    // Jobs - Through nginx proxy
    jobs: {
      list: (clusterId: string, projectId?: string) =>
        projectId ? `/clusters/${clusterId}/projects/${projectId}/jobs` : `/clusters/${clusterId}/jobs`,
      get: (clusterId: string, jobId: string) => `/clusters/${clusterId}/jobs/${jobId}`,
      create: (clusterId: string) => `/clusters/${clusterId}/jobs`,
      update: (clusterId: string, jobId: string) => `/clusters/${clusterId}/jobs/${jobId}`,
      delete: (clusterId: string, jobId: string) => `/clusters/${clusterId}/jobs/${jobId}`,
      logs: (clusterId: string, jobId: string) => `/clusters/${clusterId}/jobs/${jobId}/logs`,
      events: (clusterId: string, jobId: string) => `/clusters/${clusterId}/jobs/${jobId}/events`,
    },

    // Load Balancing - Through nginx proxy
    loadBalancer: {
      recommendations: '/load-balancer/recommendations',
      submit: '/load-balancer/submit',
      status: '/load-balancer/status',
    },

    // Monitoring - Through nginx proxy
    monitoring: {
      metrics: '/monitoring/metrics',
      alerts: '/monitoring/alerts',
      health: '/monitoring/health',
    },
  };
};

// Backward compatibility - export static version for non-runtime usage
export const API_ENDPOINTS = getApiEndpoints();

// Error Messages
export const ERROR_MESSAGES = {
  auth: {
    invalidCredentials: 'Invalid client credentials. Please check your client ID and secret.',
    tokenExpired: 'Authentication token has expired. Please log in again.',
    unauthorized: 'You are not authorized to perform this action.',
    networkError: 'Network error occurred during authentication.',
  },
  
  cluster: {
    notFound: 'Cluster not found or is not accessible.',
    offline: 'Cluster is currently offline or unreachable.',
    degraded: 'Cluster is in a degraded state and may not function properly.',
    noGpuAvailable: 'No GPU resources are available in this cluster.',
  },
  
  job: {
    submissionFailed: 'Failed to submit job. Please check your configuration.',
    notFound: 'Job not found or has been deleted.',
    invalidConfig: 'Job configuration is invalid or incomplete.',
    resourcesUnavailable: 'Requested resources are not available.',
  },
  
  general: {
    networkError: 'Network error occurred. Please check your connection.',
    serverError: 'Server error occurred. Please try again later.',
    unknownError: 'An unknown error occurred. Please contact support.',
  },
};

export default RUNAI_CONFIG;
