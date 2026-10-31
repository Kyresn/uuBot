export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

export type ToolDef = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
};

export type Usage = {
  promptTokens: number;
  completionTokens: number;
};
