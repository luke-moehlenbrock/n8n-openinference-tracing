'use strict'
/**
 * This file is used to instrument the n8n application with OpenTelemetry.
 * It's run by the docker entrypoint.sh script before starting n8n.
 *
 * Traces are sent to Arize using OpenInference semantic conventions.
 * See: https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 *
 * n8n Workflow and Node execution are instrumented.
 * LangChain sub-node operations (LLM calls, tool invocations, retriever queries, etc.)
 * are automatically traced via @arizeai/openinference-instrumentation-langchain.
 */

// Guard against multiple initializations (n8n might load this module multiple times)
// Use multiple methods for maximum reliability across different Node.js contexts
const ALREADY_INITIALIZED =
  global.__n8nTracingInitialized ||
  process.env.__N8N_TRACING_INITIALIZED === 'true' ||
  process.__n8nOtelSDKStarted;

if (ALREADY_INITIALIZED) {
  console.log(`[Tracing]: Already initialized in this process (PID: ${process.pid}), skipping duplicate initialization`)
  module.exports = {}; // Export empty object and exit
} else {
  // Mark as initialized using multiple methods for different contexts
  global.__n8nTracingInitialized = true;
  process.env.__N8N_TRACING_INITIALIZED = 'true';
  process.__n8nOtelSDKStarted = true;
  console.log(`[Tracing]: First initialization in process (PID: ${process.pid}, PPID: ${process.ppid || 'unknown'})`)

  // Proceed with initialization
  initializeTracing();
}

