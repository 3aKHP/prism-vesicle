export type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; [key: string]: unknown };
  output_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
};

export type ResponsesAnnotation = {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
};

export type ResponsesOutputItem = {
  id?: string;
  type?: string;
  role?: string;
  status?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  encrypted_content?: string;
  content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: ResponsesAnnotation[] }>;
  summary?: Array<{ type?: string; text?: string }>;
  [key: string]: unknown;
};

export type ResponsesBody = {
  id?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  error?: { message?: string; code?: string } | null;
  incomplete_details?: { reason?: string } | null;
};

export type ResponsesCompactBody = {
  id?: string;
  object?: string;
  output?: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  error?: { message?: string; code?: string } | null;
};

export type ResponsesEvent = {
  type?: string;
  sequence_number?: number;
  delta?: string;
  item_id?: string;
  output_index?: number;
  content_index?: number;
  item?: ResponsesOutputItem;
  response?: ResponsesBody;
  error?: { message?: string; code?: string };
};
export const openAIResponsesProtocol = "openai-responses";
