FROM docker.n8n.io/n8nio/n8n:latest

USER root

WORKDIR /usr/local/lib/node_modules/n8n

# Using OTEL API with OpenInference conventions to send traces to Arize
# No Arize-specific SDK needed - traces are sent via standard OTLP (gRPC/HTTP)

# Install OpenTelemetry dependencies required by tracing.js
RUN mkdir -p /opt/opentelemetry
WORKDIR /opt/opentelemetry
COPY ./tracing/package.json package.json
COPY ./tracing/package-lock.json package-lock.json
COPY ./tracing/tracing.js tracing.js
COPY ./tracing/openinference-mapper.js openinference-mapper.js

RUN chown node:node ./*.js
RUN npm install

# Create a symlink to n8n-core in the OpenTelemetry node_modules directory
# tracing.js patches n8n-core to trace workflow executions
RUN mkdir -p /opt/opentelemetry/node_modules/n8n-core
RUN ln -sf /usr/local/lib/node_modules/n8n/node_modules/n8n-core/* /opt/opentelemetry/node_modules/n8n-core/

# Create a symlink to @langchain/core so the LangChain instrumentation can
# resolve imports (e.g. BaseTracer) against n8n's bundled copy
RUN mkdir -p /opt/opentelemetry/node_modules/@langchain
RUN ln -sf /usr/local/lib/node_modules/n8n/node_modules/@langchain/core /opt/opentelemetry/node_modules/@langchain/core

# Copy entrypoint script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN echo "Setting entrypoint permissions..." && \
    chmod +x /docker-entrypoint.sh && \
    chown node:node /docker-entrypoint.sh

# Switch back to the node homedir and user
WORKDIR /home/node
USER node

ENTRYPOINT ["tini", "--", "/docker-entrypoint.sh"]
