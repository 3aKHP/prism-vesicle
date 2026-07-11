export type ChatCompletionChoice = {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: {
        name: string;
        arguments: string;
      };
    }>;
  };
};

export type ChatCompletionResponse = {
  id?: string;
  choices?: ChatCompletionChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      [key: string]: unknown;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      [key: string]: unknown;
    };
  };
  error?: {
    message?: string;
  };
};

export type ChatCompletionStreamChunk = {
  id?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      [key: string]: unknown;
    };
    completion_tokens_details?: {
      reasoning_tokens?: number;
      [key: string]: unknown;
    };
  };
  error?: {
    message?: string;
  };
};
