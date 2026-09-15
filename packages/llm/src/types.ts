export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  // Ask for a JSON object; the caller still validates it
  json?: boolean;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
}

export interface ModelLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
  requestsPerDay: number;
}

export interface ChatModel {
  // Config name, for example gemini-flash
  id: string;
  provider: string;
  model: string;
  limits: ModelLimits;
  complete(request: ChatRequest): Promise<ChatResult>;
}

// The model is out of its allowance for now; a router moves on to the next model
export class ModelUnavailableError extends Error {
  override readonly name = "ModelUnavailableError";

  constructor(
    message: string,
    // The task no configured model could take, when a router gave up on all of them
    readonly task?: string,
  ) {
    super(message);
  }
}