function initializeTracing() {

const opentelemetry = require('@opentelemetry/sdk-node')
const { OTLPTraceExporter: OTLPTraceExporterHTTP } = require('@opentelemetry/exporter-trace-otlp-http')
const { OTLPTraceExporter: OTLPTraceExporterGRPC } = require('@opentelemetry/exporter-trace-otlp-grpc')
const {
  getNodeAutoInstrumentations,
} = require('@opentelemetry/auto-instrumentations-node')
const { registerInstrumentations } = require('@opentelemetry/instrumentation')
const { resourceFromAttributes } = require('@opentelemetry/resources')
const {
  SEMRESATTRS_SERVICE_NAME,
} = require('@opentelemetry/semantic-conventions')
const winston = require('winston')
const {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
} = require('@opentelemetry/api')
const { flatten } = require('flat') // flattens objects into a single level
const { envDetector, hostDetector, processDetector } = require('@opentelemetry/resources')
const { mapNodeToSpanKind } = require('./openinference-mapper')

// Helper to parse boolean env vars
function envBool(name, def = false) {
  const v = (process.env[name] ?? '').toString().trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  return def
}

// Logs are opt-in. Respect OTEL_LOGS_EXPORTER=otlp as spec; otherwise allow a custom toggle.
function shouldEnableOtelLogs() {
  const logsExporter = (process.env.OTEL_LOGS_EXPORTER || '').toLowerCase()
  if (logsExporter === 'otlp' || logsExporter === 'otlp_http' || logsExporter === 'otlp-http') return true
  if (logsExporter === 'none' || logsExporter === '') return envBool('N8N_OTEL_EXPORT_LOGS', false)
  return envBool('N8N_OTEL_EXPORT_LOGS', false)
}

const LOGPREFIX = '[Tracing]'
const LOG_LEVEL = getEnv('TRACING_LOG_LEVEL', 'info')
const DEBUG = LOG_LEVEL === 'debug'
// If true, disable auto-instrumentations and emit ONLY the manual workflow + node spans.
const ONLY_WORKFLOW_SPANS = envBool('TRACING_ONLY_WORKFLOW_SPANS', false)
// Enable mapping n8n node types to OpenInference span kinds
const MAP_OPENINFERENCE_SPAN_KINDS = envBool(
  'TRACING_MAP_OPENINFERENCE_SPAN_KINDS',
  true,
)
// If true, incorporate OpenInference span kind into node span name: n8n.node.<kind>.execute
const SPAN_KIND_IN_NODE_SPAN_NAME = envBool(
  'TRACING_SPAN_KIND_IN_NODE_SPAN_NAME',
  false,
)
// If true, span name for nodes becomes the actual n8n node name (higher cardinality but more readable)
const USE_NODE_NAME_SPAN = envBool('TRACING_USE_NODE_NAME_SPAN', true)

// Toggle dynamic workflow trace naming (otherwise keep low-cardinality constant name)
const DYNAMIC_WORKFLOW_TRACE_NAME = envBool(
  'TRACING_DYNAMIC_WORKFLOW_TRACE_NAME',
  false,
)
// Optional explicit pattern overrides boolean flag. Supports placeholders:
// {workflowId} {workflowName} {executionId} {sessionId}
const WORKFLOW_SPAN_NAME_PATTERN = process.env.TRACING_WORKFLOW_SPAN_NAME_PATTERN
// Enable LangChain sub-node instrumentation (traces internal LLM/tool/retriever calls)
const INSTRUMENT_LANGCHAIN = envBool('TRACING_INSTRUMENT_LANGCHAIN', true)
// Capture workflow & node input/output content for OpenInference enrichment
const CAPTURE_IO = envBool('TRACING_CAPTURE_INPUT_OUTPUT', true)
const MAX_IO_CHARS = parseInt(process.env.TRACING_MAX_IO_CHARS || '12000', 10)

// Arize configuration
const ARIZE_SPACE_ID = getEnv('ARIZE_SPACE_ID', '', false)
const ARIZE_API_KEY = getEnv('ARIZE_API_KEY', '', false)
const ARIZE_PROJECT_NAME = getEnv('ARIZE_PROJECT_NAME', 'n8n', false)
// Protocol: 'grpc' (default) or 'http'
const ARIZE_PROTOCOL = getEnv('ARIZE_PROTOCOL', 'grpc', false)
// Default endpoint for Arize
const ARIZE_ENDPOINT = getEnv('ARIZE_ENDPOINT', 'https://otlp.arize.com', false)

function sanitizeSegment(value, def = 'unknown') {
  if (!value) return def
  return String(value)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .slice(0, 80) || def
}

function buildWorkflowSpanName({
  workflowId,
  workflowName,
  executionId,
  sessionId,
}) {
  // Pattern has highest precedence
  if (WORKFLOW_SPAN_NAME_PATTERN && WORKFLOW_SPAN_NAME_PATTERN.trim()) {
    const name = WORKFLOW_SPAN_NAME_PATTERN
      .replace(/\{workflowId\}/g, sanitizeSegment(workflowId, 'wf'))
      .replace(/\{workflowName\}/g, sanitizeSegment(workflowName, 'workflow'))
      .replace(/\{executionId\}/g, sanitizeSegment(executionId, 'exec'))
      .replace(/\{sessionId\}/g, sanitizeSegment(sessionId, 'sess'))
      .slice(0, 180)
    return name || 'n8n.workflow.execute'
  }
  if (DYNAMIC_WORKFLOW_TRACE_NAME) {
    return `${sanitizeSegment(workflowId, 'wf')}-${sanitizeSegment(
      workflowName,
      'workflow',
    )}-${sanitizeSegment(executionId, 'exec')}`
  }
  // Low-cardinality default
  return 'n8n.workflow.execute'
}

// -------------- IO Helper Utilities --------------
function safeJSONStringify(obj) {
  try {
    return JSON.stringify(obj)
  } catch (e) {
    return JSON.stringify({ _serializationError: String(e) })
  }
}

function truncateIO(str) {
  if (str == null) return ''
  if (typeof str !== 'string') str = String(str)
  if (str.length <= MAX_IO_CHARS) return str
  return (
    str.slice(0, MAX_IO_CHARS) + `...[truncated ${str.length - MAX_IO_CHARS} chars]`
  )
}

/**
 * Extract the actual resolved input data flowing into a node.
 *
 * Uses executionData.data (the real input items from connections) rather than
 * node.parameters (which contains raw n8n expressions like ={{ $json.chatInput }}).
 *
 * @param {object} executionData - The IExecuteData passed to runNode
 * @returns {object|undefined} The input data object, or undefined if none
 */
function extractNodeInputFromExecutionData(executionData) {
  try {
    // executionData.data is ITaskDataConnections: { main?: INodeExecutionData[][] }
    const mainInputs = executionData?.data?.main
    if (!mainInputs || !mainInputs.length) return undefined

    // Collect items from all input connections
    const allItems = []
    for (const connection of mainInputs) {
      if (!connection) continue
      for (const item of connection) {
        if (item?.json) allItems.push(item.json)
      }
    }
    if (!allItems.length) return undefined

    // For single-item input, return it directly for cleaner display
    if (allItems.length === 1) return allItems[0]
    return allItems
  } catch (e) {
    return { _error: String(e) }
  }
}

/**
 * Extract the output data from a node execution result.
 *
 * The result structure from runNode can vary:
 * - IRunNodeResponse: { data: INodeExecutionData[][] | null }
 *   where data[0] = first output connection items, data[1] = second, etc.
 *   Each item has { json: {...}, binary?: {...} }
 *
 * @param {object} result - The IRunNodeResponse from runNode
 * @returns {object|undefined} The output data object, or undefined if none
 */
function extractNodeOutput(result) {
  try {
    if (!result) return undefined

    // Collect output items from the result
    const allItems = []

    const data = result.data
    if (data && Array.isArray(data)) {
      // Standard: data is INodeExecutionData[][] (array of output connections)
      for (const connection of data) {
        if (!Array.isArray(connection)) continue
        for (const item of connection) {
          if (item?.json) allItems.push(item.json)
        }
      }
    } else if (data && typeof data === 'object' && !Array.isArray(data)) {
      // Fallback: data might be wrapped in { main: [...] } for some node types
      const main = data.main
      if (Array.isArray(main)) {
        for (const connection of main) {
          if (!Array.isArray(connection)) continue
          for (const item of connection) {
            if (item?.json) allItems.push(item.json)
          }
        }
      }
    }

    if (!allItems.length) {
      if (DEBUG) {
        console.debug(`${LOGPREFIX}: extractNodeOutput - no items found. result keys: ${result ? Object.keys(result) : 'null'}, data type: ${typeof data}, isArray: ${Array.isArray(data)}`)
      }
      return undefined
    }

    // Extract primary output text for convenience
    const first = allItems[0]
    let primary
    if (first && typeof first === 'object') {
      primary =
        first.output ||
        first.completion ||
        first.text ||
        first.result ||
        first.response ||
        undefined
    }
    return { primary, items: allItems.slice(0, 10) } // limit items for size
  } catch (e) {
    return { _error: String(e) }
  }
}

// Process all OTEL_* environment variables to strip quotes.
// Fixes issues with quotes in Docker env vars breaking the OTLP exporter.
processOtelEnvironmentVariables()

console.log(`${LOGPREFIX}: Starting n8n OpenTelemetry instrumentation (Arize / OpenInference)`)

// Configure OpenTelemetry
// Turn off auto-instrumentation for dns, net, tls, fs, pg
let autoInstrumentations
if (!ONLY_WORKFLOW_SPANS) {
  autoInstrumentations = getNodeAutoInstrumentations({
    '@opentelemetry/instrumentation-dns': { enabled: false },
    '@opentelemetry/instrumentation-net': { enabled: false },
    '@opentelemetry/instrumentation-tls': { enabled: false },
    '@opentelemetry/instrumentation-fs': { enabled: false },
    '@opentelemetry/instrumentation-pg': { enabled: false },
  })
  registerInstrumentations({ instrumentations: [autoInstrumentations] })
  console.log(`${LOGPREFIX}: Auto-instrumentations enabled`)
} else {
  console.log(`${LOGPREFIX}: TRACING_ONLY_WORKFLOW_SPANS=true -> auto-instrumentations DISABLED (no HTTP/DB spans)`)
}

// Setup n8n telemetry
console.log(`${LOGPREFIX}: Setting up n8n telemetry`)
setupN8nOpenTelemetry()

// Configure Winston logger to log to console
console.log(`${LOGPREFIX}: Configuring Winston logger with level: ${LOG_LEVEL}`)
setupWinstonLogger(LOG_LEVEL)

// Configure and start the OpenTelemetry SDK
console.log(
  `${LOGPREFIX}: Configuring OpenTelemetry SDK with log level: ${process.env.OTEL_LOG_LEVEL}`,
)
const sdk = setupOpenTelemetryNodeSDK()

sdk.start()
console.log(`${LOGPREFIX}: OpenTelemetry SDK started successfully`)

// ---- LangChain sub-node instrumentation (OpenInference) ----
// Must be initialized AFTER sdk.start() so the tracer provider is registered
// and the LangChainInstrumentation gets a real tracer (not a NoOp).
// Patches @langchain/core's CallbackManager to inject a tracer that creates
// OpenInference-compliant spans for every internal LangChain operation
// (LLM calls, tool invocations, retriever queries, agent loops, etc.)
if (INSTRUMENT_LANGCHAIN) {
  try {
    const { LangChainInstrumentation } = require('@arizeai/openinference-instrumentation-langchain')
    // Use the public export path (not the internal dist/ path) because
    // @langchain/core@1.x uses package.json "exports" which blocks direct dist/ access.
    // This resolves to the .cjs file via the exports map and is the same module instance
    // that n8n's own code uses, so the patch applies to the same CallbackManager.
    const callbackManagerModule = require('@langchain/core/callbacks/manager')

    const lcInstrumentation = new LangChainInstrumentation()
    lcInstrumentation.manuallyInstrument(callbackManagerModule)

    console.log(`${LOGPREFIX}: LangChain OpenInference instrumentation enabled (sub-node tracing active)`)
  } catch (e) {
    // Gracefully degrade: @langchain/core may not be available in non-AI n8n setups
    console.warn(`${LOGPREFIX}: LangChain instrumentation not available: ${e.message}`)
    if (DEBUG) {
      console.warn(`${LOGPREFIX}: LangChain instrumentation error details:`, e)
    }
  }
} else {
  console.log(`${LOGPREFIX}: LangChain instrumentation disabled (TRACING_INSTRUMENT_LANGCHAIN=false)`)
}

// Add warning handler for OTLP export timeouts (non-critical)
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return; // Ignore experimental warnings
  if (warning.message && warning.message.includes('Request Timeout')) {
    console.warn(`${LOGPREFIX}: OTLP export timeout (non-critical) - telemetry data may be delayed`)
    if (DEBUG) {
      console.warn(`${LOGPREFIX}: OTLP timeout details:`, warning.message)
    }
  }
})

