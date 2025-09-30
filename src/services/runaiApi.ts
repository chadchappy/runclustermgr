import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import {
  RunaiCluster,
  RunaiJob,
  RunaiProject,
  WorkloadSubmission,
  ApiResponse,
  AuthConfig,
  ClusterMetrics,
  ClusterRecommendation,
  LoadBalancingConfig
} from '../types/runai';
import { getRunaiConfig, getApiEndpoints, ERROR_MESSAGES } from '../config/runai-config';

class RunaiApiClient {
  private client: AxiosInstance;
  private authConfig: AuthConfig;
  private clusters: Map<string, RunaiCluster> = new Map();
  private config = getRunaiConfig();

  constructor(authConfig?: Partial<AuthConfig>) {
    // Use provided config or default from configuration
    this.authConfig = {
      endpoint: this.config.clusters[0].apiEndpoint,
      clientId: this.config.auth.clientId,
      clientSecret: this.config.auth.clientSecret,
      ...authConfig,
    };

    this.client = axios.create({
      // Don't use baseURL - let the endpoints be absolute paths for proper proxy routing
      timeout: this.config.api.timeout,
      headers: {
        ...this.config.api.baseHeaders,
      },
    });

    this.setupInterceptors();
  }

  private setupInterceptors() {
    // Request interceptor for auth
    this.client.interceptors.request.use(
      (config) => {
        if (this.authConfig.token) {
          config.headers.Authorization = `Bearer ${this.authConfig.token}`;
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401) {
          // Token expired, try to refresh
          await this.refreshToken();
          return this.client.request(error.config);
        }
        return Promise.reject(error);
      }
    );
  }

