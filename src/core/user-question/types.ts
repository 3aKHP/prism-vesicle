import type { ToolCall, ToolDefinition } from "../tools";

export type UserQuestionOption = {
  id?: string;
  label: string;
  description: string;
  kind?: "model" | "skip" | "freeform";
};

export type UserQuestionRequest = {
  header: string;
  question: string;
  options: UserQuestionOption[];
};

export type UserQuestionAnswer = {
  selectedIndex: number;
  label: string;
  description: string;
  kind?: UserQuestionOption["kind"];
  optionId?: string;
  freeformText?: string;
};

export const userQuestionOpenAnswerOption: UserQuestionOption = {
  label: "Answer freely",
  description: "Type an open-ended answer instead of choosing a preset option.",
  kind: "freeform",
};

export const userQuestionSkipOption: UserQuestionOption = {
  label: "Skip",
  description: "Let the model continue with its best judgment.",
  kind: "skip",
};

export const userQuestionFallbackOptions: UserQuestionOption[] = [
  {
    ...userQuestionSkipOption,
  },
  userQuestionOpenAnswerOption,
];

export function parseUserQuestionRequest(call: ToolCall): UserQuestionRequest {
  if (call.name !== "ask_user_question") {
    throw new Error(`parseUserQuestionRequest called on non-question tool: ${call.name}`);
  }
  const args = JSON.parse(call.arguments || "{}") as Partial<UserQuestionRequest>;
  if (typeof args.header !== "string" || args.header.trim() === "") {
    throw new Error("ask_user_question requires a non-empty `header` string.");
  }
  if (typeof args.question !== "string" || args.question.trim() === "") {
    throw new Error("ask_user_question requires a non-empty `question` string.");
  }
  if (!Array.isArray(args.options) || args.options.length < 2 || args.options.length > 4) {
    throw new Error("ask_user_question requires 2 to 4 `options`.");
  }
  const options = args.options.map((option, index) => {
    if (typeof option?.label !== "string" || option.label.trim() === "") {
      throw new Error(`ask_user_question option ${index + 1} requires a non-empty label.`);
    }
    if (typeof option.description !== "string" || option.description.trim() === "") {
      throw new Error(`ask_user_question option ${index + 1} requires a non-empty description.`);
    }
    return {
      label: option.label,
      description: option.description,
      kind: "model" as const,
    };
  });
  return {
    header: args.header,
    question: args.question,
    options: [...options, ...userQuestionFallbackOptions.map((option) => ({ ...option }))],
  };
}

export const askUserQuestionToolDefinition: ToolDefinition = {
  type: "function",
  function: {
    name: "ask_user_question",
    description:
      "Pause and ask the user one clarifying single-select question with 2 to 4 concrete options. Use this only when the answer materially affects the next action and cannot be inferred safely. The host automatically appends Skip and open-ended answer fallbacks.",
    parameters: {
      type: "object",
      properties: {
        header: {
          type: "string",
          description: "Very short label for the question, such as \"Engine\", \"Scope\", or \"Style\".",
        },
        question: {
          type: "string",
          description: "The complete question to ask the user. Keep it clear, specific, and phrased as a question.",
        },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          description: "Mutually exclusive choices. Do not include Skip or open-ended fallback options; the host appends those fallbacks automatically.",
          items: {
            type: "object",
            properties: {
              label: {
                type: "string",
                description: "Short user-visible option label, ideally 1 to 5 words.",
              },
              description: {
                type: "string",
                description: "One sentence explaining the option's impact or tradeoff.",
              },
            },
            required: ["label", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["header", "question", "options"],
      additionalProperties: false,
    },
  },
};
