# Run:ai Cluster Manager

A comprehensive web application for managing NVIDIA Run:ai clusters with intelligent load balancing, real-time GPU monitoring, and distributed training support.

## 🚀 Features

- **Multi-Cluster Management**: Connect and manage multiple Run:ai clusters from a single interface
- **Intelligent Load Balancing**: Automatically find the cluster with the most available GPU resources
- **Real-Time Monitoring**: Live GPU utilization, memory usage, and cluster health metrics
- **Workload Submission**: Support for workspace, training, inference, and distributed training workloads
- **Distributed Training**: Full support for PyTorch, TensorFlow, MPI, and XGBoost distributed training
- **CLI Integration**: Parse and execute Run:ai CLI commands directly from the web interface
- **Auto-Refresh**: Dashboards automatically refresh every 60 seconds
- **Containerized Deployment**: Ready-to-deploy Docker container with Kubernetes manifests

## 🏗️ Architecture

- **Frontend**: React TypeScript with Material-UI
- **Backend Proxy**: nginx reverse proxy for CORS handling
- **Authentication**: OAuth2 client credentials flow with Keycloak
- **Container**: Single-stage nginx container with built React app
- **Deployment**: Kubernetes-ready with ConfigMaps and Secrets

## 📋 Prerequisites

- Docker and Docker Compose
- Kubernetes cluster with kubectl configured
- Access to Run:ai control plane
- Run:ai application credentials (app name and secret)

## ⚙️ Configuration

### Environment Variables

