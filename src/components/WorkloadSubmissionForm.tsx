import React, { useState } from 'react';
import {
  Box,
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Grid,
  Chip,
  Alert,
  CircularProgress,
  Tabs,
  Tab,
  Paper,
  IconButton,
  Tooltip,
  Divider
} from '@mui/material';
import {
  PlayArrow as PlayArrowIcon,
  Info as InfoIcon,
  FileCopy as FileCopyIcon,
  Upload as UploadIcon,
  Terminal as TerminalIcon,
  Description as DescriptionIcon
} from '@mui/icons-material';
import { WorkloadSubmission } from '../types/runai';
import { useRunai } from '../contexts/RunaiContext';
import toast from 'react-hot-toast';

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function TabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`workload-tabpanel-${index}`}
      aria-labelledby={`workload-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

interface WorkloadSubmissionFormProps {
  onSubmissionSuccess?: (result: { job: any; clusterId: string }) => void;
}

const WorkloadSubmissionForm: React.FC<WorkloadSubmissionFormProps> = ({
  onSubmissionSuccess
}) => {
  const { client, clusters } = useRunai();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabValue, setTabValue] = useState(0);

  // YAML input state
  const [yamlInput, setYamlInput] = useState(`apiVersion: run.ai/v2alpha1
kind: InteractiveWorkload
metadata:
  creationTimestamp: null
  labels:
    PreviousJob: "true"
  name: interactive-test-1
  namespace: runai-team-a
spec:
  command:
    value: start-notebook.sh --NotebookApp.base_url=/\${RUNAI_PROJECT}/\${RUNAI_JOB_NAME} --NotebookApp.token='' --port=8888
  gpu:
    value: "1"
  image:
    value: runai.jfrog.io/demo/jupyter-demo:latest
  imagePullPolicy:
    value: Always
  name:
    value: interactive-test-1`);

  // CLI command state - Updated for Run:ai CLI v2 syntax
  const [cliCommand, setCliCommand] = useState(`runai training pytorch submit llm-distributed-job1 \\
  --workers=2 \\
  -g 2 \\
  -i kubeflow/tf-mnist-with-summaries:latest \\
  -p llm-training1 \\
  --command -- python /var/tf_mnist/mnist_with_summaries.py --epochs 1000000`);

  const [workloadName, setWorkloadName] = useState('my-training-job');

  const parseYamlToWorkload = (yaml: string): WorkloadSubmission => {
    try {
      console.log('[parseYamlToWorkload] Starting to parse YAML:', yaml);
      // Enhanced YAML parsing for Run:ai job spec
      const lines = yaml.split('\n');
      console.log('[parseYamlToWorkload] YAML lines:', lines);
      const workload: Partial<WorkloadSubmission> = {
        resources: { gpu: 1, cpu: 0, memory: 0, port: 8080 }
      };



      let inMetadata = false;
      let inSpec = false;
      let inCommand = false;
      let inImage = false;
      let inGpu = false;
      let inName = false;
      let inPort = false;
      let inPortsSection = false;
      let inPortItems = false;
      let inPortValue = false;
      let inWorkingDir = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;

        console.log(`[parseYamlToWorkload] Line ${i}: "${trimmed}" (indent: ${indent})`);

        // Parse kind to determine workload type
        if (trimmed.startsWith('kind:')) {
          const kind = trimmed.split(':')[1].trim();
          switch (kind) {
            case 'TrainingWorkload':
              workload.type = 'training';
              break;
            case 'InteractiveWorkload':
              workload.type = 'interactive';
              break;
            case 'InferenceWorkload':
              workload.type = 'inference';
              break;
            default:
              workload.type = 'interactive'; // Default to interactive
          }
        }

        // Track sections
        if (trimmed === 'metadata:') {
          inMetadata = true;
          inSpec = false;
          console.log('[parseYamlToWorkload] Entered metadata section');
        } else if (trimmed === 'spec:') {
          inSpec = true;
          inMetadata = false;
          console.log('[parseYamlToWorkload] Entered spec section');
        } else if (indent === 0 && trimmed.includes(':')) {
          inMetadata = false;
          inSpec = false;
          console.log('[parseYamlToWorkload] Exited sections due to root level field:', trimmed);
        }

        // Parse metadata.name
        if (inMetadata && trimmed.startsWith('name:')) {
          workload.name = trimmed.split(':')[1].trim();
          console.log(`[parseYamlToWorkload] Found metadata name: ${workload.name}`);
        }

        // Parse namespace for project
        if (inMetadata && trimmed.startsWith('namespace:')) {
          const namespace = trimmed.split(':')[1].trim();
          // Extract project from namespace (e.g., "runai-team-a" -> "team-a")
          workload.project = namespace.replace('runai-', '') || 'default';
        }

        // Parse spec fields
        if (inSpec) {
          if (trimmed.startsWith('image:')) {
            inImage = true;
            inCommand = false;
            inGpu = false;
            inName = false;
            console.log('[parseYamlToWorkload] Detected image field in spec');

            // Check if there's an inline value after the colon
            const inlineValue = trimmed.split('image:')[1].trim().replace(/['"]/g, '');
            if (inlineValue && !inlineValue.startsWith('value:')) {
              workload.image = inlineValue;
              console.log(`[parseYamlToWorkload] Set image to inline value: ${inlineValue}`);
              inImage = false; // Reset since we got the value
            }
          } else if (trimmed.startsWith('command:')) {
            inCommand = true;
            inImage = false;
            inGpu = false;
            inName = false;
            console.log('[parseYamlToWorkload] Detected command field in spec');

            // Check if there's an inline value after the colon
            const inlineValue = trimmed.split('command:')[1].trim().replace(/['"]/g, '');
            if (inlineValue && !inlineValue.startsWith('value:')) {
              workload.command = [inlineValue];
              console.log(`[parseYamlToWorkload] Set command to inline value: ${inlineValue}`);
              inCommand = false; // Reset since we got the value
            }
          } else if (trimmed.startsWith('gpu:')) {
            inGpu = true;
            inImage = false;
            inCommand = false;
            inName = false;
            inPort = false;
            console.log('[parseYamlToWorkload] Detected gpu field in spec');

            // Check if there's an inline value after the colon
            const inlineValue = trimmed.split('gpu:')[1].trim().replace(/['"]/g, '');
            if (inlineValue && !inlineValue.startsWith('value:')) {
              workload.resources!.gpu = parseFloat(inlineValue) || 1;
              console.log(`[parseYamlToWorkload] Set GPU to inline value: ${workload.resources!.gpu}`);
              inGpu = false; // Reset since we got the value
            }
          } else if (trimmed.startsWith('ports:')) {
            inPortsSection = true;
            inImage = false;
            inCommand = false;
            inGpu = false;
            inName = false;
            inPort = false;
            console.log('[parseYamlToWorkload] Detected ports section');
          } else if (inPortsSection && trimmed.startsWith('items:')) {
            inPortItems = true;
            console.log('[parseYamlToWorkload] Detected ports items section');
          } else if (inPortItems && (trimmed.startsWith('port1:') || trimmed.match(/^port\d+:/))) {
            console.log('[parseYamlToWorkload] Detected port item:', trimmed);
          } else if (inPortItems && trimmed.startsWith('value:')) {
            inPortValue = true;
            console.log('[parseYamlToWorkload] Detected port value section');
          } else if (inPortItems && (trimmed.startsWith('port1:') || trimmed.match(/^port\d+:/))) {
            console.log('[parseYamlToWorkload] Detected port item:', trimmed);
          } else if (inPortItems && trimmed.startsWith('value:')) {
            inPortValue = true;
            console.log('[parseYamlToWorkload] Detected port value section');
          } else if (inPortValue && trimmed.startsWith('container:')) {
            inPort = true;
            inImage = false;
            inCommand = false;
            inName = false;
            inGpu = false;
            console.log('[parseYamlToWorkload] Detected container port field in port value section');

            // Check if there's an inline value after the colon
            const inlineValue = trimmed.split('container:')[1].trim().replace(/['"]/g, '');
            if (inlineValue && !inlineValue.startsWith('value:')) {
              workload.resources!.port = parseInt(inlineValue) || 8000;
              console.log(`[parseYamlToWorkload] Set port to inline value: ${workload.resources!.port}`);
              inPort = false; // Reset since we got the value
            }
          } else if (trimmed.startsWith('name:')) {
            inName = true;
            inImage = false;
            inCommand = false;
            inGpu = false;
            console.log('[parseYamlToWorkload] Detected name field in spec');

            // Check if there's an inline value after the colon
            const inlineValue = trimmed.split('name:')[1].trim().replace(/['"]/g, '');
            if (inlineValue && !inlineValue.startsWith('value:') && !workload.name) {
              workload.name = inlineValue;
              console.log(`[parseYamlToWorkload] Set name to inline value: ${inlineValue}`);
              inName = false; // Reset since we got the value
            }
          }

          // Parse nested values - handle both inline and next-line formats
          if (trimmed.startsWith('value:')) {
            let value = trimmed.split('value:')[1].trim().replace(/['"]/g, '');

            // If value is empty, it might be on the next line
            if (!value && i + 1 < lines.length) {
              const nextLine = lines[i + 1].trim();
              if (nextLine && !nextLine.startsWith('-') && !nextLine.includes(':')) {
                value = nextLine.replace(/['"]/g, '');
                console.log(`[parseYamlToWorkload] Found value on next line: "${value}"`);
              }
            }

            console.log(`[parseYamlToWorkload] Found value: "${value}" for context - inImage: ${inImage}, inCommand: ${inCommand}, inGpu: ${inGpu}, inName: ${inName}, inPort: ${inPort}, inPortsSection: ${inPortsSection}, inPortItems: ${inPortItems}, inPortValue: ${inPortValue}`);

            if (inImage && value) {
              workload.image = value;
              console.log(`[parseYamlToWorkload] Set image to: ${value}`);
              inImage = false; // Reset flag after capturing value
            } else if (inCommand && value) {
              workload.command = [value];
              console.log(`[parseYamlToWorkload] Set command to: ${value}`);
              inCommand = false; // Reset flag after capturing value
            } else if (inGpu && value) {
              // Handle fractional GPU values (e.g., "0.5")
              workload.resources!.gpu = parseFloat(value) || 1;
              console.log(`[parseYamlToWorkload] Set GPU to: ${workload.resources!.gpu}`);
              inGpu = false; // Reset flag after capturing value
            } else if (inName && value) {
              // Use spec.name.value as fallback if metadata.name not found
              if (!workload.name) {
                workload.name = value;
                console.log(`[parseYamlToWorkload] Set name to: ${value}`);
              }
              inName = false; // Reset flag after capturing value
            } else if (inPort && value) {
              workload.resources!.port = parseInt(value) || 8000;
              console.log(`[parseYamlToWorkload] Set port to: ${workload.resources!.port}`);
              inPort = false; // Reset flag after capturing value
              inPortValue = false; // Reset port value section flag
              inPortItems = false; // Reset port items flag
              inPortsSection = false; // Reset ports section flag
            }
          }
        }

        // Legacy parsing for simple YAML format
        if (!inMetadata && !inSpec) {
          if (trimmed.startsWith('name:') && !workload.name) {
            workload.name = trimmed.split(':')[1].trim();
          } else if (trimmed.startsWith('image:') && !workload.image) {
            workload.image = trimmed.split(':')[1].trim();
          } else if (trimmed.startsWith('project:')) {
            workload.project = trimmed.split(':')[1].trim();
          }
        }
      }

      const result = {
        name: workload.name || 'unnamed-job',
        project: workload.project || 'default',
        type: workload.type || 'interactive', // Use detected type or default to interactive
        image: workload.image || '',
        command: workload.command || [],
        args: workload.args || [],
        resources: workload.resources!,
        env: {},
        volumes: [],
        priority: 0,
        preemptible: false,
        autoRetry: true,
        maxRetries: 3
      } as WorkloadSubmission;

      console.log('[parseYamlToWorkload] Parsed workload object before return:', workload);
      console.log('[parseYamlToWorkload] Final result:', result);
      console.log('[parseYamlToWorkload] Validation check - name:', result.name, 'image:', result.image, 'type:', result.type);
      return result;
    } catch (error) {
      throw new Error('Failed to parse YAML: ' + error);
    }
  };

  const parseCliToWorkload = (cli: string): WorkloadSubmission => {
    try {
      const workload: WorkloadSubmission = {
        name: 'unnamed-job',
        project: 'default',
        type: 'interactive', // Default to interactive for workspace commands
        image: '',
        command: [],
        args: [],
        resources: { gpu: 1, cpu: 0, memory: 0, port: 8080 },
        env: {},
        volumes: [],
        priority: 0,
        preemptible: false,
        autoRetry: true,
        maxRetries: 3
      };

      console.log('[parseCliToWorkload] Parsing CLI command:', cli);

      // Parse CLI arguments - support both v1 and v2 syntax
      const args = cli.split(/\s+/).filter(arg => arg.length > 0);

      // Detect CLI version and workload type from command structure
      let workloadNameIndex = -1;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // CLI v2: runai <workload-type> submit <name>
        if (arg === 'workspace' && i + 1 < args.length && args[i + 1] === 'submit') {
          workload.type = 'interactive';
          if (i + 2 < args.length) {
            workloadNameIndex = i + 2;
          }
        } else if (arg === 'training' && i + 1 < args.length && args[i + 1] === 'submit') {
          workload.type = 'training';
          if (i + 2 < args.length) {
            workloadNameIndex = i + 2;
          }
        } else if (arg === 'training' && i + 1 < args.length && i + 2 < args.length && args[i + 2] === 'submit') {
          // Distributed training: runai training <framework> submit <name>
          const framework = args[i + 1];
          workload.type = 'distributed';

          let distributedFramework: 'PyTorchJob' | 'TensorFlowJob' | 'MPIJob' | 'XGBoostJob' = 'PyTorchJob';
          switch (framework.toLowerCase()) {
            case 'pytorch':
              distributedFramework = 'PyTorchJob';
              break;
            case 'tensorflow':
            case 'tf':
              distributedFramework = 'TensorFlowJob';
              break;
            case 'mpi':
              distributedFramework = 'MPIJob';
              break;
            case 'xgboost':
              distributedFramework = 'XGBoostJob';
              break;
            default:
              distributedFramework = 'PyTorchJob';
          }

          if (!workload.distributed) {
            workload.distributed = { framework: distributedFramework, workers: 1 };
          } else {
            workload.distributed.framework = distributedFramework;
          }
          if (i + 3 < args.length) {
            workloadNameIndex = i + 3;
          }
        } else if (arg === 'inference' && i + 1 < args.length && args[i + 1] === 'submit') {
          workload.type = 'inference';
          if (i + 2 < args.length) {
            workloadNameIndex = i + 2;
          }
        }
        // CLI v1: runai submit --name <name>
        else if (arg === 'submit' && i + 1 < args.length && !args[i + 1].startsWith('-')) {
          // This might be CLI v2 with positional name
          workloadNameIndex = i + 1;
        }
      }

      // Extract workload name from positional argument (CLI v2)
      if (workloadNameIndex >= 0 && workloadNameIndex < args.length) {
        workload.name = args[workloadNameIndex];
        console.log('[parseCliToWorkload] Found workload name:', workload.name);
      }

      // Parse flags
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        // CLI v1 flags
        if (arg === '--name' && i + 1 < args.length) {
          workload.name = args[i + 1];
        } else if (arg === '--project' && i + 1 < args.length) {
          workload.project = args[i + 1];
        } else if (arg === '--image' && i + 1 < args.length) {
          workload.image = args[i + 1];
        } else if (arg === '--gpu' && i + 1 < args.length) {
          workload.resources.gpu = parseFloat(args[i + 1]) || 1;
        }

        // CLI v2 flags
        else if ((arg === '-p' || arg === '--project') && i + 1 < args.length) {
          workload.project = args[i + 1];
        } else if ((arg === '-i' || arg === '--image') && i + 1 < args.length) {
          workload.image = args[i + 1];
        } else if (arg === '--gpu-portion-request' && i + 1 < args.length) {
          workload.resources.gpu = parseFloat(args[i + 1]) || 1;
        } else if (arg === '--gpu-request' && i + 1 < args.length) {
          workload.resources.gpu = parseInt(args[i + 1]) || 1;
        } else if (arg === '--cpu-request' && i + 1 < args.length) {
          workload.resources.cpu = parseInt(args[i + 1]) || 2;
        } else if (arg === '--memory-request' && i + 1 < args.length) {
          const memStr = args[i + 1];
          workload.resources.memory = parseInt(memStr.replace(/[GgMmKk]/g, '')) || 8;
        } else if (arg === '--environment' && i + 1 < args.length) {
          // Parse environment variables: --environment KEY=VALUE
          const envPair = args[i + 1];
          const [key, ...valueParts] = envPair.split('=');
          if (key && valueParts.length > 0) {
            if (!workload.env) {
              workload.env = {};
            }
            workload.env[key] = valueParts.join('=');
          }
        }

        // Distributed training flags
        else if (arg === '--workers' && i + 1 < args.length) {
          const workers = parseInt(args[i + 1]) || 1;
          if (!workload.distributed) {
            workload.distributed = { framework: 'PyTorchJob', workers };
          } else {
            workload.distributed.workers = workers;
          }
          console.log('[parseCliToWorkload] Set workers to:', workers);
        } else if (arg.startsWith('--workers=')) {
          const workers = parseInt(arg.split('=')[1]) || 1;
          if (!workload.distributed) {
            workload.distributed = { framework: 'PyTorchJob', workers };
          } else {
            workload.distributed.workers = workers;
          }
          console.log('[parseCliToWorkload] Set workers to:', workers);
        } else if ((arg === '-g' || arg === '--gpu') && i + 1 < args.length) {
          // For distributed training, this sets GPU per worker/master
          const gpuCount = parseFloat(args[i + 1]) || 1;
          workload.resources.gpu = gpuCount;
          if (workload.distributed) {
            workload.distributed.workerGpu = gpuCount;
            workload.distributed.masterGpu = gpuCount;
          }
          console.log('[parseCliToWorkload] Set GPU count to:', gpuCount);
        }

        // Legacy flags
        else if (arg === '--cpu' && i + 1 < args.length) {
          workload.resources.cpu = parseInt(args[i + 1]) || 2;
        } else if (arg === '--memory' && i + 1 < args.length) {
          const memStr = args[i + 1];
          workload.resources.memory = parseInt(memStr.replace(/[GgMm]/g, '')) || 8;
        } else if (arg === '--command' && i + 1 < args.length) {
          // Handle both formats:
          // --command python script.py --args
          // --command -- python script.py --args
          let commandStart = i + 1;

          // If the next argument is '--', skip it and start from the argument after
          if (args[commandStart] === '--') {
            commandStart = i + 2;
          }

          // Take everything from commandStart to the end
          workload.command = args.slice(commandStart);
          console.log('[parseCliToWorkload] Set command to:', workload.command);
          i = args.length; // Skip to end since we consumed all remaining args
        }
      }

      console.log('[parseCliToWorkload] Parsed workload:', {
        name: workload.name,
        project: workload.project,
        type: workload.type,
        image: workload.image,
        resources: workload.resources,
        env: workload.env
      });

      return workload;
    } catch (error) {
      console.error('[parseCliToWorkload] Error parsing CLI command:', error);
      throw new Error('Failed to parse CLI command: ' + error);
    }
  };

  const getCurrentWorkload = (): WorkloadSubmission | null => {
    try {
      if (tabValue === 0) {
        // YAML tab
        return parseYamlToWorkload(yamlInput);
      } else {
        // CLI tab
        return parseCliToWorkload(cliCommand);
      }
    } catch (error) {
      return null;
    }
  };

  const getBestClusterInfo = () => {
    if (!client || clusters.length === 0) return null;

    const workload = getCurrentWorkload();
    if (!workload) return null;

    const bestCluster = client.findBestClusterForWorkload(workload);
    return bestCluster;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!client) {
      setError('API client not initialized');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const workload = getCurrentWorkload();
      if (!workload) {
        throw new Error('Failed to parse workload configuration');
      }

      console.log('[handleSubmit] Parsed workload for validation:', workload);
      console.log('[handleSubmit] workload.name:', workload.name);
      console.log('[handleSubmit] workload.image:', workload.image);

      if (!workload.name || !workload.image) {
        throw new Error('Workload name and image are required');
      }

      console.log('[WorkloadSubmissionForm] Submitting workload:', workload);

      // Submit to optimal cluster
      const result = await client.submitJobToOptimalCluster(workload);

      toast.success(`Workload "${workload.name}" submitted successfully to cluster ${result.clusterId}`);

      if (onSubmissionSuccess) {
        onSubmissionSuccess(result);
      }

    } catch (err: any) {
      const errorMessage = err.message || 'Failed to submit workload';
      setError(errorMessage);
      toast.error(errorMessage);
      console.error('Workload submission error:', err);
      console.error('Error details:', {
        message: err.message,
        response: err.response?.data,
        status: err.response?.status,
        statusText: err.response?.statusText,
        stack: err.stack
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTabChange = (event: React.SyntheticEvent, newValue: number) => {
    setTabValue(newValue);
    setError(null);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  const bestCluster = getBestClusterInfo();
  const currentWorkload = getCurrentWorkload();

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Submit New Workload
        </Typography>

        {bestCluster && currentWorkload && (
          <Alert severity="info" sx={{ mb: 2 }}>
            <Box display="flex" alignItems="center" gap={1}>
              <InfoIcon fontSize="small" />
              <Typography variant="body2">
                Workload <strong>{currentWorkload.name}</strong> will be submitted to cluster <strong>{bestCluster.name}</strong>
                ({bestCluster.gpuResources.available} available GPUs)
              </Typography>
            </Box>
          </Alert>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}>
          <Tabs value={tabValue} onChange={handleTabChange} aria-label="workload submission tabs">
            <Tab
              icon={<DescriptionIcon />}
              label="YAML Configuration"
              id="workload-tab-0"
              aria-controls="workload-tabpanel-0"
            />
            <Tab
              icon={<TerminalIcon />}
              label="Run:ai CLI Command"
              id="workload-tab-1"
              aria-controls="workload-tabpanel-1"
            />
          </Tabs>
        </Box>

        <TabPanel value={tabValue} index={0}>
          <Box>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="subtitle2">
                YAML Job Configuration
              </Typography>
              <Tooltip title="Copy YAML to clipboard">
                <IconButton onClick={() => copyToClipboard(yamlInput)} size="small">
                  <FileCopyIcon />
                </IconButton>
              </Tooltip>
            </Box>
            <TextField
              fullWidth
              multiline
              rows={20}
              value={yamlInput}
              onChange={(e) => setYamlInput(e.target.value)}
              variant="outlined"
              sx={{
                fontFamily: 'monospace',
                '& .MuiInputBase-input': {
                  fontFamily: 'monospace',
                  fontSize: '0.875rem'
                }
              }}
              placeholder="Paste your Run:ai job YAML configuration here..."
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              Paste a valid Run:ai job YAML configuration. The system will automatically select the optimal cluster.
            </Typography>
          </Box>
        </TabPanel>

        <TabPanel value={tabValue} index={1}>
          <Box>
            <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
              <Typography variant="subtitle2">
                Run:ai CLI Command
              </Typography>
              <Tooltip title="Copy command to clipboard">
                <IconButton onClick={() => copyToClipboard(cliCommand)} size="small">
                  <FileCopyIcon />
                </IconButton>
              </Tooltip>
            </Box>
            <TextField
              fullWidth
              multiline
              rows={8}
              value={cliCommand}
              onChange={(e) => setCliCommand(e.target.value)}
              variant="outlined"
              sx={{
                fontFamily: 'monospace',
                '& .MuiInputBase-input': {
                  fontFamily: 'monospace',
                  fontSize: '0.875rem'
                }
              }}
              placeholder="runai submit --name my-job --project default --image pytorch/pytorch:latest --gpu 1 ..."
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              Enter a Run:ai CLI submit command. The system will parse it and submit to the optimal cluster.
            </Typography>
          </Box>
        </TabPanel>

        <Divider sx={{ my: 3 }} />

        {/* Submit Button */}
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
          <Button
            variant="outlined"
            onClick={() => {
              if (tabValue === 0) {
                copyToClipboard(yamlInput);
              } else {
                copyToClipboard(cliCommand);
              }
            }}
            startIcon={<FileCopyIcon />}
          >
            Copy to Clipboard
          </Button>
          <Button
            type="submit"
            variant="contained"
            onClick={handleSubmit}
            disabled={isSubmitting || !currentWorkload}
            startIcon={isSubmitting ? <CircularProgress size={20} /> : <PlayArrowIcon />}
            size="large"
          >
            {isSubmitting ? 'Submitting...' : 'Submit to Optimal Cluster'}
          </Button>
        </Box>
      </CardContent>
    </Card>
  );
};

export default WorkloadSubmissionForm;