// Helper: derive a session id. For now we treat each execution as its own session.
function deriveSessionId(executionId) {
  return executionId || 'unknown'
}

////////////////////////////////////////////////////////////
// HELPER FUNCTIONS
////////////////////////////////////////////////////////////

/**
 * Get environment variable without surrounding quotes
 */
function getEnv(key, defaultValue = '', required = true) {
  const value = process.env[key] ?? defaultValue
  if (!value && required) {
    throw new Error(`Required environment variable ${key} is not set`)
  }
  return value ? value.replace(/^['"]|['"]$/g, '') : defaultValue
}

/**
 * Process all OTEL_* environment variables to strip quotes
 *
 * This ensures that all OpenTelemetry environment variables are properly
 * formatted without surrounding quotes that might cause configuration issues.
 */
function processOtelEnvironmentVariables() {
  console.log(`${LOGPREFIX}: Processing OTEL environment variables`)
  const envVars = process.env
  for (const key in envVars) {
    if (key.startsWith('OTEL_')) {
      try {
        // Get the value without quotes
        const cleanValue = getEnv(key, undefined, false)
        process.env[key] = cleanValue
        if (DEBUG) {
          console.log(`${LOGPREFIX}: Processed ${key}=${cleanValue}`)
        }
      } catch (error) {
        console.warn(`${LOGPREFIX}: Error processing ${key}: ${error.message}`)
      }
    }
  }

  // Set reasonable defaults for OTLP timeouts if not configured
  if (!process.env.OTEL_EXPORTER_OTLP_TIMEOUT && !process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT) {
    process.env.OTEL_EXPORTER_OTLP_TIMEOUT = '30000' // 30 seconds instead of default 10
    console.log(`${LOGPREFIX}: Set default OTLP timeout to 30 seconds`)
  }

  // Set batch export timeout if not configured
  if (!process.env.OTEL_BSP_EXPORT_TIMEOUT) {
    process.env.OTEL_BSP_EXPORT_TIMEOUT = '30000' // 30 seconds for batch span processor
    console.log(`${LOGPREFIX}: Set default batch export timeout to 30 seconds`)
  }
}

function awaitAttributes(detector) {
  return {
    async detect(config) {
      const resource = detector.detect(config)
      await resource.waitForAsyncAttributes?.()
      return resource
    },
  }
}

/**
 * Build the trace exporter for Arize.
 *
 * If ARIZE_SPACE_ID and ARIZE_API_KEY are set, configure the exporter to send
 * traces directly to Arize's OTLP endpoint with the appropriate headers.
 * Otherwise, fall back to standard OTEL_EXPORTER_OTLP_* env var configuration.
 */
function buildTraceExporter() {
  // If Arize credentials are provided, configure the exporter for Arize
  if (ARIZE_SPACE_ID && ARIZE_API_KEY) {
    const headers = {
      'space_id': ARIZE_SPACE_ID,
      'api_key': ARIZE_API_KEY,
    }

    if (ARIZE_PROTOCOL === 'http') {
      const httpEndpoint = ARIZE_ENDPOINT.replace(/\/$/, '') + '/v1/traces'
      console.log(`${LOGPREFIX}: Arize HTTP exporter -> ${httpEndpoint}`)
      return new OTLPTraceExporterHTTP({
        url: httpEndpoint,
        headers,
      })
    } else {
      // gRPC (default)
      console.log(`${LOGPREFIX}: Arize gRPC exporter -> ${ARIZE_ENDPOINT}`)
      return new OTLPTraceExporterGRPC({
        url: ARIZE_ENDPOINT,
        metadata: buildGrpcMetadata(headers),
      })
    }
  }

  // Fallback: use standard OTEL env vars (e.g. for local collectors or other backends)
  console.log(`${LOGPREFIX}: No Arize credentials found, using standard OTEL exporter env vars`)
  return new OTLPTraceExporterHTTP()
}

/**
 * Build gRPC Metadata object from a plain headers object.
 */
function buildGrpcMetadata(headers) {
  const grpc = require('@grpc/grpc-js')
  const metadata = new grpc.Metadata()
  for (const [key, value] of Object.entries(headers)) {
    metadata.add(key, value)
  }
  return metadata
}

/**
 * Configure and start the OpenTelemetry SDK
 */
function setupOpenTelemetryNodeSDK() {
  // Build resource attributes including OpenInference project name
  const resourceAttrs = {
    'openinference.project.name': ARIZE_PROJECT_NAME,
  }

  const traceExporter = buildTraceExporter()

  const sdkOptions = {
    resourceDetectors: [
      awaitAttributes(envDetector),
      awaitAttributes(processDetector),
      awaitAttributes(hostDetector),
    ],
    resource: resourceFromAttributes(resourceAttrs),
    traceExporter,
  }

  // Log configuration for debugging
  console.log(`${LOGPREFIX}: Arize project: ${ARIZE_PROJECT_NAME}`)
  console.log(`${LOGPREFIX}: Arize protocol: ${ARIZE_PROTOCOL}`)
  console.log(`${LOGPREFIX}: Arize endpoint: ${ARIZE_ENDPOINT}`)
  if (DEBUG) {
    console.log(`${LOGPREFIX}: Arize space_id configured: ${ARIZE_SPACE_ID ? 'Yes' : 'No'}`)
    console.log(`${LOGPREFIX}: Arize api_key configured: ${ARIZE_API_KEY ? 'Yes' : 'No'}`)
  }

  if (shouldEnableOtelLogs()) {
    // Lazy-require to avoid loading the exporter when disabled
    const { SimpleLogRecordProcessor } = opentelemetry.logs
    const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
    sdkOptions.logRecordProcessors = [
      new SimpleLogRecordProcessor(new OTLPLogExporter()),
    ]
    console.log('[Tracing]: OTEL logs exporter enabled')
  } else {
    console.log('[Tracing]: OTEL logs exporter disabled')
  }

  return new opentelemetry.NodeSDK(sdkOptions)
}

/**
 * Configure the Winston logger
 *
 * - Logs uncaught exceptions to the console
 * - Logs unhandled promise rejections to the console
 * - Logs errors to the console
 */
function setupWinstonLogger(logLevel = 'info') {
  const logger = winston.createLogger({
    level: logLevel,
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
  })

  process.on('uncaughtException', async (err) => {
    console.error('Uncaught Exception', err) // Log error object to console
    logger.error('Uncaught Exception', { error: err })
    const span = opentelemetry.trace.getActiveSpan()
    if (span) {
      span.recordException(err)
      span.setStatus({ code: 2, message: err.message })
    }
    try {
      await sdk.forceFlush()
    } catch (flushErr) {
      logger.error('Error flushing telemetry data', { error: flushErr })
    }
    process.exit(1)
  })

  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', { error: reason })
  })
}