  // Authentication methods
  async authenticate(): Promise<boolean> {
    try {
      if (this.config.development.enableDebugLogs) {
        console.log('Authenticating with Run:ai cluster via proxy');
      }

      // Use Keycloak OpenID Connect authentication through nginx proxy
      const authData = {
        grant_type: this.config.auth.grantType,
        client_id: this.authConfig.clientId,
        client_secret: this.authConfig.clientSecret,
      };

      const apiEndpoints = getApiEndpoints();

      if (this.config.development.enableDebugLogs) {
        console.log('Auth endpoint:', apiEndpoints.auth.token);
        console.log('Auth data:', { ...authData, client_secret: '[REDACTED]' });
      }

      const response = await this.client.post(apiEndpoints.auth.token, authData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        transformRequest: [(data: any) => {
          return Object.keys(data)
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
            .join('&');
        }],
      });

      const token = response.data.access_token || response.data.token;
      if (token) {
        this.authConfig.token = token;
        const expiresIn = response.data.expires_in || 3600;
        this.authConfig.expiresAt = new Date(Date.now() + (expiresIn * 1000)).toISOString();

        if (this.config.development.enableDebugLogs) {
          console.log('Authentication successful via proxy');
        }

        return true;
      }

      throw new Error('No access token received');
    } catch (error: any) {
      console.error('Authentication failed:', error);
      console.error('Response data:', error.response?.data);
      console.error('Response status:', error.response?.status);

      if (error.response?.status === 401) {
        throw new Error(ERROR_MESSAGES.auth.invalidCredentials);
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new Error(ERROR_MESSAGES.auth.networkError);
      }

      throw new Error(error.message || ERROR_MESSAGES.general.unknownError);
    }
  }
  private getAuthEndpoint(): string {
    return `${this.config.clusters[0].url}/auth/realms/runai/protocol/openid-connect/token`;
  }
  private async refreshToken(): Promise<void> {
    console.log('[RunaiApiClient] Token expired, re-authenticating with client credentials...');

    try {
      // For client credentials flow, we re-authenticate instead of refreshing
      await this.authenticate();
      console.log('[RunaiApiClient] Re-authentication successful');
    } catch (error) {
      console.error('Re-authentication failed:', error);
      throw error;
    }
  }

  // Helper method for calculating cluster metrics
  private calculateClusterMetrics(cluster: any, nodePools: any[], workloads: any[], nodesTelemetry: any[]) {
    try {
      // Calculate total GPUs - prioritize telemetry data, fallback to node pools
      let totalGpus = 0;

      if (nodesTelemetry && nodesTelemetry.length > 0) {
        // Use enhanced telemetry data to get actual GPU counts per cluster
        for (const telemetryItem of nodesTelemetry) {
          if (telemetryItem.clusterId === cluster.uuid || !telemetryItem.clusterId) {
            // Use the new telemetry structure with multiple metrics
            const clusterTotalGpus = telemetryItem.total_gpus || telemetryItem.gpuCapacity || 0;
            totalGpus += clusterTotalGpus;
          }
        }
      }

      // Fallback to node pools calculation if telemetry data unavailable or empty
      if (totalGpus === 0) {
        for (const pool of nodePools) {
          if (pool.clusterId === cluster.uuid && pool.labelKey === 'nvidia.com/gpu.product') {
            // Each GPU node has 8 GPUs (H100 or A100) as specified by user
            const nodeCount = pool.status?.nodes?.length || 0;
            const gpusPerNode = 8; // 8 GPUs per node (4 nodes × 8 GPUs = 32 total)
            totalGpus += nodeCount * gpusPerNode;
          }
        }
      }

      // Calculate used GPUs - prioritize telemetry data, fallback to workload calculation
      let usedGpus = 0;
      let runningWorkloads = 0;
      let telemetryUsedGpus = 0;

      // Try to get used GPUs from telemetry data first
      if (nodesTelemetry && nodesTelemetry.length > 0) {
        for (const telemetryItem of nodesTelemetry) {
          if (telemetryItem.clusterId === cluster.uuid || !telemetryItem.clusterId) {
            telemetryUsedGpus += telemetryItem.allocated_gpus || 0;
          }
        }
      }

      console.log(`[DEBUG] Processing ${workloads.length} workloads for cluster ${cluster.uuid} (${cluster.name})`);

      // Calculate from workloads as fallback or verification
      for (const workload of workloads) {
        if (workload.clusterId === cluster.uuid && workload.phase === 'Running') {
          runningWorkloads++;
          // Count GPU requests from running workloads
          const gpuRequest = workload.workloadRequestedResources?.gpu?.request || 0;
          usedGpus += gpuRequest;
          console.log(`[DEBUG] Running workload: ${workload.name}, GPUs: ${gpuRequest}, Cluster: ${workload.clusterId}`);
        }
      }

      // Use telemetry data if available, otherwise use workload calculation
      const finalUsedGpus = telemetryUsedGpus > 0 ? telemetryUsedGpus : usedGpus;

      console.log(`[DEBUG] Cluster ${cluster.name} (${cluster.uuid}): Total GPUs: ${totalGpus}, Used GPUs (telemetry): ${telemetryUsedGpus}, Used GPUs (workloads): ${usedGpus}, Final Used GPUs: ${finalUsedGpus}, Running workloads: ${runningWorkloads}`);

      // Use correct default if no data available (4 nodes × 8 GPUs = 32 total)
      if (totalGpus === 0) totalGpus = 32;

      const availableGpus = Math.max(0, totalGpus - finalUsedGpus);
      const utilization = totalGpus > 0 ? (finalUsedGpus / totalGpus) * 100 : 0;

      return {
        totalGpus,
        availableGpus,
        utilization: Math.round(utilization * 100) / 100, // Round to 2 decimal places
        runningWorkloads
      };
    } catch (error) {
      console.warn('Failed to calculate cluster metrics:', error);
      return {
        totalGpus: 32, // 4 nodes × 8 GPUs = 32 total
        availableGpus: 16, // Assume 50% utilization
        utilization: 50.0,
        runningWorkloads: 0
      };
    }
  }

  // Cluster management methods
  async getClusters(): Promise<RunaiCluster[]> {
    try {
      const apiEndpoints = getApiEndpoints();

      if (this.config.development.enableDebugLogs) {
        console.log('Fetching clusters from:', apiEndpoints.clusters.list);
      }

      const response = await this.client.get(apiEndpoints.clusters.list);

      if (this.config.development.enableDebugLogs) {
        console.log('Clusters response:', response.data);
      }

      // Fetch additional data needed for calculations
      const [nodePoolsData, workloadsData, nodesTelemetryData] = await Promise.all([
        this.getNodePools().catch(() => []),
        this.getWorkloads().catch(() => []),
        this.getNodesTelemetry().catch(() => [])
      ]);

      // The API returns an array of clusters directly
      const clusters: RunaiCluster[] = response.data.map((cluster: any) => {
        const metrics = this.calculateClusterMetrics(cluster, nodePoolsData, workloadsData, nodesTelemetryData);

        return {
          id: cluster.uuid,
          name: cluster.name,
          url: `https://runai.example.com`, // Use the base URL
          status: cluster.status?.state === 'Connected' ? 'online' : 'offline',
          version: cluster.version || '1.0.0',
          region: cluster.region || 'us-west',
          lastSeen: cluster.lastLiveness || new Date().toISOString(),
          gpuResources: {
            total: metrics.totalGpus,
            allocated: metrics.totalGpus - metrics.availableGpus,
            available: metrics.availableGpus,
            utilization: metrics.utilization,
            types: [], // Will be populated if needed
            memory: {
              total: metrics.totalGpus * 80, // Assume 80GB per GPU (L40s)
              allocated: (metrics.totalGpus - metrics.availableGpus) * 80,
              available: metrics.availableGpus * 80,
            }
          },
          projects: [], // Will be populated by separate API call if needed
          nodes: [], // Will be populated by separate API call if needed
          metrics: {
            timestamp: new Date().toISOString(),
            gpuUtilization: metrics.utilization,
            memoryUtilization: 0,
            cpuUtilization: 0,
            jobsRunning: metrics.runningWorkloads || 0,
            jobsPending: 0,
            jobsCompleted: 0,
            jobsFailed: 0,
            throughput: {
              jobsPerHour: 0,
              gpuHoursUsed: 0,
            }
          }
        };
      });

      // Update local cache
      clusters.forEach(cluster => {
        this.clusters.set(cluster.id, cluster);
      });

      return clusters;
    } catch (error: any) {
      console.error('Error fetching clusters:', error);
      if (error.response?.status === 401) {
        throw new Error('Authentication failed. Please re-authenticate.');
      }
      throw new Error(error.message || 'Failed to fetch clusters');
    }
  }

  // Get workloads data
  async getWorkloads(): Promise<any[]> {
    try {
      const apiEndpoints = getApiEndpoints();
      const response = await this.client.get(apiEndpoints.workloads.list);
      return response.data.workloads || [];
    } catch (error: any) {
      console.error('Error fetching workloads:', error);
      throw new Error(error.message || 'Failed to fetch workloads');
    }
  }

  // Get node pools data
  async getNodePools(): Promise<any[]> {
    try {
      const apiEndpoints = getApiEndpoints();
      const response = await this.client.get(apiEndpoints.nodePools.list);
      return response.data.nodepools || [];
    } catch (error: any) {
      console.error('Error fetching node pools:', error);
      throw new Error(error.message || 'Failed to fetch node pools');
    }
  }

  // Get nodes telemetry data for actual GPU counts and usage
  async getNodesTelemetry(): Promise<any[]> {
    try {
      const apiEndpoints = getApiEndpoints();
      // Fetch multiple telemetry types for comprehensive GPU metrics
      const telemetryTypes = ['TOTAL_GPUS', 'FREE_GPUS', 'ALLOCATED_GPUS', 'READY_GPUS'];
      const telemetryPromises = telemetryTypes.map(async (type) => {
        try {
          const response = await this.client.get(apiEndpoints.nodes.telemetry, {
            params: { telemetryType: type }
          });
          return { type, data: response.data || [] };
        } catch (error) {
          console.warn(`Failed to fetch telemetry type ${type}:`, error);
          return { type, data: [] };
        }
      });

      const telemetryResults = await Promise.all(telemetryPromises);

      // Combine all telemetry data into a unified structure
      const combinedTelemetry: any[] = [];
      telemetryResults.forEach(({ type, data }) => {
        if (Array.isArray(data)) {
          data.forEach((item: any) => {
            const existingItem = combinedTelemetry.find(t =>
              t.clusterId === item.clusterId || t.nodeId === item.nodeId
            );
            if (existingItem) {
              existingItem[type.toLowerCase()] = item.value || item.count || 0;
            } else {
              combinedTelemetry.push({
                ...item,
                [type.toLowerCase()]: item.value || item.count || 0
              });
            }
          });
        }
      });

      return combinedTelemetry;
    } catch (error: any) {
      console.error('Error fetching nodes telemetry:', error);
      return []; // Return empty array on error, don't throw
    }
  }

  async getCluster(clusterId: string): Promise<RunaiCluster> {
    try {
      const response = await this.client.get<ApiResponse<RunaiCluster>>(`/clusters/${clusterId}`);
      
      if (response.data.success && response.data.data) {
        this.clusters.set(clusterId, response.data.data);
        return response.data.data;
      }
      
      throw new Error(response.data.error || 'Failed to fetch cluster');
    } catch (error) {
      console.error(`Error fetching cluster ${clusterId}:`, error);
      throw error;
    }
  }

  async getClusterMetrics(clusterId: string): Promise<ClusterMetrics> {
    try {
      const response = await this.client.get<ApiResponse<ClusterMetrics>>(`/clusters/${clusterId}/metrics`);
      
      if (response.data.success && response.data.data) {
        return response.data.data;
      }
      
      throw new Error(response.data.error || 'Failed to fetch cluster metrics');
    } catch (error) {
      console.error(`Error fetching metrics for cluster ${clusterId}:`, error);
      throw error;
    }
  }

  // Project management methods
  async getProjects(clusterId: string): Promise<RunaiProject[]> {
    try {
      const response = await this.client.get<ApiResponse<RunaiProject[]>>(`/clusters/${clusterId}/projects`);
      
      if (response.data.success && response.data.data) {
        return response.data.data;
      }
      
      throw new Error(response.data.error || 'Failed to fetch projects');
    } catch (error) {
      console.error(`Error fetching projects for cluster ${clusterId}:`, error);
      throw error;
    }
  }

  async getProject(clusterId: string, projectId: string): Promise<RunaiProject> {
    try {
      const response = await this.client.get<ApiResponse<RunaiProject>>(`/clusters/${clusterId}/projects/${projectId}`);
      
      if (response.data.success && response.data.data) {
        return response.data.data;
      }
      
      throw new Error(response.data.error || 'Failed to fetch project');
    } catch (error) {
      console.error(`Error fetching project ${projectId} in cluster ${clusterId}:`, error);
      throw error;
    }
  }

  // Job management methods
  async getJobs(clusterId: string, projectId?: string): Promise<RunaiJob[]> {
    try {
      const url = projectId 
        ? `/clusters/${clusterId}/projects/${projectId}/jobs`
        : `/clusters/${clusterId}/jobs`;
        
      const response = await this.client.get<ApiResponse<RunaiJob[]>>(url);
      
      if (response.data.success && response.data.data) {
        return response.data.data;
      }
      
      throw new Error(response.data.error || 'Failed to fetch jobs');
    } catch (error) {
      console.error(`Error fetching jobs for cluster ${clusterId}:`, error);
      throw error;
    }
  }

  async getJob(clusterId: string, jobId: string): Promise<RunaiJob> {
    try {
      const response = await this.client.get<ApiResponse<RunaiJob>>(`/clusters/${clusterId}/jobs/${jobId}`);
      
      if (response.data.success && response.data.data) {
        return response.data.data;
      }
      
      throw new Error(response.data.error || 'Failed to fetch job');
    } catch (error) {
      console.error(`Error fetching job ${jobId} in cluster ${clusterId}:`, error);
      throw error;
    }
  }

  async getProjectId(projectName: string, clusterId: string): Promise<string> {
    try {
      const response = await this.client.get('/api/v1/org-unit/projects');
      const projects = response.data.projects || [];

      // Find project by name and cluster ID
      const project = projects.find((p: any) =>
        p.name === projectName && p.clusterId === clusterId
      );

      if (!project) {
        throw new Error(`Project '${projectName}' not found in cluster '${clusterId}'`);
      }

      return project.id;
    } catch (error) {
      console.error('Error fetching project ID:', error);
      throw error;
    }
  }

  async submitJob(clusterId: string, workload: WorkloadSubmission): Promise<RunaiJob> {
    // Determine workload type and endpoint (outside try block for error logging)
    const workloadType = workload.type || 'interactive'; // Default to interactive workspace
    let endpoint: string;

    switch (workloadType) {
        case 'training':
          endpoint = '/api/v1/workloads/trainings';
          break;
        case 'distributed':
          endpoint = '/api/v1/workloads/distributed';
          break;
        case 'interactive':
          endpoint = '/api/v1/workloads/workspaces';
          break;
        case 'inference':
          endpoint = '/api/v1/workloads/inferences';
          break;
        default:
          endpoint = '/api/v1/workloads/workspaces'; // Default to workspace
      }

    try {
      // Get the project ID for the given project name and cluster
      const projectId = await this.getProjectId(workload.project, clusterId);

      // Create the Run:ai workload payload using the correct API format
      // Create job payload based on workload type
      let jobPayload: any;

      if (workload.type === 'training') {
        // Calculate total pods for distributed training (master + workers)
        const totalPods = workload.distributed ? (workload.distributed.workers + 1) : 1; // +1 for master
        const gpuPerPod = workload.distributed?.workerGpu || workload.resources.gpu;

        console.log(`[RunaiApiClient] Distributed training config:`, {
          isDistributed: !!workload.distributed,
          framework: workload.distributed?.framework,
          workers: workload.distributed?.workers,
          totalPods,
          gpuPerPod
        });

        // Training workload payload structure
        jobPayload = {
          name: workload.name,
          useGivenNameAsPrefix: false,
          projectId: projectId,
          clusterId: clusterId,
          spec: {
            command: workload.command && workload.command.length > 0 ? workload.command.join(' ') : undefined,
            args: workload.args && workload.args.length > 0 ? workload.args.join(' ') : undefined,
            image: workload.image,
            imagePullPolicy: "Always",
            workingDir: "/workspace",
            createHomeDir: true,
            probes: {},
            nodeType: undefined,
            nodePools: [],
            podAffinity: {},
            tty: true,
            stdin: true,
            environmentVariables: workload.env ? Object.entries(workload.env).map(([key, value]) => ({ name: key, value })) : [],
            annotations: [],
            labels: [],
            tolerations: [],
            terminateAfterPreemption: false,
            autoDeletionTimeAfterCompletionSeconds: 15,
            terminationGracePeriodSeconds: 20,
            backoffLimit: 3,
            ports: [],
            exposedUrls: [],
            relatedUrls: [],
            priorityClass: "build",
            // For distributed training: completions = total pods, parallelism = total pods
            completions: totalPods,
            parallelism: totalPods,
            compute: {
              ...(gpuPerPod && gpuPerPod > 0 && { gpuPortionRequest: gpuPerPod }),
              ...(workload.resources.cpu && workload.resources.cpu > 0 && { cpu: workload.resources.cpu }),
              ...(workload.resources.memory && workload.resources.memory > 0 && { memory: `${workload.resources.memory}G` })
            },
            storage: {},
            security: {}
          }
        };
      } else if (workload.type === 'distributed') {
        // Distributed training workload using training endpoint with distributed parameters
        console.log(`[RunaiApiClient] Distributed training config:`, {
          framework: workload.distributed?.framework,
          workers: workload.distributed?.workers,
          gpuPerPod: workload.resources.gpu
        });

        // Create base spec for both worker and master
        const baseSpec = {
          command: workload.command && workload.command.length > 0 ? workload.command.join(' ') : undefined,
          args: workload.args && workload.args.length > 0 ? workload.args.join(' ') : undefined,
          image: workload.image,
          imagePullPolicy: "Always",
          workingDir: "/workspace",
          createHomeDir: true,
          probes: {},
          nodeType: undefined,
          nodePools: [],
          podAffinity: {},
          tty: true,
          stdin: true,
          environmentVariables: workload.env ? Object.entries(workload.env).map(([key, value]) => ({ name: key, value })) : [],
          annotations: [],
          labels: [],
          tolerations: [],
          terminateAfterPreemption: false,
          autoDeletionTimeAfterCompletionSeconds: 15,
          terminationGracePeriodSeconds: 20,
          backoffLimit: 3,
          ports: [],
          exposedUrls: [],
          relatedUrls: [],
          compute: {
            ...(workload.resources.gpu && workload.resources.gpu > 0 && { gpuPortionRequest: workload.resources.gpu }),
            ...(workload.resources.cpu && workload.resources.cpu > 0 && { cpu: workload.resources.cpu }),
            ...(workload.resources.memory && workload.resources.memory > 0 && { memory: `${workload.resources.memory}G` })
          },
          storage: {},
          security: {}
        };

        // Distributed training payload with proper command/args parsing
        console.log('[submitJob] DISTRIBUTED - Full workload object:', workload);
        console.log('[submitJob] DISTRIBUTED - workload.command:', workload.command);
        console.log('[submitJob] DISTRIBUTED - workload.distributed:', workload.distributed);
        const commandArray = workload.command || ["python"];
        console.log('[submitJob] DISTRIBUTED - Command array:', commandArray);
        console.log('[submitJob] DISTRIBUTED - Command array length:', commandArray.length);
        console.log('[submitJob] DISTRIBUTED - Command array type:', typeof commandArray);

        // Find the split point - everything before the first argument (starting with -)
        let commandEndIndex = commandArray.length;
        for (let i = 0; i < commandArray.length; i++) {
          console.log(`[submitJob] DISTRIBUTED - Checking index ${i}: "${commandArray[i]}" (starts with -: ${commandArray[i].startsWith('-')})`);
          if (commandArray[i].startsWith('-')) {
            commandEndIndex = i;
            console.log('[submitJob] DISTRIBUTED - Found split point at index:', i);
            break;
          }
        }

        console.log('[submitJob] DISTRIBUTED - Command end index:', commandEndIndex);
        const baseCommand = commandArray.slice(0, commandEndIndex).join(' ');
        const commandArgs = commandArray.slice(commandEndIndex).join(' ') || "--help";
        console.log('[submitJob] DISTRIBUTED - Base command:', `"${baseCommand}"`);
        console.log('[submitJob] DISTRIBUTED - Command args:', `"${commandArgs}"`);
        console.log('[submitJob] DISTRIBUTED - Base command length:', baseCommand.length);

        // Map framework from WorkloadSubmission to API values
        let apiFramework = "PyTorch"; // default
        if (workload.distributed?.framework) {
          switch (workload.distributed.framework) {
            case 'PyTorchJob':
              apiFramework = "PyTorch";
              break;
            case 'TensorFlowJob':
              apiFramework = "TF";
              break;
            case 'MPIJob':
              apiFramework = "MPI";
              break;
            case 'XGBoostJob':
              apiFramework = "XGBoost";
              break;
            default:
              apiFramework = "PyTorch";
          }
        }

        // Create framework-specific payload
        const distributedSpec: any = {
          command: baseCommand,
          args: commandArgs || "--help", // Ensure args is not empty
          image: workload.image,
          distributedFramework: apiFramework,
          numWorkers: workload.distributed?.workers || 2,
          compute: {
            gpuDevicesRequest: workload.resources.gpu,
            ...(workload.resources.gpu < 1 && {
              gpuRequestType: "portion",
              gpuPortionRequest: workload.resources.gpu,
              gpuPortionLimit: workload.resources.gpu
            }),
            cpuCoreRequest: workload.resources.cpu || 0.2,
            cpuMemoryRequest: `${workload.resources.memory || 200}M`
          },
          storage: {},
          security: {}
        };

        // Add framework-specific fields only for MPI
        if (apiFramework === "MPI") {
          distributedSpec.slotsPerWorker = 1;
          distributedSpec.minReplicas = 0;
          distributedSpec.maxReplicas = 0;
          distributedSpec.cleanPodPolicy = "None";
        }

        jobPayload = {
          name: workload.name,
          projectId: projectId,
          clusterId: clusterId,
          masterSpecSameAsWorker: true,
          spec: distributedSpec
        };
      } else if (workload.type === 'inference') {
        // Inference workload payload structure (matches API specification)
        jobPayload = {
          name: workload.name,
          useGivenNameAsPrefix: false,
          projectId: projectId,
          clusterId: clusterId,
          spec: {
            command: workload.command && workload.command.length > 0 ? workload.command.join(' ') : undefined,
            args: workload.args && workload.args.length > 0 ? workload.args.join(' ') : undefined,
            image: workload.image,
            imagePullPolicy: "Always",
            workingDir: "/home/myfolder",
            createHomeDir: true,
            probes: {},
            nodeType: undefined,
            nodePools: [],
            podAffinity: {},
            environmentVariables: workload.env ? Object.entries(workload.env).map(([key, value]) => ({ name: key, value })) : [],
            annotations: [],
            labels: [],
            tolerations: [],
            ports: [],
            exposedUrls: [],
            relatedUrls: [],
            compute: {},
            storage: {},
            security: {},
            servingPort: {
              container: workload.resources?.port || 8000,
              protocol: "http"
            },
            autoscaling: {}
          }
        };
      } else {
        // Interactive/workspace workload payload structure
        jobPayload = {
          name: workload.name,
          useGivenNameAsPrefix: false,
          projectId: projectId,
          clusterId: clusterId,
          spec: {
            image: workload.image,
            command: workload.command && workload.command.length > 0 ? workload.command.join(' ') : undefined,
            args: workload.args && workload.args.length > 0 ? workload.args.join(' ') : undefined,
            tty: true,
            stdin: true,
            environmentVariables: workload.env ? Object.entries(workload.env).map(([key, value]) => ({ name: key, value })) : [],
            annotations: [],
            labels: [],
            tolerations: [],
            terminateAfterPreemption: false,
            ports: [],
            exposedUrls: [],
            relatedUrls: [],
            compute: {
              ...(workload.resources.gpu && workload.resources.gpu > 0 && { gpuPortionRequest: workload.resources.gpu }),
              ...(workload.resources.cpu && workload.resources.cpu > 0 && { cpu: workload.resources.cpu }),
              ...(workload.resources.memory && workload.resources.memory > 0 && { memory: `${workload.resources.memory}G` })
            },
            storage: {},
            security: {}
          }
        };
      }

      console.log(`[RunaiApiClient] Submitting ${workloadType} workload to endpoint: ${endpoint}`);
      console.log(`[RunaiApiClient] Payload:`, JSON.stringify(jobPayload, null, 2));
      console.log(`[RunaiApiClient] Payload size:`, JSON.stringify(jobPayload).length, 'bytes');

      // Check for any 'port' fields in the payload
      const payloadStr = JSON.stringify(jobPayload);
      if (payloadStr.includes('"port"')) {
        console.log(`[RunaiApiClient] WARNING: Found 'port' field in payload!`);
        console.log(`[RunaiApiClient] Port field locations:`, payloadStr.match(/"port"[^,}]*/g));
      }
      console.log(`[RunaiApiClient] Project ID resolved: ${projectId} for project: ${workload.project}`);

      const response = await this.client.post<any>(
        endpoint,
        jobPayload
      );

      console.log(`[RunaiApiClient] Raw API response:`, response.data);
      console.log(`[RunaiApiClient] Response status:`, response.status);

      // Handle different response formats
      if (response.status >= 200 && response.status < 300) {
        // Success response - return the data directly or from wrapped format
        if (response.data && typeof response.data === 'object') {
          // If it's a wrapped response with success/data structure
          if (response.data.success !== undefined && response.data.data) {
            return response.data.data;
          }
          // If it's direct job data
          else if (response.data.metadata || response.data.name || response.data.id) {
            return response.data;
          }
          // If it's some other successful format
          else {
            console.log(`[RunaiApiClient] Job submitted successfully, response:`, response.data);
            return response.data;
          }
        }

        // If we get here, it's a successful response but unexpected format
        console.log(`[RunaiApiClient] Job submitted successfully with unexpected response format`);
        return {
          id: 'unknown',
          name: workload.name,
          status: 'pending' as const,
          project: workload.project,
          type: workload.type,
          gpuRequested: workload.resources.gpu,
          gpuAllocated: 0,
          cpuRequested: workload.resources.cpu,
          cpuAllocated: 0,
          memoryRequested: workload.resources.memory,
          memoryAllocated: 0,
          createdAt: new Date().toISOString(),
          startedAt: undefined,
          completedAt: undefined,
          user: 'unknown',
          image: workload.image,
          clusterId: clusterId
        } as RunaiJob;
      }

      throw new Error(`Failed to submit job: HTTP ${response.status}`);
    } catch (error: any) {
      console.error(`Error submitting job to cluster ${clusterId}:`, error);
      console.error(`Error details:`, {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
        statusText: error.response?.statusText,
        workloadType: workloadType,
        clusterId: clusterId,
        endpoint: endpoint
      });

      // Log specific API error details if available
      if (error.response?.data) {
        console.error(`API Error Response:`, error.response.data);
        if (error.response.data.message) {
          console.error(`API Error Message:`, error.response.data.message);
        }
        if (error.response.data.details) {
          console.error(`API Error Details:`, error.response.data.details);
        }
      }

      throw error;
    }
  }

  async deleteJob(clusterId: string, jobId: string): Promise<boolean> {
    try {
      const response = await this.client.delete<ApiResponse<boolean>>(`/clusters/${clusterId}/jobs/${jobId}`);
      
      return response.data.success || false;
    } catch (error) {
      console.error(`Error deleting job ${jobId} in cluster ${clusterId}:`, error);
      throw error;
    }
  }

  // Load balancing methods
  async getClusterRecommendations(
    workload: WorkloadSubmission,
    config: LoadBalancingConfig
  ): Promise<ClusterRecommendation[]> {
    try {
      const apiEndpoints = getApiEndpoints();
      const response = await this.client.post<ApiResponse<ClusterRecommendation[]>>(
        apiEndpoints.loadBalancer.recommendations,
        { workload, config }
      );

      if (response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error(response.data.error || 'Failed to get cluster recommendations');
    } catch (error) {
      console.error('Error getting cluster recommendations:', error);
      throw error;
    }
  }

  async submitJobWithLoadBalancing(
    workload: WorkloadSubmission,
    config: LoadBalancingConfig
  ): Promise<{ job: RunaiJob; clusterId: string }> {
    try {
      const apiEndpoints = getApiEndpoints();
      const response = await this.client.post<ApiResponse<{ job: RunaiJob; clusterId: string }>>(
        apiEndpoints.loadBalancer.submit,
        { workload, config }
      );

      if (response.data.success && response.data.data) {
        return response.data.data;
      }

      throw new Error(response.data.error || 'Failed to submit job with load balancing');
    } catch (error) {
      console.error('Error submitting job with load balancing:', error);
      throw error;
    }
  }

  // Enhanced cluster selection with multi-cluster overview decision making
  findBestClusterForWorkload(workload: WorkloadSubmission): RunaiCluster | null {
    const clusters = this.getAllCachedClusters();

    console.log(`[RunaiApiClient] Finding best cluster for workload requiring ${workload.resources.gpu} GPUs`);
    console.log(`[RunaiApiClient] Available clusters:`, clusters.map(c => ({
      id: c.id,
      name: c.name,
      totalGpus: c.gpuResources.total,
      allocatedGpus: c.gpuResources.allocated,
      availableGpus: c.gpuResources.available,
      utilization: c.gpuResources.utilization,
      runningJobs: c.metrics?.jobsRunning || 0
    })));

    if (clusters.length === 0) {
      console.log(`[RunaiApiClient] No clusters available`);
      return null;
    }

    // Filter clusters that can accommodate the workload
    const suitableClusters = clusters.filter(cluster => {
      const metrics = cluster.metrics;
      if (!metrics) {
        console.log(`[RunaiApiClient] Cluster ${cluster.id} has no metrics, skipping`);
        return false;
      }

      // Check if cluster has enough available GPUs
      const availableGpus = cluster.gpuResources.available;
      if (availableGpus < workload.resources.gpu) {
        console.log(`[RunaiApiClient] Cluster ${cluster.id} has insufficient GPUs: ${availableGpus} < ${workload.resources.gpu}`);
        return false;
      }

      // Check if cluster has enough available memory
      const availableMemoryGB = cluster.gpuResources.memory.available;
      if (availableMemoryGB < workload.resources.memory) {
        console.log(`[RunaiApiClient] Cluster ${cluster.id} has insufficient memory: ${availableMemoryGB}GB < ${workload.resources.memory}GB`);
        return false;
      }

      // For CPU, we'll use a simple heuristic since CPU info isn't in the current interface
      // Assume each GPU node has reasonable CPU capacity
      const estimatedAvailableCpu = availableGpus * 8; // 8 CPU cores per GPU as estimate
      if (estimatedAvailableCpu < workload.resources.cpu) {
        console.log(`[RunaiApiClient] Cluster ${cluster.id} has insufficient CPU: ${estimatedAvailableCpu} < ${workload.resources.cpu}`);
        return false;
      }

      console.log(`[RunaiApiClient] Cluster ${cluster.id} is suitable: ${availableGpus} GPUs available, ${cluster.gpuResources.utilization}% utilization`);
      return true;
    });

    if (suitableClusters.length === 0) {
      console.log(`[RunaiApiClient] No suitable clusters found for workload requirements`);
      return null;
    }

    console.log(`[RunaiApiClient] Multi-cluster overview analysis:`, suitableClusters.map(c => {
      const availableRatio = c.gpuResources.available / c.gpuResources.total;
      const utilizationPenalty = Math.min(c.gpuResources.utilization / 100, 1);
      const jobLoadPenalty = Math.min((c.metrics?.jobsRunning || 0) / 10, 1);
      const pendingPenalty = Math.min((c.metrics?.jobsPending || 0) / 5, 1);
      const healthScore = Math.round((availableRatio * 40) + ((1 - utilizationPenalty) * 30) + ((1 - jobLoadPenalty) * 20) + ((1 - pendingPenalty) * 10));

      return {
        id: c.id,
        name: c.name,
        totalGpus: c.gpuResources.total,
        availableGpus: c.gpuResources.available,
        utilization: `${c.gpuResources.utilization.toFixed(1)}%`,
        runningJobs: c.metrics?.jobsRunning || 0,
        pendingJobs: c.metrics?.jobsPending || 0,
        healthScore: healthScore,
        availableRatio: `${(availableRatio * 100).toFixed(1)}%`
      };
    }));

    // Enhanced multi-cluster overview decision making algorithm
    suitableClusters.sort((a, b) => {
      const aAvailableGpus = a.gpuResources.available;
      const bAvailableGpus = b.gpuResources.available;
      const aUtilization = a.gpuResources.utilization;
      const bUtilization = b.gpuResources.utilization;
      const aRunningJobs = a.metrics?.jobsRunning || 0;
      const bRunningJobs = b.metrics?.jobsRunning || 0;
      const aPendingJobs = a.metrics?.jobsPending || 0;
      const bPendingJobs = b.metrics?.jobsPending || 0;
      const aTotalGpus = a.gpuResources.total;
      const bTotalGpus = b.gpuResources.total;

      // Calculate cluster health score (0-100, higher is better)
      const calculateHealthScore = (cluster: RunaiCluster) => {
        const availableRatio = cluster.gpuResources.available / cluster.gpuResources.total;
        const utilizationPenalty = Math.min(cluster.gpuResources.utilization / 100, 1);
        const jobLoadPenalty = Math.min((cluster.metrics?.jobsRunning || 0) / 10, 1);
        const pendingPenalty = Math.min((cluster.metrics?.jobsPending || 0) / 5, 1);

        return Math.round((availableRatio * 40) + ((1 - utilizationPenalty) * 30) + ((1 - jobLoadPenalty) * 20) + ((1 - pendingPenalty) * 10));
      };

      const aHealthScore = calculateHealthScore(a);
      const bHealthScore = calculateHealthScore(b);

      // Primary: Higher health score is better (multi-cluster overview approach)
      if (aHealthScore !== bHealthScore) {
        return bHealthScore - aHealthScore;
      }

      // Secondary: More available GPUs is better
      if (aAvailableGpus !== bAvailableGpus) {
        return bAvailableGpus - aAvailableGpus;
      }

      // Tertiary: Lower GPU utilization is better
      if (Math.abs(aUtilization - bUtilization) > 1) {
        return aUtilization - bUtilization;
      }

      // Quaternary: Fewer pending jobs is better (queue length)
      if (aPendingJobs !== bPendingJobs) {
        return aPendingJobs - bPendingJobs;
      }

      // Final: Fewer running jobs is better (load balancing)
      return aRunningJobs - bRunningJobs;
    });

    const selectedCluster = suitableClusters[0];

    // Calculate final health score for selected cluster
    const availableRatio = selectedCluster.gpuResources.available / selectedCluster.gpuResources.total;
    const utilizationPenalty = Math.min(selectedCluster.gpuResources.utilization / 100, 1);
    const jobLoadPenalty = Math.min((selectedCluster.metrics?.jobsRunning || 0) / 10, 1);
    const pendingPenalty = Math.min((selectedCluster.metrics?.jobsPending || 0) / 5, 1);
    const finalHealthScore = Math.round((availableRatio * 40) + ((1 - utilizationPenalty) * 30) + ((1 - jobLoadPenalty) * 20) + ((1 - pendingPenalty) * 10));

    console.log(`[RunaiApiClient] 🎯 SELECTED CLUSTER (Multi-cluster Overview Decision):`, {
      id: selectedCluster.id,
      name: selectedCluster.name,
      healthScore: `${finalHealthScore}/100`,
      totalGpus: selectedCluster.gpuResources.total,
      availableGpus: selectedCluster.gpuResources.available,
      utilization: `${selectedCluster.gpuResources.utilization.toFixed(1)}%`,
      runningJobs: selectedCluster.metrics?.jobsRunning || 0,
      pendingJobs: selectedCluster.metrics?.jobsPending || 0,
      availableRatio: `${(availableRatio * 100).toFixed(1)}%`,
      reason: 'Best overall health score based on availability, utilization, and job load'
    });

    return selectedCluster;
  }

  async submitJobToOptimalCluster(workload: WorkloadSubmission): Promise<{ job: RunaiJob; clusterId: string }> {
    // Find the best cluster locally
    const bestCluster = this.findBestClusterForWorkload(workload);

    if (!bestCluster) {
      throw new Error('No suitable cluster found for the workload requirements');
    }

    console.log(`[RunaiApiClient] Selected cluster ${bestCluster.id} for workload ${workload.name}`);
    console.log(`[RunaiApiClient] Cluster has ${bestCluster.gpuResources.available} available GPUs`);

    // Submit the job to the selected cluster
    const job = await this.submitJob(bestCluster.id, workload);

    return {
      job,
      clusterId: bestCluster.id
    };
  }

  // Utility methods
  getCachedCluster(clusterId: string): RunaiCluster | undefined {
    return this.clusters.get(clusterId);
  }

  getAllCachedClusters(): RunaiCluster[] {
    return Array.from(this.clusters.values());
  }

  updateAuthConfig(newConfig: Partial<AuthConfig>): void {
    this.authConfig = { ...this.authConfig, ...newConfig };

    // Don't update baseURL - we use absolute paths for proper proxy routing
  }

  isAuthenticated(): boolean {
    if (!this.authConfig.token) return false;
    
    if (this.authConfig.expiresAt) {
      return new Date() < new Date(this.authConfig.expiresAt);
    }
    
    return true;
  }
}

