import React, { useEffect } from 'react';
import {
  ThemeProvider,
  createTheme,
  CssBaseline,
  AppBar,
  Toolbar,
  Typography,
  Container,
  Box,
  Chip,
  IconButton,
  Menu,
  MenuItem,
} from '@mui/material';
import {
  Settings as SettingsIcon,
  Logout as LogoutIcon,
  Refresh as RefreshIcon,
} from '@mui/icons-material';
import { Toaster } from 'react-hot-toast';
import { RunaiProvider, useRunai } from './contexts/RunaiContext';
import ClusterDashboard from './components/ClusterDashboard';
import WorkloadSubmissionForm from './components/WorkloadSubmissionForm';
import { getRunaiConfig } from './config/runai-config';

// Create theme with NVIDIA colors
const theme = createTheme({
  palette: {
    primary: {
      main: '#76b900', // NVIDIA green
    },
    secondary: {
      main: '#1976d2',
    },
    background: {
      default: '#f5f5f5',
    },
  },
  typography: {
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    h4: {
      fontWeight: 600,
    },
    h6: {
      fontWeight: 500,
    },
  },
  components: {
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: 12,
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 8,
          textTransform: 'none',
          fontWeight: 500,
        },
      },
    },
  },
});

const AppContent: React.FC = () => {
  const {
    clusters,
    selectedCluster,
    isAuthenticated,
    isLoading,
    error,
    refreshClusters,
    selectCluster,
    logout,
  } = useRunai();

  const [settingsAnchor, setSettingsAnchor] = React.useState<null | HTMLElement>(null);
  const config = getRunaiConfig();

  // Auto-refresh every 60 seconds and clear cache
  useEffect(() => {
    const clearCache = () => {
      // Clear browser cache
      if ('caches' in window) {
        caches.keys().then(names => {
          names.forEach(name => {
            caches.delete(name);
          });
        });
      }

      // Clear localStorage cache
      const cacheKeys = Object.keys(localStorage).filter(key =>
        key.startsWith('runai-') || key.startsWith('cluster-') || key.startsWith('workload-')
      );
      cacheKeys.forEach(key => localStorage.removeItem(key));

      console.log('[App] Cache cleared automatically');
    };

    const autoRefresh = () => {
      if (isAuthenticated) {
        console.log('[App] Auto-refreshing clusters and clearing cache...');
        clearCache();
        refreshClusters();
      }
    };

    // Initial cache clear
    clearCache();

    // Set up auto-refresh every 60 seconds
    const interval = setInterval(autoRefresh, 60000);

    return () => clearInterval(interval);
  }, [isAuthenticated, refreshClusters]);

  const handleSettingsClick = (event: React.MouseEvent<HTMLElement>) => {
    setSettingsAnchor(event.currentTarget);
  };

  const handleSettingsClose = () => {
    setSettingsAnchor(null);
  };

  const handleLogout = () => {
    logout();
    handleSettingsClose();
  };

  const handleClearCache = () => {
    // Clear browser cache
    if ('caches' in window) {
      caches.keys().then(names => {
        names.forEach(name => {
          caches.delete(name);
        });
      });
    }

    // Clear localStorage cache
    const cacheKeys = Object.keys(localStorage).filter(key =>
      key.startsWith('runai-') || key.startsWith('cluster-') || key.startsWith('workload-')
    );
    cacheKeys.forEach(key => localStorage.removeItem(key));

    // Force page reload to clear all cached resources
    window.location.reload();
  };

  const getConnectionStatus = () => {
    if (!isAuthenticated) return { label: 'Disconnected', color: 'error' as const };
    if (isLoading) return { label: 'Connecting...', color: 'warning' as const };
    if (error) return { label: 'Error', color: 'error' as const };
    return { label: 'Connected', color: 'success' as const };
  };

  const connectionStatus = getConnectionStatus();

  return (
    <Box sx={{ flexGrow: 1 }}>
      {/* App Bar */}
      <AppBar position="static" elevation={1}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Run:ai Cluster Manager
          </Typography>
          
          {/* Connection Status */}
          <Chip
            label={connectionStatus.label}
            color={connectionStatus.color}
            size="small"
            sx={{ mr: 2 }}
          />
          
          {/* Selected Cluster */}
          {selectedCluster && (
            <Chip
              label={`Cluster: ${selectedCluster.name}`}
              variant="outlined"
              size="small"
              sx={{ mr: 2, color: 'white', borderColor: 'rgba(255,255,255,0.5)' }}
            />
          )}
          
          {/* Refresh Button */}
          <IconButton
            color="inherit"
            onClick={refreshClusters}
            disabled={!isAuthenticated || isLoading}
            sx={{ mr: 1 }}
          >
            <RefreshIcon />
          </IconButton>
          
          {/* Settings Menu */}
          <IconButton
            color="inherit"
            onClick={handleSettingsClick}
          >
            <SettingsIcon />
          </IconButton>
          
          <Menu
            anchorEl={settingsAnchor}
            open={Boolean(settingsAnchor)}
            onClose={handleSettingsClose}
          >
            <MenuItem onClick={handleClearCache}>
              <RefreshIcon sx={{ mr: 1 }} />
              Clear Cache & Reload
            </MenuItem>
            <MenuItem onClick={handleLogout}>
              <LogoutIcon sx={{ mr: 1 }} />
              Logout
            </MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      {/* Main Content */}
      <Container maxWidth="xl" sx={{ mt: 4, mb: 4 }}>
        {!isAuthenticated ? (
          <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            minHeight="60vh"
            textAlign="center"
          >
            <Typography variant="h4" gutterBottom>
              Run:ai Cluster Manager
            </Typography>
            <Typography variant="body1" color="text.secondary" paragraph>
              {isLoading ? 'Connecting to Run:ai cluster...' : 'Initializing connection...'}
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              Cluster: {config.clusters[0].name} ({config.clusters[0].url})
            </Typography>
            {error && (
              <Typography variant="body2" color="error" paragraph>
                Error: {error}
              </Typography>
            )}
            {/* Show loading indicator */}
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {isLoading ? 'Authenticating...' : 'Starting up...'}
              </Typography>
            </Box>
          </Box>
        ) : (
          <>
            {/* Cluster Dashboards at the top */}
            <ClusterDashboard
              clusters={clusters}
              loading={isLoading}
              error={error || undefined}
              onRefresh={refreshClusters}
              onClusterSelect={selectCluster}
            />

            {/* Workload Submission Form below */}
            <Box sx={{ mt: 6 }}>
              <Typography variant="h4" component="h2" gutterBottom sx={{ mb: 3 }}>
                Submit Workload
              </Typography>
              <WorkloadSubmissionForm />
            </Box>
          </>
        )}
      </Container>

      {/* Toast Notifications */}
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: {
            background: '#333',
            color: '#fff',
          },
          success: {
            iconTheme: {
              primary: '#76b900',
              secondary: '#fff',
            },
          },
        }}
      />
    </Box>
  );
};

const App: React.FC = () => {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <RunaiProvider>
        <AppContent />
      </RunaiProvider>
    </ThemeProvider>
  );
};

export default App;
