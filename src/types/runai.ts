// Run:ai API Types and Interfaces

export interface RunaiCluster {
  id: string;
  name: string;
  url: string;
  status: 'online' | 'offline' | 'degraded';
  version: string;
  region?: string;
  lastSeen: string;
  gpuResources: GpuResources;
  projects: RunaiProject[];
  nodes: ClusterNode[];
  metrics: ClusterMetrics;
}

export interface GpuResources {
  total: number;
  allocated: number;
  available: number;
  utilization: number; // percentage
  types: GpuType[];
  memory: {
    total: number; // GB
    allocated: number; // GB
    available: number; // GB
  };
}

export interface GpuType {
  model: string; // e.g., "L40s", "A100", "V100"
  count: number;
  memory: number; // GB per GPU
  utilization: number; // percentage
}

export interface RunaiProject {
  id: string;
  name: string;
  namespace: string;
  gpuQuota: number;
  gpuUsed: number;
  cpuQuota: number;
  cpuUsed: number;
  memoryQuota: number; // GB
  memoryUsed: number; // GB
  jobs: RunaiJob[];
}

export interface RunaiJob {
  id: string;
  name: string;
  project: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'suspended';
  type: 'training' | 'interactive' | 'inference';
  gpuRequested: number;
  gpuAllocated: number;
  cpuRequested: number;
  cpuAllocated: number;
  memoryRequested: number; // GB
  memoryAllocated: number; // GB
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number; // seconds
  user: string;
  image: string;
  command?: string[];
  args?: string[];
  workingDir?: string;
  env?: Record<string, string>;
}

export interface ClusterNode {
  name: string;
  status: 'ready' | 'not-ready' | 'unknown';
  roles: string[];
  gpus: NodeGpu[];
  cpu: {
    capacity: number;
    allocatable: number;
    used: number;
  };
  memory: {
    capacity: number; // GB
    allocatable: number; // GB
    used: number; // GB
  };
  labels: Record<string, string>;
  taints: NodeTaint[];
}

export interface NodeGpu {
  id: string;
  model: string;
  memory: number; // GB
  utilization: number; // percentage
  memoryUtilization: number; // percentage
  temperature: number; // Celsius
  powerUsage: number; // Watts
  status: 'healthy' | 'unhealthy' | 'unknown';
}

export interface NodeTaint {
  key: string;
  value?: string;
  effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute';
}

export interface ClusterMetrics {
  timestamp: string;
  gpuUtilization: number; // percentage
  memoryUtilization: number; // percentage
  cpuUtilization: number; // percentage
  jobsRunning: number;
  jobsPending: number;
  jobsCompleted: number;
  jobsFailed: number;
  throughput: {
    jobsPerHour: number;
    gpuHoursUsed: number;
  };
}

export interface LoadBalancingConfig {
  strategy: 'gpu-availability' | 'weighted-round-robin' | 'least-loaded' | 'custom';
  weights?: Record<string, number>; // cluster_id -> weight
  preferences: {
    preferredRegions?: string[];
    excludedClusters?: string[];
    minAvailableGpus?: number;
    maxUtilization?: number; // percentage
    gpuTypes?: string[]; // preferred GPU types
  };
  fallback: {
    enabled: boolean;
    strategy: 'any-available' | 'queue' | 'reject';
    maxWaitTime?: number; // seconds
  };
}

export interface WorkloadSubmission {
  name: string;
  project: string;
  type: 'training' | 'interactive' | 'inference' | 'distributed';
  image: string;
  command?: string[];
  args?: string[];
  workingDir?: string;
  env?: Record<string, string>;
  resources: {
    gpu: number;
    cpu: number;
    memory: number; // GB
    gpuType?: string;
    port?: number; // For inference workloads
  };
  volumes?: VolumeMount[];
  nodeSelector?: Record<string, string>;
  tolerations?: NodeTaint[];
  priority?: number;
  preemptible?: boolean;
  targetCluster?: string; // optional override
  autoRetry?: boolean;
  maxRetries?: number;
  // Distributed training configuration
  distributed?: {
    framework: 'PyTorchJob' | 'TensorFlowJob' | 'MPIJob' | 'XGBoostJob';
    workers: number; // Number of worker pods
    masterGpu?: number; // GPUs for master pod (defaults to same as workers)
    workerGpu?: number; // GPUs per worker pod
  };
}

export interface VolumeMount {
  name: string;
  mountPath: string;
  subPath?: string;
  readOnly?: boolean;
  source: {
    type: 'pvc' | 'hostPath' | 'configMap' | 'secret';
    name: string;
    path?: string;
  };
}

export interface ClusterRecommendation {
  clusterId: string;
  clusterName: string;
  score: number; // 0-100
  reasons: string[];
  estimatedWaitTime: number; // seconds
  availableGpus: number;
  gpuUtilization: number;
  confidence: number; // 0-100
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface AuthConfig {
  endpoint: string;
  token?: string;
  username?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
}

export interface WebSocketMessage {
  type: 'cluster-update' | 'job-update' | 'metrics-update' | 'error';
  clusterId?: string;
  data: any;
  timestamp: string;
}
