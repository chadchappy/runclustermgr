import React, { useState, useEffect } from 'react';
import {
  Grid,
  Card,
  CardContent,
  Typography,
  Box,
  Chip,
  LinearProgress,
  IconButton,
  Tooltip,
  Alert,
  CircularProgress,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  Refresh as RefreshIcon,
  Info as InfoIcon,
  Warning as WarningIcon,
  Error as ErrorIcon,
  CheckCircle as CheckCircleIcon,
  Memory as MemoryIcon,
  Speed as SpeedIcon,
  Storage as StorageIcon,
} from '@mui/icons-material';
import { RunaiCluster, GpuType } from '../types/runai';
import { formatDistanceToNow } from 'date-fns';

interface ClusterDashboardProps {
  clusters: RunaiCluster[];
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onClusterSelect: (cluster: RunaiCluster) => void;
}

const ClusterDashboard: React.FC<ClusterDashboardProps> = ({
  clusters,
  loading,
  error,
  onRefresh,
  onClusterSelect,
}) => {
  const [selectedCluster, setSelectedCluster] = useState<RunaiCluster | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return 'success';
      case 'degraded':
        return 'warning';
      case 'offline':
        return 'error';
      default:
        return 'default';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'online':
        return <CheckCircleIcon color="success" />;
      case 'degraded':
        return <WarningIcon color="warning" />;
      case 'offline':
        return <ErrorIcon color="error" />;
      default:
        return <InfoIcon />;
    }
  };

  const formatMemory = (gb: number | undefined) => {
    if (!gb || isNaN(gb)) return '0 GB';
    if (gb >= 1024) {
      return `${(gb / 1024).toFixed(1)} TB`;
    }
    return `${gb} GB`;
  };

  const getUtilizationColor = (utilization: number) => {
    if (utilization < 50) return 'success';
    if (utilization < 80) return 'warning';
    return 'error';
  };

  const handleClusterClick = (cluster: RunaiCluster) => {
    setSelectedCluster(cluster);
    setDetailsOpen(true);
  };

  const handleClusterSelect = () => {
    if (selectedCluster) {
      onClusterSelect(selectedCluster);
      setDetailsOpen(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress size={60} />
        <Typography variant="h6" sx={{ ml: 2 }}>
          Loading clusters...
        </Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" action={
        <Button color="inherit" size="small" onClick={onRefresh}>
          Retry
        </Button>
      }>
        {error}
      </Alert>
    );
  }

  return (
    <Box>
      <Box display="flex" justifyContent="space-between" alignItems="center" mb={3}>
        <Typography variant="h4" component="h1">
          Run:ai Clusters
        </Typography>
        <Tooltip title="Refresh clusters">
          <IconButton onClick={onRefresh} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Grid container spacing={3}>
        {clusters.map((cluster) => (
          <Grid item xs={12} md={6} lg={4} key={cluster.id}>
            <Card 
              sx={{ 
                height: '100%',
                cursor: 'pointer',
                transition: 'all 0.2s',
                '&:hover': {
                  transform: 'translateY(-2px)',
                  boxShadow: 4,
                },
              }}
              onClick={() => handleClusterClick(cluster)}
            >
              <CardContent>
                {/* Header */}
                <Box display="flex" justifyContent="space-between" alignItems="flex-start" mb={2}>
                  <Box>
                    <Typography variant="h6" component="h2" gutterBottom>
                      {cluster.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {cluster.region || 'Unknown region'}
                    </Typography>
                  </Box>
                  <Box display="flex" alignItems="center" gap={1}>
                    {getStatusIcon(cluster.status)}
                    <Chip
                      label={cluster.status.toUpperCase()}
                      color={getStatusColor(cluster.status) as any}
                      size="small"
                    />
                  </Box>
                </Box>

                {/* GPU Resources */}
                <Box mb={2}>
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                    <Typography variant="body2" color="text.secondary">
                      GPU Utilization
                    </Typography>
                    <Typography variant="body2" fontWeight="bold">
                      {cluster.gpuResources.allocated}/{cluster.gpuResources.total} GPUs
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={cluster.gpuResources.utilization || 0}
                    color={getUtilizationColor(cluster.gpuResources.utilization || 0)}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {(cluster.gpuResources.utilization || 0).toFixed(1)}% utilized
                  </Typography>
                </Box>

                {/* GPU Types */}
                <Box mb={2}>
                  <Typography variant="body2" color="text.secondary" gutterBottom>
                    GPU Types
                  </Typography>
                  <Box display="flex" flexWrap="wrap" gap={0.5}>
                    {cluster.gpuResources.types.map((gpu: GpuType, index) => (
                      <Chip
                        key={index}
                        label={`${gpu.count}x ${gpu.model}`}
                        size="small"
                        variant="outlined"
                        icon={<SpeedIcon />}
                      />
                    ))}
                  </Box>
                </Box>

                {/* Memory */}
                <Box mb={2}>
                  <Box display="flex" justifyContent="space-between" alignItems="center" mb={1}>
                    <Typography variant="body2" color="text.secondary">
                      Memory
                    </Typography>
                    <Typography variant="body2">
                      {formatMemory(cluster.gpuResources.memory.allocated)} / {formatMemory(cluster.gpuResources.memory.total)}
                    </Typography>
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={(cluster.gpuResources.memory.allocated / cluster.gpuResources.memory.total) * 100}
                    color={getUtilizationColor((cluster.gpuResources.memory.allocated / cluster.gpuResources.memory.total) * 100)}
                    sx={{ height: 6, borderRadius: 3 }}
                  />
                </Box>

                {/* Jobs */}
                <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                  <Box textAlign="center">
                    <Typography variant="h6" color="primary">
                      {cluster.metrics.jobsRunning}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Running
                    </Typography>
                  </Box>
                  <Box textAlign="center">
                    <Typography variant="h6" color="warning.main">
                      {cluster.metrics.jobsPending}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Pending
                    </Typography>
                  </Box>
                  <Box textAlign="center">
                    <Typography variant="h6" color="success.main">
                      {cluster.metrics.jobsCompleted}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Completed
                    </Typography>
                  </Box>
                </Box>

                {/* Last Seen */}
                <Typography variant="caption" color="text.secondary">
                  Last seen: {formatDistanceToNow(new Date(cluster.lastSeen), { addSuffix: true })}
                </Typography>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Cluster Details Dialog */}
      <Dialog
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>
          {selectedCluster?.name} - Detailed Information
        </DialogTitle>
        <DialogContent>
          {selectedCluster && (
            <Grid container spacing={2}>
              <Grid item xs={12} md={6}>
                <Typography variant="h6" gutterBottom>
                  Cluster Information
                </Typography>
                <Typography variant="body2">
                  <strong>ID:</strong> {selectedCluster.id}
                </Typography>
                <Typography variant="body2">
                  <strong>URL:</strong> {selectedCluster.url}
                </Typography>
                <Typography variant="body2">
                  <strong>Version:</strong> {selectedCluster.version}
                </Typography>
                <Typography variant="body2">
                  <strong>Region:</strong> {selectedCluster.region || 'Unknown'}
                </Typography>
              </Grid>
              
              <Grid item xs={12} md={6}>
                <Typography variant="h6" gutterBottom>
                  Resource Details
                </Typography>
                <Typography variant="body2">
                  <strong>Total GPUs:</strong> {selectedCluster.gpuResources.total}
                </Typography>
                <Typography variant="body2">
                  <strong>Available GPUs:</strong> {selectedCluster.gpuResources.available}
                </Typography>
                <Typography variant="body2">
                  <strong>Total Memory:</strong> {formatMemory(selectedCluster.gpuResources.memory.total)}
                </Typography>
                <Typography variant="body2">
                  <strong>Available Memory:</strong> {formatMemory(selectedCluster.gpuResources.memory.available)}
                </Typography>
              </Grid>

              <Grid item xs={12}>
                <Typography variant="h6" gutterBottom>
                  Performance Metrics
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={4}>
                    <Box textAlign="center" p={2} bgcolor="background.paper" borderRadius={1}>
                      <Typography variant="h4" color="primary">
                        {(selectedCluster.metrics.gpuUtilization || 0).toFixed(1)}%
                      </Typography>
                      <Typography variant="caption">GPU Utilization</Typography>
                    </Box>
                  </Grid>
                  <Grid item xs={4}>
                    <Box textAlign="center" p={2} bgcolor="background.paper" borderRadius={1}>
                      <Typography variant="h4" color="secondary">
                        {(selectedCluster.metrics.throughput?.jobsPerHour || 0).toFixed(1)}
                      </Typography>
                      <Typography variant="caption">Jobs/Hour</Typography>
                    </Box>
                  </Grid>
                  <Grid item xs={4}>
                    <Box textAlign="center" p={2} bgcolor="background.paper" borderRadius={1}>
                      <Typography variant="h4" color="success.main">
                        {(selectedCluster.metrics.throughput?.gpuHoursUsed || 0).toFixed(1)}
                      </Typography>
                      <Typography variant="caption">GPU Hours</Typography>
                    </Box>
                  </Grid>
                </Grid>
              </Grid>
            </Grid>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailsOpen(false)}>
            Close
          </Button>
          <Button
            variant="contained"
            onClick={handleClusterSelect}
            disabled={!selectedCluster}
          >
            Select This Cluster
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default ClusterDashboard;
