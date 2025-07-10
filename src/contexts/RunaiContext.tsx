import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import RunaiApiClient from '../services/runaiApi';
import { RunaiCluster, AuthConfig } from '../types/runai';
import { getRunaiConfig } from '../config/runai-config';
import toast from 'react-hot-toast';

interface RunaiContextType {
  client: RunaiApiClient | null;
  clusters: RunaiCluster[];
  selectedCluster: RunaiCluster | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  authenticate: () => Promise<boolean>;
  refreshClusters: () => Promise<void>;
  selectCluster: (cluster: RunaiCluster) => void;
  logout: () => void;
}

const RunaiContext = createContext<RunaiContextType | undefined>(undefined);

interface RunaiProviderProps {
  children: ReactNode;
  authConfig?: Partial<AuthConfig>;
}

export const RunaiProvider: React.FC<RunaiProviderProps> = ({ 
  children, 
  authConfig 
}) => {
  const [client, setClient] = useState<RunaiApiClient | null>(null);
  const [clusters, setClusters] = useState<RunaiCluster[]>([]);
  const [selectedCluster, setSelectedCluster] = useState<RunaiCluster | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = getRunaiConfig();

  // Initialize API client
  useEffect(() => {
    const apiClient = new RunaiApiClient(authConfig);
    setClient(apiClient);
  }, [authConfig]);

  const refreshClusters = useCallback(async (showToasts: boolean = true): Promise<void> => {
    if (!client || !isAuthenticated) return;

    setIsLoading(true);
    try {
      setError(null);

      const clusterData = await client.getClusters();
      setClusters(clusterData);

      if (showToasts) {
        toast.success('Clusters refreshed successfully');
      }
    } catch (err: any) {
      const errorMessage = err.message || 'Failed to refresh clusters';
      setError(errorMessage);
      console.error('Error refreshing clusters:', err);
      if (showToasts) {
        toast.error(errorMessage);
      }
    } finally {
      setIsLoading(false);
    }
  }, [client, isAuthenticated]);

  const authenticate = useCallback(async (showToasts: boolean = true): Promise<boolean> => {
    if (!client) return false;

    setIsLoading(true);
    setError(null);

    try {
      const success = await client.authenticate();

      if (success) {
        setIsAuthenticated(true);
        if (showToasts) {
          toast.success('Successfully authenticated with Run:ai cluster');
        }

        // Load clusters after authentication
        await refreshClusters(showToasts);

        return true;
      } else {
        setIsAuthenticated(false);
        setError('Authentication failed');
        if (showToasts) {
          toast.error('Failed to authenticate with Run:ai cluster');
        }
        return false;
      }
    } catch (err: any) {
      const errorMessage = err.message || 'Authentication failed';
      setError(errorMessage);
      setIsAuthenticated(false);
      console.error('Authentication error:', err);
      if (showToasts) {
        toast.error(errorMessage);
      }
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [client, refreshClusters]);

  // Auto-authenticate when client is ready
  useEffect(() => {
    if (client && !isAuthenticated && !isLoading) {
      console.log('[RunaiContext] Auto-authenticating on startup...');
      authenticate();
    }
  }, [client, isAuthenticated, isLoading, authenticate]);

  // Auto-refresh clusters and re-authenticate periodically
  useEffect(() => {
    if (isAuthenticated && client) {
      const interval = setInterval(async () => {
        console.log('[RunaiContext] Periodic refresh - re-authenticating and refreshing clusters...');
        // Re-authenticate to refresh token, then refresh clusters (no toasts for automatic refresh)
        const authSuccess = await authenticate(false);
        if (authSuccess) {
          await refreshClusters(false);
        }
      }, config.ui.refreshInterval);

      return () => clearInterval(interval);
    }
  }, [isAuthenticated, client, authenticate, refreshClusters, config.ui.refreshInterval]);

  const selectCluster = (cluster: RunaiCluster): void => {
    setSelectedCluster(cluster);
    toast.success(`Selected cluster: ${cluster.name}`);
  };

  const logout = (): void => {
    setClient(null);
    setClusters([]);
    setSelectedCluster(null);
    setIsAuthenticated(false);
    setError(null);
    
    // Reinitialize client
    const apiClient = new RunaiApiClient(authConfig);
    setClient(apiClient);
    
    toast.success('Logged out successfully');
  };

  const value: RunaiContextType = {
    client,
    clusters,
    selectedCluster,
    isAuthenticated,
    isLoading,
    error,
    authenticate,
    refreshClusters,
    selectCluster,
    logout,
  };

  return (
    <RunaiContext.Provider value={value}>
      {children}
    </RunaiContext.Provider>
  );
};

export const useRunai = (): RunaiContextType => {
  const context = useContext(RunaiContext);
  if (context === undefined) {
    throw new Error('useRunai must be used within a RunaiProvider');
  }
  return context;
};

export default RunaiContext;