export default RunaiApiClient;

// Mock data generator for development/testing
export class MockRunaiApiClient extends RunaiApiClient {
  constructor() {
    super({ endpoint: 'http://localhost:3001' });
  }

  async getClusters(): Promise<RunaiCluster[]> {
    // Simulate API delay
    await new Promise(resolve => setTimeout(resolve, 1000));

    return [
      {
        id: 'cluster-us-west-1',
        name: 'US West Production',
        url: 'https://runai-us-west-1.company.com',
        status: 'online',
        version: '2.15.0',
        region: 'us-west-1',
        lastSeen: new Date().toISOString(),
        gpuResources: {
          total: 32,
          allocated: 18,
          available: 14,
          utilization: 56.25,
          types: [
            { model: 'L40s', count: 16, memory: 48, utilization: 45 },
            { model: 'A100', count: 16, memory: 80, utilization: 67 }
          ],
          memory: { total: 2048, allocated: 1200, available: 848 }
        },
        projects: [],
        nodes: [],
        metrics: {
          timestamp: new Date().toISOString(),
          gpuUtilization: 56.25,
          memoryUtilization: 58.6,
          cpuUtilization: 42.3,
          jobsRunning: 12,
          jobsPending: 3,
          jobsCompleted: 145,
          jobsFailed: 2,
          throughput: { jobsPerHour: 8.5, gpuHoursUsed: 156.7 }
        }
      },
      {
        id: 'cluster-us-east-1',
        name: 'US East Development',
        url: 'https://runai-us-east-1.company.com',
        status: 'online',
        version: '2.15.0',
        region: 'us-east-1',
        lastSeen: new Date().toISOString(),
        gpuResources: {
          total: 24,
          allocated: 8,
          available: 16,
          utilization: 33.33,
          types: [
            { model: 'L40s', count: 24, memory: 48, utilization: 33 }
          ],
          memory: { total: 1152, allocated: 384, available: 768 }
        },
        projects: [],
        nodes: [],
        metrics: {
          timestamp: new Date().toISOString(),
          gpuUtilization: 33.33,
          memoryUtilization: 33.3,
          cpuUtilization: 28.7,
          jobsRunning: 6,
          jobsPending: 1,
          jobsCompleted: 89,
          jobsFailed: 1,
          throughput: { jobsPerHour: 5.2, gpuHoursUsed: 78.4 }
        }
      },
      {
        id: 'cluster-eu-west-1',
        name: 'EU West Research',
        url: 'https://runai-eu-west-1.company.com',
        status: 'degraded',
        version: '2.14.2',
        region: 'eu-west-1',
        lastSeen: new Date(Date.now() - 300000).toISOString(), // 5 minutes ago
        gpuResources: {
          total: 16,
          allocated: 14,
          available: 2,
          utilization: 87.5,
          types: [
            { model: 'V100', count: 16, memory: 32, utilization: 87 }
          ],
          memory: { total: 512, allocated: 448, available: 64 }
        },
        projects: [],
        nodes: [],
        metrics: {
          timestamp: new Date().toISOString(),
          gpuUtilization: 87.5,
          memoryUtilization: 87.5,
          cpuUtilization: 78.9,
          jobsRunning: 14,
          jobsPending: 8,
          jobsCompleted: 234,
          jobsFailed: 5,
          throughput: { jobsPerHour: 12.3, gpuHoursUsed: 198.7 }
        }
      }
    ];
  }