/**
 * Patches n8n workflow and node execution to wrap the entire run in a workflow-level span.
 *
 * Uses OpenInference semantic conventions:
 * - openinference.span.kind: CHAIN (for workflow) or mapped kind (for nodes)
 * - input.value / output.value: Captured I/O
 * - input.mime_type / output.mime_type: application/json
 * - session.id: Execution-derived session
 * - metadata: JSON string of n8n-specific attributes
 */
function setupN8nOpenTelemetry() {
  // Setup n8n workflow execution tracing
  const tracer = trace.getTracer('n8n-instrumentation', '1.0.0')

  try {
    // Import n8n core modules
    const { WorkflowExecute } = require('n8n-core')

    /**
     * Patch the workflow execution
     *
     * Wrap the entire run in a workflow-level span and capture workflow details as attributes.
     *
     * OpenInference attributes:
     * - openinference.span.kind: CHAIN
     * - input.value / output.value: workflow I/O
     * - session.id: execution-derived session ID
     * - metadata: JSON of workflow details
     */
    const originalProcessRun = WorkflowExecute.prototype.processRunExecutionData
    /** @param {import('n8n-workflow').Workflow} workflow */
    WorkflowExecute.prototype.processRunExecutionData = function (workflow) {
      const wfData = workflow || {}
      const workflowId = wfData?.id ?? ''
      const workflowName = wfData?.name ?? ''

      // Attempt to resolve execution id from several potential locations (varies across n8n versions)
      const executionId =
        this?.executionId ||
        this?.workflowExecuteAdditionalData?.executionId ||
        this?.additionalData?.executionId ||
        'unknown'
      const sessionId = deriveSessionId(executionId)

      // n8n-specific attributes (kept for debugging / metadata)
      const n8nAttributes = {
        'n8n.workflow.id': workflowId,
        'n8n.workflow.name': workflowName,
        'n8n.execution.id': executionId,
      }

      // Flatten workflow settings as metadata
      const settingsFlat = flatten(wfData?.settings ?? {}, {
        delimiter: '.',
        transformKey: (key) => `n8n.workflow.settings.${key}`,
      })

      // OpenInference attributes
      const workflowAttributes = {
        // Required: span kind
        'openinference.span.kind': 'CHAIN',
        // Session
        'session.id': sessionId,
        // n8n context
        ...n8nAttributes,
        ...settingsFlat,
        // Metadata as JSON string (n8n workflow info)
        'metadata': safeJSONStringify({
          'n8n.workflow.id': workflowId,
          'n8n.workflow.name': workflowName,
          'n8n.execution.id': executionId,
        }),
      }

      // If the active parent span is the auto-instrumented HTTP server span (named GET/POST/etc),
      // rename it so the trace list shows a workflow-centric name instead of HTTP verb.
      const activeParent = trace.getSpan(context.active())
      if (activeParent && !ONLY_WORKFLOW_SPANS) {
        const httpMethodAttr =
          activeParent.attributes &&
          (activeParent.attributes['http.method'] ||
            activeParent.attributes['http.request.method'])
        const nameLooksHttpVerb = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(
          activeParent.name || '',
        )
        if (httpMethodAttr || nameLooksHttpVerb) {
          const originalName = activeParent.name
          // Build new trace (root) name
          let newRootName = 'n8n.workflow'
          if (DYNAMIC_WORKFLOW_TRACE_NAME) {
            newRootName = `${sanitizeSegment(workflowId, 'wf')}-${sanitizeSegment(
              workflowName,
              'workflow',
            )}-${sanitizeSegment(executionId, 'exec')}`
          } else {
            // still low cardinality but more explicit
            newRootName = 'n8n.workflow.request'
          }
          try {
            activeParent.updateName(newRootName)
            // Attach workflow attributes also to root span so they are visible in trace list
            for (const [k, v] of Object.entries(workflowAttributes)) {
              if (activeParent.attributes?.[k] === undefined) {
                activeParent.setAttribute(k, v)
              }
            }
            activeParent.setAttribute('n8n.http.original_name', originalName)
            activeParent.setAttribute('n8n.trace.naming', DYNAMIC_WORKFLOW_TRACE_NAME ? 'dynamic' : 'constant')
          } catch (err) {
            if (DEBUG) console.warn('[Tracing] Failed to rename HTTP root span', err)
          }
        }
      }

      // Keep span name constant (low-cardinality) to avoid metrics explosion.
      const workflowSpanName = buildWorkflowSpanName({
        workflowId,
        workflowName,
        executionId,
        sessionId,
      })
      const span = tracer.startSpan(workflowSpanName, {
        attributes: workflowAttributes,
        kind: SpanKind.INTERNAL,
      })

      if (DEBUG) {
        console.debug(`${LOGPREFIX}: starting n8n workflow span`, {
          workflowId,
          executionId,
          sessionId,
          spanName: workflowSpanName,
        })
      }

      const activeContext = trace.setSpan(context.active(), span)
      return context.with(activeContext, () => {
        const cancelable = originalProcessRun.apply(this, arguments)
        cancelable
          .then(
            (result) => {
              if (result?.data?.resultData?.error) {
                const err = result.data.resultData.error
                span.recordException(err)
                span.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: String(err.message || err),
                })
              } else {
                span.setStatus({ code: SpanStatusCode.OK })
              }
              if (CAPTURE_IO) {
                // Workflow output: extract only the final node's output
                // (not the entire runData which contains execution logs for every node)
                try {
                  const resultData = result?.data?.resultData
                  const runData = resultData?.runData
                  const lastNode = resultData?.lastNodeExecuted
                  if (runData && lastNode && runData[lastNode]) {
                    // Get the last execution of the final node
                    const lastNodeRuns = runData[lastNode]
                    const lastRun = lastNodeRuns[lastNodeRuns.length - 1]
                    // Extract output items from the last run
                    const outputItems = []
                    const mainOutputs = lastRun?.data?.main
                    if (mainOutputs) {
                      for (const connection of mainOutputs) {
                        if (!connection) continue
                        for (const item of connection) {
                          if (item?.json) outputItems.push(item.json)
                        }
                      }
                    }
                    if (outputItems.length) {
                      const finalOutput = outputItems.length === 1 ? outputItems[0] : outputItems
                      const outputStr = truncateIO(safeJSONStringify(finalOutput))
                      span.setAttribute('output.value', outputStr)
                      span.setAttribute('output.mime_type', 'application/json')
                    }
                  }
                } catch (e) {
                  if (DEBUG)
                    console.warn('[Tracing] Failed to capture workflow output', e)
                }
                // If no explicit input yet, set minimal context
                if (!span.attributes?.['input.value']) {
                  span.setAttribute(
                    'input.value',
                    safeJSONStringify({ workflowId, workflowName }),
                  )
                  span.setAttribute('input.mime_type', 'application/json')
                }
              }
            },
            (error) => {
              span.recordException(error)
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: String(error.message || error),
              })
            },
          )
          .finally(() => {
            span.end()
          })
        return cancelable
      })
    }

    /**
     * Patch the n8n node execution
     *
     * Wrap each node's run in a child span and capture node details as attributes.
     *
     * OpenInference attributes:
     * - openinference.span.kind: mapped from node type (LLM, AGENT, TOOL, etc.)
     * - input.value / output.value: node I/O
     * - input.mime_type / output.mime_type: application/json
     * - session.id, user.id: context
     * - llm.input_messages / llm.output_messages: for LLM spans
     * - metadata: JSON of n8n node details
     */
    const originalRunNode = WorkflowExecute.prototype.runNode
    /**
     * @param {import('n8n-workflow').Workflow} workflow
     * @param {import('n8n-workflow').IExecuteData} executionData
     * @param {import('n8n-workflow').IRunExecutionData} runExecutionData
     * @param {number} runIndex
     * @param {import('n8n-workflow').IWorkflowExecuteAdditionalData} additionalData
     * @param {import('n8n-workflow').WorkflowExecuteMode} mode
     * @param {AbortSignal} [abortSignal]
     * @returns {Promise<import('n8n-workflow').IRunNodeResponse>}
     */
    WorkflowExecute.prototype.runNode = async function (
      workflow,
      executionData,
      runExecutionData,
      runIndex,
      additionalData,
      mode,
      abortSignal,
    ) {
      // Safeguard against undefined this context
      if (!this) {
        console.warn('WorkflowExecute context is undefined')
        return originalRunNode.apply(this, arguments)
      }

      const node = executionData?.node ?? 'unknown'

      const executionId = additionalData?.executionId ?? 'unknown'
      const sessionId = deriveSessionId(executionId)
      const userId = additionalData?.userId ?? 'unknown'

      // n8n-specific attributes (kept for context)
      const n8nNodeAttrs = {
        'n8n.workflow.id': workflow?.id ?? 'unknown',
        'n8n.execution.id': executionId,
        'n8n.node.name': node?.name || 'unknown',
      }

      // Flatten the n8n node object into a single level of attributes
      const flattenedNode = flatten(node ?? {}, { delimiter: '.' })
      for (const [key, value] of Object.entries(flattenedNode)) {
        if (typeof value === 'string' || typeof value === 'number') {
          n8nNodeAttrs[`n8n.node.${key}`] = value
        } else {
          n8nNodeAttrs[`n8n.node.${key}`] = JSON.stringify(value)
        }
      }

      // Debug logging, uncomment as needed
      if (DEBUG) {
        console.debug(`${LOGPREFIX} Executing node:`, node.name)
      }

      // Determine OpenInference span kind
      let spanKind
      if (MAP_OPENINFERENCE_SPAN_KINDS) {
        spanKind = mapNodeToSpanKind(node?.type, n8nNodeAttrs)
      }
      // Default to CHAIN if no mapping found
      if (!spanKind) spanKind = 'CHAIN'

      // Build OpenInference attributes for the node span
      const nodeAttributes = {
        // Required: OpenInference span kind
        'openinference.span.kind': spanKind,
        // Session & user context
        'session.id': sessionId,
        'user.id': userId,
        // n8n metadata
        ...n8nNodeAttrs,
        // Metadata as JSON string
        'metadata': safeJSONStringify({
          'n8n.workflow.id': workflow?.id ?? 'unknown',
          'n8n.execution.id': executionId,
          'n8n.node.name': node?.name || 'unknown',
          'n8n.node.type': node?.type || 'unknown',
        }),
      }

      let nodeSpanName
      if (USE_NODE_NAME_SPAN) {
        // Use raw node name for maximum readability; fall back if missing
        nodeSpanName = node?.name || 'unknown-node'
      } else if (SPAN_KIND_IN_NODE_SPAN_NAME && spanKind) {
        nodeSpanName = `n8n.node.${spanKind}.execute`
      } else {
        nodeSpanName = 'n8n.node.execute'
      }

      return tracer.startActiveSpan(
        nodeSpanName,
        { attributes: nodeAttributes, kind: SpanKind.INTERNAL },
        async (nodeSpan) => {
          // Capture node input *before* execution (OpenInference input.value)
          // Uses executionData.data (actual resolved values) rather than node.parameters (raw expressions)
          if (CAPTURE_IO) {
            try {
              const inputObj = extractNodeInputFromExecutionData(executionData)
              if (inputObj) {
                const inputStr = truncateIO(safeJSONStringify(inputObj))
                // OpenInference input attributes
                nodeSpan.setAttribute('input.value', inputStr)
                nodeSpan.setAttribute('input.mime_type', 'application/json')

                // For LLM spans, try to extract messages from the resolved input
                if (spanKind === 'LLM') {
                  const inputData = Array.isArray(inputObj) ? inputObj[0] : inputObj
                  const userContent = inputData?.chatInput || inputData?.text || inputData?.prompt || inputData?.query
                  if (userContent) {
                    nodeSpan.setAttribute('llm.input_messages.0.message.role', 'user')
                    nodeSpan.setAttribute('llm.input_messages.0.message.content',
                      typeof userContent === 'string' ? userContent : safeJSONStringify(userContent))
                  }
                }
              }
            } catch (e) {
              if (DEBUG)
                console.warn('[Tracing] Failed to capture node input', e)
            }
          }
          try {
            const result = await originalRunNode.apply(this, [
              workflow,
              executionData,
              runExecutionData,
              runIndex,
              additionalData,
              mode,
              abortSignal,
            ])
            try {
              if (CAPTURE_IO) {
                // Always log output structure to diagnose extraction issues
                console.log(`${LOGPREFIX}: [output] node=${node?.name} type=${node?.type}`,
                  'result keys:', result ? Object.keys(result) : 'null',
                  'data type:', typeof result?.data,
                  'isArray:', Array.isArray(result?.data))
                if (result?.data && Array.isArray(result.data)) {
                  result.data.forEach((conn, i) => {
                    if (conn && Array.isArray(conn)) {
                      conn.forEach((item, j) => {
                        const keys = item ? Object.keys(item) : []
                        const jsonKeys = item?.json ? Object.keys(item.json).slice(0, 5) : []
                        console.log(`${LOGPREFIX}: [output]   data[${i}][${j}] item keys: [${keys}], json keys: [${jsonKeys}]`)
                      })
                    } else {
                      console.log(`${LOGPREFIX}: [output]   data[${i}] = ${conn === null ? 'null' : typeof conn}`)
                    }
                  })
                }
                const extracted = extractNodeOutput(result)
                if (extracted) {
                  const outputStr = truncateIO(safeJSONStringify(extracted))
                  // OpenInference output attributes
                  nodeSpan.setAttribute('output.value', outputStr)
                  nodeSpan.setAttribute('output.mime_type', 'application/json')

                  // For LLM spans, set llm.output_messages
                  if (spanKind === 'LLM' && extracted.primary) {
                    nodeSpan.setAttribute('llm.output_messages.0.message.role', 'assistant')
                    nodeSpan.setAttribute('llm.output_messages.0.message.content',
                      typeof extracted.primary === 'string' ? extracted.primary : safeJSONStringify(extracted.primary))
                  }
                } else if (DEBUG) {
                  console.debug(`${LOGPREFIX}: No output extracted for ${node?.name}`)
                }
              }
            } catch (error) {
              console.warn('Failed to set node output attributes: ', error)
            }
            nodeSpan.setStatus({ code: SpanStatusCode.OK })
            return result
          } catch (error) {
            nodeSpan.recordException(error)
            nodeSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: String(error.message || error),
            })
            nodeSpan.setAttribute('n8n.node.status', 'error')
            throw error
          } finally {
            nodeSpan.end()
          }
        },
      )
    }

  } catch (e) {
    console.error('Failed to set up n8n OpenTelemetry instrumentation:', e)
  	}
	}
}
