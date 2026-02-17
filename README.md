# n8n-arize

Deep n8n Observability with OpenTelemetry + Arize (OpenInference)
Based on https://github.com/rwb-truelime/n8n-langfuse

## ⚠️ IMPORTANT DISCLAIMER ⚠️

**🚨 THIS IS A PROOF OF CONCEPT - NOT FOR PRODUCTION USE! 🚨**

This project is an **experimental demonstration** and **proof of concept** only. It is **NOT intended for production environments** and should only be used for:

- **Development and testing purposes**
- **Educational exploration**
- **Community proof of concept demonstrations**

**DO NOT USE IN PRODUCTION** due to:
- Lack of comprehensive testing across all n8n versions
- Potential performance impact on workflow execution
- Security implications of instrumentation patches
- Experimental nature of the OpenTelemetry integration
- No official support or warranty

**Use at your own risk!** Always test thoroughly in isolated development environments first.

---

## Overview

This project provides a ready-to-use solution for instrumenting your self-hosted n8n instance to send detailed traces directly to [Arize](https://arize.com) via OpenTelemetry, using the [OpenInference semantic conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md). This is especially powerful for AI workflows, as it maps n8n nodes to OpenInference span kinds (LLM, AGENT, TOOL, etc.).

Building on foundational OpenTelemetry work from the n8n community, this solution provides:
- **Detailed trace for every workflow run**
- **Each node as a child span with metadata and I/O**
- **OpenInference span kind mapping** for AI-specific insights (LLM, AGENT, TOOL, CHAIN, RETRIEVER, EMBEDDING, etc.)
- **LangChain sub-node tracing** via `@arizeai/openinference-instrumentation-langchain` -- automatically traces internal LLM calls, tool invocations, retriever queries, and agent reasoning loops inside AI nodes
- **Direct integration with Arize** via gRPC (default) or HTTP OTLP
- **Ready-to-use Docker setup**

## Prerequisites

Before you begin, make sure you have:

- Docker and Docker Compose installed and running on your machine
- An [Arize](https://arize.com) account with your **Space ID** and **API Key**
- Basic familiarity with Docker and environment variables

## Quick Start

### Step 1: Clone and Organize Files

Create a project directory with the following structure:

```
.
├── docker-entrypoint.sh
├── Dockerfile
├── docker-compose.yml
├── .env_example
├── tracing/
│   ├── package.json
│   ├── package-lock.json
│   ├── openinference-mapper.js
│   └── tracing.js
```

### Step 2: Configure Environment Variables

1. Copy `.env_example` to `.env`:
   ```bash
   cp .env_example .env
   ```

2. Edit `.env` with your Arize details:
   ```env
   ARIZE_SPACE_ID=your-arize-space-id
   ARIZE_API_KEY=your-arize-api-key
   ARIZE_PROJECT_NAME=n8n
   ```

   That's it! The default configuration uses gRPC to send traces to `otlp.arize.com`.

### Step 3: Choose Your Deployment Method

#### Option A: Docker Compose (Recommended)

The easiest way to get started with n8n and PostgreSQL:

```bash
# Build and start all services
docker-compose up --build

# Or run in background
docker-compose up --build -d

# View logs
docker-compose logs -f n8n

# Stop services
docker-compose down
```

#### Option B: Manual Docker Commands

If you prefer manual control:

```bash
# Build the custom Docker image
docker build -t n8n-arize .

# Run the instrumented container
docker run --rm --env-file .env -p 5678:5678 n8n-arize
```

### Step 4: Verify Traces in Arize

1. Open n8n at `http://localhost:5678`
2. Create and run any workflow
3. Check your Arize project's Traces dashboard
4. You should see traces with nested spans for each node!

## Docker Compose Setup

The included `docker-compose.yml` provides a complete setup with:

- **PostgreSQL database** for n8n data persistence
- **n8n with OpenTelemetry instrumentation**
- **Health checks** to ensure proper startup order
- **Data persistence** via Docker volumes

### Services

- **postgres-otel-dev**: PostgreSQL 15 database for n8n
- **n8n**: Custom n8n image with Arize tracing

### Volumes

- **postgres_otel_data**: Persistent PostgreSQL data
- **n8n_otel_data**: Persistent n8n workflows and settings

### Development Tips

For live debugging, uncomment these volume mounts in `docker-compose.yml`:

```yaml
volumes:
  - n8n_otel_data:/home/node/.n8n
  # Uncomment for live development:
  # - ./tracing/tracing.js:/opt/opentelemetry/tracing.js
  # - ./docker-entrypoint.sh:/docker-entrypoint.sh
```

This allows you to modify tracing code without rebuilding the container.

## How It Works

### Architecture Components

- **`docker-entrypoint.sh`**: Intercepts container startup and loads tracing before n8n starts
- **`tracing.js`**: Core instrumentation that patches n8n's WorkflowExecute class and enables LangChain sub-node tracing
- **`openinference-mapper.js`**: Maps n8n node types to OpenInference span kinds
- **`@arizeai/openinference-instrumentation-langchain`**: Patches LangChain's `CallbackManager` to trace internal operations
- **OpenTelemetry SDK**: Handles trace collection and export to Arize

### Trace Structure

For non-AI workflows:

```
Workflow Execution (CHAIN)
├── Node 1 (LLM)    - with input.value / output.value
├── Node 2 (TOOL)   - with input.value / output.value
└── Node N (CHAIN)   - with metadata and timing
```

For AI workflows with LangChain sub-node tracing:

```
Workflow Execution (CHAIN)
├── Webhook (CHAIN)
├── AI Agent (AGENT)                              [n8n node span]
│   ├── Agent (AGENT)                             [LangChain instrumentation]
│   │   ├── ChatOpenAI (LLM)                      [LangChain instrumentation]
│   │   │   ├── llm.input_messages, llm.output_messages
│   │   │   └── llm.token_count.prompt, llm.token_count.completion
│   │   ├── Calculator (TOOL)                     [LangChain instrumentation]
│   │   └── ChatOpenAI (LLM)                      [LangChain instrumentation]
│   └── ...
└── Response (CHAIN)
```

The LangChain instrumentation automatically creates child spans for every internal LangChain operation, including LLM calls with full message content and token counts, tool invocations, retriever queries, and agent reasoning loops.

### OpenInference Semantic Conventions

This project uses the [OpenInference semantic conventions](https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md) to annotate spans:

| Attribute | Description |
|-----------|-------------|
| `openinference.span.kind` | Required. One of: LLM, EMBEDDING, CHAIN, RETRIEVER, RERANKER, TOOL, AGENT, GUARDRAIL, EVALUATOR, PROMPT |
| `input.value` | The input to the operation (JSON string) |
| `input.mime_type` | `application/json` |
| `output.value` | The output of the operation (JSON string) |
| `output.mime_type` | `application/json` |
| `session.id` | Execution-derived session ID |
| `user.id` | n8n user ID |
| `metadata` | JSON string with n8n-specific context |
| `llm.input_messages` | For LLM spans: flattened input messages |
| `llm.output_messages` | For LLM spans: flattened output messages |

## Configuration Options

### Arize Connection

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `ARIZE_SPACE_ID` | *(required)* | Your Arize Space ID |
| `ARIZE_API_KEY` | *(required)* | Your Arize API Key |
| `ARIZE_PROJECT_NAME` | `n8n` | Project name in Arize (maps to `openinference.project.name`) |
| `ARIZE_PROTOCOL` | `grpc` | Transport protocol: `grpc` (default) or `http` |
| `ARIZE_ENDPOINT` | `https://otlp.arize.com` | Arize OTLP endpoint |

### Tracing Behavior

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRACING_ONLY_WORKFLOW_SPANS` | `true` | Disable auto-instrumentations (HTTP/DB) |
| `TRACING_DYNAMIC_WORKFLOW_TRACE_NAME` | `true` | Include workflow details in span names |
| `TRACING_USE_NODE_NAME_SPAN` | `true` | Use actual node names as span names |
| `TRACING_CAPTURE_INPUT_OUTPUT` | `true` | Capture node inputs/outputs |
| `TRACING_MAP_OPENINFERENCE_SPAN_KINDS` | `true` | Map n8n node types to OpenInference span kinds |
| `TRACING_INSTRUMENT_LANGCHAIN` | `true` | Trace LangChain sub-node operations (LLM calls, tools, retrievers) |

### OpenInference Span Kind Mapping

The system automatically maps n8n nodes to OpenInference span kinds:

- **LLM**: OpenAI, Anthropic, Google Gemini, Groq, Mistral, etc.
- **TOOL**: Utility nodes, HTTP requests, data processing
- **AGENT**: AI Agent nodes
- **RETRIEVER**: Vector stores, memory retrieval
- **CHAIN**: Workflow orchestration, text processing, triggers
- **EMBEDDING**: Embedding generation nodes
- **RERANKER**: Cohere reranker, etc.
- **EVALUATOR**: Sentiment analysis, text classification, information extraction
- **GUARDRAIL**: Content moderation nodes

## Security Considerations

⚠️ **Important Security Notes:**

- Your `.env` file contains sensitive API keys - never commit it to version control
- The `TRACING_CAPTURE_INPUT_OUTPUT` option may capture sensitive data
- Rotate your Arize API keys regularly
- The `ARIZE_SPACE_ID` and `ARIZE_API_KEY` are sent as gRPC metadata / HTTP headers

## Troubleshooting

### Common Issues

1. **No traces appearing in Arize**
   - Verify your `ARIZE_SPACE_ID` and `ARIZE_API_KEY` are correct
   - Check that `ARIZE_PROJECT_NAME` matches your intended project
   - Ensure the endpoint is reachable: `https://otlp.arize.com`
   - Try switching protocol: `ARIZE_PROTOCOL=http`

2. **Container fails to start**
   - Check Docker logs: `docker logs <container_id>`
   - Verify all required files are in the correct directory structure
   - Ensure environment variables are properly formatted

3. **Missing spans for some nodes**
   - Some n8n node types may not be instrumented yet
   - Check the console logs for instrumentation warnings

4. **No LangChain sub-spans appearing**
   - Verify the log shows "LangChain OpenInference instrumentation enabled"
   - Check that `TRACING_INSTRUMENT_LANGCHAIN` is not set to `false`
   - Only AI nodes that use LangChain internally (Agent, LLM Chat, etc.) will produce sub-spans
   - Non-AI nodes (HTTP Request, Set, If, etc.) won't have LangChain sub-spans

### Debug Mode

Enable debug logging by setting:
```env
TRACING_LOG_LEVEL=debug
OTEL_LOG_LEVEL=DEBUG
```

## Contributing

Feedback and improvements are welcome! Areas for contribution:

- Additional node type mappings for OpenInference span kinds
- Enhanced error handling and logging
- Performance optimizations

## Inspiration

This project builds on the fantastic foundational work from the n8n community's OpenTelemetry initiatives. The goal is to inspire the n8n development team to integrate native observability features.

**We need this ASAP!** 🚀😎

## License

This project is provided as-is **FOR PROOF OF CONCEPT PURPOSES ONLY** for the n8n community. **DO NOT USE IN PRODUCTION ENVIRONMENTS.** Please ensure compliance with n8n's licensing terms when using this in development environments.

---

Happy building! 🎉

For issues and feature requests, please open an issue in this repository.