  async getClusterRecommendations(
    workload: WorkloadSubmission,
    config: LoadBalancingConfig
  ): Promise<ClusterRecommendation[]> {
    await new Promise(resolve => setTimeout(resolve, 500));

    return [
      {
        clusterId: 'cluster-us-east-1',
        clusterName: 'US East Development',
        score: 95,
        reasons: [
          'High GPU availability (16/24 available)',
          'Low utilization (33%)',
          'Matching GPU type (L40s)',
          'Low queue wait time'
        ],
        estimatedWaitTime: 0,
        availableGpus: 16,
        gpuUtilization: 33.33,
        confidence: 98
      },
      {
        clusterId: 'cluster-us-west-1',
        clusterName: 'US West Production',
        score: 78,
        reasons: [
          'Moderate GPU availability (14/32 available)',
          'Medium utilization (56%)',
          'Matching GPU type (L40s)',
          'Stable performance'
        ],
        estimatedWaitTime: 120,
        availableGpus: 14,
        gpuUtilization: 56.25,
        confidence: 85
      },
      {
        clusterId: 'cluster-eu-west-1',
        clusterName: 'EU West Research',
        score: 25,
        reasons: [
          'Low GPU availability (2/16 available)',
          'High utilization (87%)',
          'Different GPU type (V100)',
          'High queue wait time'
        ],
        estimatedWaitTime: 1800,
        availableGpus: 2,
        gpuUtilization: 87.5,
        confidence: 60
      }
    ];
  }
}
