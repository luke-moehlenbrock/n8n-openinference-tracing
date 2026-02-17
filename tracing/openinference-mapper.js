'use strict';

/**
 * OpenInference Span Kind Mapper for n8n Nodes
 *
 * Maps n8n node types to OpenInference span kinds as defined by the
 * OpenInference semantic conventions:
 * https://github.com/Arize-ai/openinference/blob/main/spec/semantic_conventions.md
 *
 * Valid OpenInference span kinds:
 * [ 'LLM', 'EMBEDDING', 'CHAIN', 'RETRIEVER', 'RERANKER', 'TOOL', 'AGENT', 'GUARDRAIL', 'EVALUATOR', 'PROMPT' ]
 *
 * Priority:
 *   - Exact match sets
 *   - Regex heuristics
 *   - Category fallback
 */

// Valid OpenInference span kinds (for reference)
const SPAN_KINDS = Object.freeze([
  'LLM',
  'EMBEDDING',
  'CHAIN',
  'RETRIEVER',
  'RERANKER',
  'TOOL',
  'AGENT',
  'GUARDRAIL',
  'EVALUATOR',
  'PROMPT',
]);

// Node type exact match sets → OpenInference span kinds
const EXACT_SETS = {
  AGENT:      new Set(['Agent', 'AgentTool']),
  LLM:        new Set(['LmChatOpenAi', 'LmOpenAi', 'OpenAi', 'Anthropic', 'GoogleGemini', 'Groq', 'Perplexity', 'LmChatAnthropic', 'LmChatGoogleGemini', 'LmChatMistralCloud', 'LmChatOpenRouter', 'LmChatXAiGrok', 'OpenAiAssistant']),
  EMBEDDING:  new Set(['EmbeddingsAwsBedrock', 'EmbeddingsAzureOpenAi', 'EmbeddingsCohere', 'EmbeddingsGoogleGemini', 'EmbeddingsGoogleVertex', 'EmbeddingsHuggingFaceInference', 'EmbeddingsMistralCloud', 'EmbeddingsOllama', 'EmbeddingsOpenAi']),
  RETRIEVER:  new Set(['RetrieverContextualCompression', 'RetrieverMultiQuery', 'RetrieverVectorStore', 'RetrieverWorkflow', 'MemoryChatRetriever',
                       'VectorStoreInMemory','VectorStoreInMemoryInsert','VectorStoreInMemoryLoad','VectorStoreMilvus','VectorStoreMongoDBAtlas','VectorStorePGVector',
                       'VectorStorePinecone','VectorStorePineconeInsert','VectorStorePineconeLoad','VectorStoreQdrant','VectorStoreSupabase','VectorStoreSupabaseInsert','VectorStoreSupabaseLoad',
                       'VectorStoreWeaviate','VectorStoreZep','VectorStoreZepInsert','VectorStoreZepLoad']),
  RERANKER:   new Set(['RerankerCohere']),
  EVALUATOR:  new Set(['SentimentAnalysis', 'TextClassifier', 'InformationExtractor', 'OutputParserAutofixing']),
  GUARDRAIL:  new Set(['GooglePerspective', 'AwsRekognition']),
  CHAIN:      new Set(['ChainLlm', 'ChainRetrievalQa', 'ChainSummarization', 'ToolWorkflow', 'ToolExecutor', 'ModelSelector', 'OutputParserStructured', 'OutputParserItemList',
                       'TextSplitterCharacterTextSplitter', 'TextSplitterRecursiveCharacterTextSplitter', 'TextSplitterTokenSplitter', 'ToolThink']),
};

// Regex heuristics
// IMPORTANT: Order matters! More specific rules must come before broader ones.
// Trigger rule must precede LLM to prevent "chatTrigger" matching /chat/i as LLM.
const REGEX_RULES = [
  { kind: 'CHAIN',     pattern: /trigger/i },
  { kind: 'AGENT',     pattern: /agent/i },
  { kind: 'EMBEDDING', pattern: /embedding/i },
  { kind: 'RETRIEVER', pattern: /(retriev|vectorstore)/i },
  { kind: 'RERANKER',  pattern: /rerank/i },
  { kind: 'LLM',       pattern: /(lmchat|^lm[a-z]|chat|openai|anthropic|gemini|mistral|groq|cohere)/i },
  { kind: 'TOOL',      pattern: /tool/ },
  { kind: 'CHAIN',     pattern: /(chain|textsplitter|parser|memory|workflow)/i },
  { kind: 'EVALUATOR', pattern: /(classif|sentiment|extract)/i },
  { kind: 'GUARDRAIL', pattern: /(perspective|rekognition|moderation|guardrail)/i },
];

// Internal logic nodes fallback mapping
const INTERNAL_LOGIC = new Set([
  'If',
  'Switch',
  'Set',
  'Move',
  'Rename',
  'Wait',
  'WaitUntil',
  'Function',
  'FunctionItem',
  'Code',
  'NoOp',
  'ExecuteWorkflow',
  'SubworkflowTo',
]);

function categoryFallback(type, category) {
  switch (category) {
    case 'Trigger Nodes':
      return 'CHAIN'; // No direct "event" kind in OpenInference; CHAIN is closest
    case 'Transform Nodes':
      return 'CHAIN';
    case 'AI/LangChain Nodes':
      return 'CHAIN';
    case 'Core Nodes': {
      if (INTERNAL_LOGIC.has(type)) return 'CHAIN';
      if (type === 'Schedule' || type === 'Cron') return 'CHAIN';
      return 'TOOL';
    }
    default:
      return undefined;
  }
}

/**
 * Main mapping function
 * @param {string} nodeType - The n8n node type string
 * @param {object} nodeAttributes - Optional, can include 'n8n.node.category'
 * @returns {string|undefined} One of SPAN_KINDS or undefined
 */
function mapNodeToSpanKind(nodeType, nodeAttributes) {
  if (!nodeType || typeof nodeType !== 'string') return undefined;
  const original = nodeType;

  // 1. Exact sets
  for (const [spanKind, set] of Object.entries(EXACT_SETS)) {
    if (set.has(original)) return spanKind;
  }

  // 2. Regex heuristics
  const lower = original.toLowerCase();
  for (const rule of REGEX_RULES) {
    if (rule.pattern.test(lower)) return rule.kind;
  }

  // 3. Category fallback
  const category = nodeAttributes?.['n8n.node.category'] || nodeAttributes?.['n8n.node.category_raw'];
  const fromCategory = categoryFallback(original, category);
  if (fromCategory) return fromCategory;

  // 4. No match => undefined (caller can default to 'CHAIN')
  return undefined;
}

module.exports = { mapNodeToSpanKind, SPAN_KINDS };