The application can be configured using the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `RUNAI_CONTROL_PLANE` | Run:ai control plane URL (without https://) | `runai.example.com` |
| `RUNAI_APP_NAME` | Run:ai application name | `your-app-name` |
| `RUNAI_APP_SECRET` | Run:ai application secret | `REDACTED` |

### Updating Configuration

1. **For Kubernetes deployment**: Edit `k8s/configmap.yaml` and `k8s/secret.yaml`
2. **For Docker deployment**: Set environment variables when running the container
3. **For development**: Update `src/config/runai-config.ts`

## 🚀 Quick Start

### Option 1: Kubernetes Deployment (Recommended)

1. **Clone the repository**:
   ```bash
   git clone https://github.com/chadchappy/runclustermgr.git
   cd runclustermgr
   ```

2. **Configure your environment**:
   ```bash
   # Edit the ConfigMap with your Run:ai settings
   kubectl edit configmap runai-app-config -f k8s/configmap.yaml

   # Update the secret with your app secret (base64 encoded)
   echo -n "your-app-secret" | base64
   kubectl edit secret runai-app-secret -f k8s/configmap.yaml
   ```

3. **Deploy to Kubernetes**:
   ```bash
   chmod +x scripts/deploy.sh
   ./scripts/deploy.sh
   ```

4. **Access the application**:
   ```bash
   kubectl port-forward service/runai-app 3000:3000
   ```

   Open http://localhost:3000 in your browser.

### Option 2: Docker Deployment

1. **Run with Docker**:
   ```bash
   docker run -d \
     --name runai-cluster-manager \
     -p 3000:3000 \
     -e RUNAI_CONTROL_PLANE="your-control-plane.com" \
     -e RUNAI_APP_NAME="your-app-name" \
     -e RUNAI_APP_SECRET="your-app-secret" \
     ghcr.io/chadchappy/runai-app:latest
   ```

2. **Access the application**:
   Open http://localhost:3000 in your browser.

## 🔧 Development

### Local Development Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure environment**:
   ```bash
   # Copy and edit the configuration
   cp src/config/runai-config.ts.example src/config/runai-config.ts
   # Edit the file with your Run:ai credentials
   ```

3. **Start development server**:
   ```bash
   npm start
   ```

4. **Start proxy server** (in another terminal):
   ```bash
   node proxy-server.js
   ```

### Building for Production

```bash
# Build the React application
npm run build

# Build Docker image
docker build -t runai-cluster-manager .

# Or use the build script
chmod +x scripts/build.sh
./scripts/build.sh
```

## 📁 Project Structure

```
├── src/                          # React TypeScript source code
│   ├── components/              # React components
│   ├── services/               # API services and utilities
│   ├── types/                  # TypeScript type definitions
│   └── config/                 # Configuration files
├── k8s/                         # Kubernetes manifests
│   ├── configmap.yaml          # ConfigMap and Secret definitions
│   ├── deployment.yaml         # Application deployment
│   └── service.yaml            # Services and networking
├── scripts/                     # Deployment and utility scripts
│   ├── build.sh               # Container build script
│   ├── deploy.sh              # Kubernetes deployment script
│   └── update-config.sh       # Configuration update utility
├── nginx.conf.template         # nginx configuration template
├── startup.sh                 # Container startup script
├── Dockerfile                 # Container build definition
└── README.md                  # This file
```

## 🎯 Usage

### Dashboard Features

1. **Cluster Overview**: View all connected clusters with health scores
2. **GPU Metrics**: Real-time GPU utilization and memory usage
3. **Load Balancing**: Automatic selection of optimal cluster for workload submission
4. **Workload Management**: Submit and monitor training, workspace, and inference jobs

### Supported Workload Types

- **Workspace**: Interactive development environments
- **Training**: Single-node training jobs
- **Distributed Training**: Multi-node PyTorch, TensorFlow, MPI, and XGBoost jobs
- **Inference**: Model serving and inference workloads

### CLI Command Support

The application supports parsing and executing Run:ai CLI commands:

```bash
# Workspace submission
runai workspace submit my-workspace -i pytorch/pytorch:latest -g 1

# Distributed PyTorch training
runai training pytorch submit my-job --workers=2 -g 2 -i pytorch/pytorch:latest --command -- python train.py

# Training with specific resources
runai training submit my-training -g 0.5 -i tensorflow/tensorflow:latest --cpu 2 --memory 8G
```

## 🔐 Security

- OAuth2 client credentials authentication
- Kubernetes Secrets for sensitive data
- nginx proxy for secure API communication
- CORS handling for cross-origin requests

## 🐛 Troubleshooting

### Common Issues

1. **405 Method Not Allowed**: Check nginx proxy configuration and ensure correct API endpoints
2. **Authentication Failures**: Verify app name and secret in ConfigMap/Secret
3. **CORS Errors**: Ensure proxy server is running and configured correctly
4. **Pod Startup Issues**: Check container logs and resource limits

### Debug Commands

```bash
# Check pod status
kubectl get pods -l app=runai-app

# View logs
kubectl logs -l app=runai-app -f

# Check configuration
kubectl describe configmap runai-app-config
kubectl describe secret runai-app-secret

# Port forward for local access
kubectl port-forward service/runai-app 3000:3000
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🆘 Support

For issues and questions:
- Create an issue in this repository
- Check the troubleshooting section above
- Review the Run:ai documentation

## 🔄 Updates

To update the application:

```bash
# Pull latest changes
git pull origin main

# Rebuild and redeploy
./scripts/build.sh --push
./scripts/deploy.sh
```

## 🏗️ Building the Container Image

### Prerequisites
- Docker installed and running
- kubectl configured for your Kubernetes cluster
- Access to a container registry (optional, for pushing images)

### Build the Image

```bash
# Make the build script executable
chmod +x scripts/build.sh

# Build the container image
./scripts/build.sh

# Optional: Build and push to registry
./scripts/build.sh --push
```

## 🚀 Deploying to Kubernetes

### Quick Deployment

```bash
# Make the deployment script executable
chmod +x scripts/deploy.sh

# Deploy to Kubernetes
./scripts/deploy.sh
```

### Manual Deployment Steps

1. **Apply ConfigMap and Secret:**
   ```bash
   kubectl apply -f k8s/configmap.yaml
   ```

2. **Deploy the application:**
   ```bash
   kubectl apply -f k8s/deployment.yaml
   ```

3. **Create services:**
   ```bash
   kubectl apply -f k8s/service.yaml
   ```

## 🔧 Configuration

### Environment Variables

The application can be configured using the following environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `RUNAI_CONTROL_PLANE` | Run:ai control plane hostname | `runai.example.com` |
| `RUNAI_APP_NAME` | Application name for authentication | `your-app-name` |
| `RUNAI_APP_SECRET` | Application secret for authentication | `REDACTED` |

### Updating Configuration

Use the configuration update script to change environment settings:

```bash
# Make the script executable
chmod +x scripts/update-config.sh

# Show current configuration
./scripts/update-config.sh show

# Update configuration for different environment
./scripts/update-config.sh update runai.example.com your-app-name your-secret-here
```

### Manual Configuration Update

Edit the ConfigMap and Secret directly:

```bash
# Edit ConfigMap
kubectl edit configmap runai-app-config

# Edit Secret (base64 encoded values)
kubectl edit secret runai-app-secret

# Restart deployment to apply changes
kubectl rollout restart deployment/runai-app
```

## 🌐 Accessing the Application

### Port Forwarding (Recommended)

```bash
# Forward port 3000 to your local machine
kubectl port-forward service/runai-app 3000:3000

# Open browser
open http://localhost:3000
```

### NodePort Service

If you prefer direct access without port forwarding:

```bash
# Get the NodePort
kubectl get service runai-app-nodeport

# Access via NodePort (replace <node-ip> and <node-port>)
open http://<node-ip>:<node-port>
```

### Ingress (Optional)

For production deployments with custom domains, configure the Ingress resource in `k8s/service.yaml`.

## 📊 Monitoring and Troubleshooting

### View Application Logs

```bash
# View current logs
kubectl logs -l app=runai-app -f

# View logs from specific pod
kubectl logs <pod-name> -f
```

### Check Application Status

```bash
# Get pod status
kubectl get pods -l app=runai-app

# Describe pod for detailed information
kubectl describe pod -l app=runai-app

# Check service endpoints
kubectl get endpoints runai-app
```

### Health Checks

The application includes health check endpoints:

```bash
# Test health endpoint
curl http://localhost:3000/health
```

## 🔄 Updates and Maintenance

### Updating the Application

1. Build new image with updated tag
2. Update deployment with new image
3. Monitor rollout status

```bash
# Build new image
./scripts/build.sh

# Update deployment (if using latest tag)
kubectl rollout restart deployment/runai-app

# Monitor rollout
kubectl rollout status deployment/runai-app
```

### Scaling the Application

```bash
# Scale to multiple replicas
kubectl scale deployment runai-app --replicas=3

# Check scaling status
kubectl get deployment runai-app
```

## 🛡️ Security Considerations

- The application runs as non-root user (nginx user, UID 101)
- Read-only root filesystem is not enforced due to nginx requirements
- Secrets are stored in Kubernetes Secret objects
- HTTPS is terminated at the nginx proxy level
- CORS is configured for the specific Run:ai control plane

## 📁 File Structure

```
├── Dockerfile                 # Multi-stage container build
├── nginx.conf                # Nginx configuration with proxy
├── docker-entrypoint.sh      # Container startup script
├── k8s/
│   ├── configmap.yaml        # ConfigMap and Secret definitions
│   ├── deployment.yaml       # Kubernetes Deployment
│   └── service.yaml          # Services and Ingress
├── scripts/
│   ├── build.sh             # Container build script
│   ├── deploy.sh            # Kubernetes deployment script
│   └── update-config.sh     # Configuration update script
└── README-DEPLOYMENT.md     # This file
```

## 🆘 Support

For issues with deployment:

1. Check application logs: `kubectl logs -l app=runai-app -f`
2. Verify configuration: `./scripts/update-config.sh show`
3. Test connectivity: `kubectl port-forward service/runai-app 3000:3000`
4. Check health endpoint: `curl http://localhost:3000/health`
