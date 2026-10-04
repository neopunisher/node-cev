// Wire types. Requests and responses are the bodies of cev's REST API
// (`POST /v1/systemone` and friends), field for field, so they keep its
// snake_case names. Only the options of `Cev.load` are camelCase.

/** How to correct the model's option-position bias; `full` does both. */
export type Debias = 'none' | 'calibrate' | 'permute' | 'full';

/** Describes one option: text, or TypeSafe's structured form. */
export type Criterion =
  | string
  | null
  | { readonly what?: string; readonly not_for?: string | readonly string[]; readonly examples?: string | readonly string[]; readonly [key: string]: unknown };

interface QuestionBase {
  instructions: string;
  /**
   * Stable name for the online-learning adapter. Without it the key is a hash
   * of the type, instructions and option names, so rewording starts over.
   */
  task?: string;
}

/** "Is this true?" Answers with a probability. */
export interface NoulQuestion extends QuestionBase {
  type: 'noul';
  /** What counts as yes, or separate descriptions of yes and no. */
  criteria?: string | null | { readonly true?: Criterion; readonly false?: Criterion; readonly yes?: Criterion; readonly no?: Criterion };
}

/** "Which of these?" Answers with one option and a distribution. */
export interface ChoiceQuestion extends QuestionBase {
  type: 'choice';
  /** Option names mapped to descriptions, or just the names. */
  criteria: { readonly [option: string]: Criterion } | readonly string[];
}

/** "Which level?" Answers with the expected level and a distribution. */
export interface ScoreQuestion extends QuestionBase {
  type: 'score';
  /** Level descriptions, lowest first. */
  criteria: readonly Criterion[] | { readonly [level: string]: Criterion };
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = { readonly [id: string]: Question };

/** Extras cev adds to every answer. */
export interface AnswerMeta {
  /** Send this back with `feedback`. Empty when the request had `no_store`. */
  decision_id: string;
  task: string;
  /** True when an online adapter adjusted this answer. */
  adapted: boolean;
  /** The distribution before the adapter, in the order of `probabilities`. */
  base_probabilities?: number[];
}

export interface NoulAnswer {
  type: 'noul';
  /** Probability that the answer is yes. */
  noul: number;
  x_cev: AnswerMeta;
}

export interface ChoiceAnswer<O extends string = string> {
  type: 'choice';
  choice: O;
  /** `(p_max - 1/K) / (1 - 1/K)`: 0 for a uniform distribution, 1 for a certain one. */
  confidence: number;
  probabilities: Record<O, number>;
  x_cev: AnswerMeta;
}

export interface ScoreAnswer {
  type: 'score';
  /** Expected level index, so it can be fractional. */
  score: number;
  /** `1 - E|level - mode| / (K - 1)`. */
  confidence: number;
  /** Level index to its description. */
  legend: Record<string, string>;
  /** Level index to its probability. */
  probabilities: Record<string, number>;
  x_cev: AnswerMeta;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

type OptionsOf<C> = C extends readonly (infer O extends string)[] ? O : Extract<keyof C, string>;

/** The answer type of a question: a choice knows its option names. */
export type AnswerFor<Q extends Question> = Q extends { type: 'noul' }
  ? NoulAnswer
  : Q extends { type: 'choice'; criteria: infer C }
    ? ChoiceAnswer<OptionsOf<C>>
    : Q extends { type: 'score' }
      ? ScoreAnswer
      : never;

export interface DecideRequest<Q extends Questions = Questions> {
  /** The evidence: free text, or any JSON value (program state). */
  state: unknown;
  /** Asked together in one forward pass and answered under the same ids. */
  questions: Q;
  /** Do not log this request. Its answers then cannot take feedback. */
  no_store?: boolean;
  /** Overrides the instance's `debias` for this request. */
  debias?: Debias;
}

export interface DecideResponse<Q extends Questions = Questions> {
  model: string;
  answers: { -readonly [K in keyof Q]: AnswerFor<Q[K]> };
  usage: { input_tokens: number; output_tokens: number };
  request_id: string;
  latency_ms: number;
}

/**
 * The right answer to a past question.
 *
 * - noul: `true`/`false`, `"yes"`/`"no"`, or a probability
 * - choice: the option name, or `{ option: probability }`
 * - score: a level index (fractions split between neighbours), or `{ "0": p, ... }`
 */
export type Label = boolean | number | string | { readonly [option: string]: number };

export type FeedbackRequest = ({ decision_id: string } | { request_id: string; question_id: string }) & {
  /** Omit to leave only a comment. */
  label?: Label;
  /** Importance of this label (default 1). */
  weight?: number;
  comment?: string;
  /** Anything worth keeping with the label: who gave it, where it came from. */
  metadata?: unknown;
};

export interface FeedbackResponse {
  feedback_id: string;
  decision_id: string;
  task: string;
  /** Log loss of the answer that was served, on this label. */
  served_loss?: number;
  /** Whether the label updated the task's adapter. */
  learned: boolean;
  task_examples: number;
  adapter_active: boolean;
}

/** A labelled example: decide, then learn from the labels. */
export interface Example<Q extends Questions = Questions> {
  state: unknown;
  questions: Q;
  labels: { readonly [K in keyof Q]?: Label };
}

export interface ExampleResult<Q extends Questions = Questions> {
  response: DecideResponse<Q>;
  feedback: FeedbackResponse[];
}

/** One task's online adapter. */
export interface TaskInfo {
  task: string;
  /** Labels seen. */
  examples: number;
  /** Labels in the replay buffer. */
  buffered: number;
  /** Whether the adapter is being served: enough labels, and it beats the base model. */
  active: boolean;
  temperature: number;
  /** Running log loss of the base model on labels, each scored before it was learned from. */
  base_loss: number;
  /** The same for the adapter. */
  adapted_loss: number;
}

export interface ModelInfo {
  /** Name reported in responses, e.g. `cev-qwen3-0.6b`. */
  id: string;
  object: 'model';
  /** Hugging Face repo id or directory of the weights. */
  backbone: string;
  hidden_size: number;
  /** Most options one question can have. */
  max_options: number;
  prompt_version: string;
  /** CPU threads the tensor kernels use (process-wide). */
  threads: number;
  /** Forward passes that may run at once. */
  concurrency: number;
}

export interface OptionSpec {
  /** Key in `probabilities`. */
  name: string;
  /** Text the model saw for this option. */
  text: string;
}

/** A logged decision: one question of one request. */
export interface DecisionRecord {
  decision_id: string;
  request_id: string;
  question_id: string;
  model: string;
  task: string;
  kind: Question['type'];
  question: Question;
  options: OptionSpec[];
  /** The answer token of each option. */
  codes: string[];
  /** Prompt text after the request's shared prefix. */
  suffix: string;
  base_logits: number[];
  /** The distribution that was returned. */
  served: number[];
  adapted: boolean;
  /** Unix time in milliseconds. */
  created_at: number;
}

export interface FeedbackRecord {
  feedback_id: string;
  decision_id: string;
  label: Label | null;
  /** The label as a distribution over the decision's options. */
  target: number[] | null;
  weight: number;
  comment: string | null;
  metadata: unknown;
  created_at: number;
}

export interface DecisionDetail {
  decision: DecisionRecord;
  state: unknown;
  /** The exact text the model saw. */
  prompt: string | null;
  feedback: FeedbackRecord[];
}

export interface DecisionsPage {
  task?: string;
  /** Default 50, at most 1000. */
  limit?: number;
  offset?: number;
}

export interface ExportFilter {
  task?: string;
  /** Only decisions made by this model id. */
  model?: string;
  /** `true` (default): labelled decisions only. `false`: every decision. */
  labeled?: boolean;
  /** Only rows decided or labelled at or after this unix time in milliseconds. */
  since?: number;
  limit?: number;
}

/** One training row: exactly what the model saw, and what it should say. */
export interface ExportRow {
  decision_id: string;
  request_id: string;
  question_id: string;
  model: string;
  task: string;
  type: Question['type'];
  /** The full prompt; the answer is the next token. */
  prompt: string;
  codes: string[];
  options: string[];
  /** Target distribution over `options`; `null` for unlabelled rows. */
  target: number[] | null;
  label: Label | null;
  weight: number;
  served: number[];
  base_probabilities: number[];
  adapted: boolean;
  comment: string | null;
  metadata: unknown;
  state: unknown;
  question: Question;
  feedback_id: string | null;
  decided_at: number;
  labeled_at: number | null;
}

export interface Stats {
  store: { requests: number; decisions: number; feedback: number; labeled_decisions: number };
  /** Tasks with an adapter. */
  tasks: number;
  model: Omit<ModelInfo, 'threads' | 'concurrency'>;
}

/** What was compiled into the native addon, and the machine it runs on. */
export interface Info {
  version: string;
  /** Apple GPU support. */
  metal: boolean;
  /** Apple's BLAS for the CPU path. */
  accelerate: boolean;
  /** NVIDIA GPU support. */
  cuda: boolean;
  /** Logical cores. */
  cores: number;
  /** Performance cores on Apple Silicon, else `null`. */
  performanceCores: number | null;
  /** Size of the CPU pool; `null` until the first `Cev.load` sets it. */
  threads: number | null;
}

interface RuntimeOptions {
  /**
   * SQLite file for the decision log, feedback and adapters. Defaults to
   * `:memory:`, which is gone when the process exits.
   */
  db?: string;
  /** Learn from labels as they arrive (default true). When false, labels are only stored. */
  onlineLearning?: boolean;
  /** Keep hidden states with decisions (default true). Online learning from later feedback needs them. */
  storeFeatures?: boolean;
  /** Labels a task needs before its adapter may be served (default 8). */
  minExamples?: number;
  /** Default position-bias correction (default `full`). */
  debias?: Debias;
  /** Most option rotations per question when permuting (default 4). */
  maxPermutations?: number;
}

export interface LoadOptions extends RuntimeOptions {
  /** Hugging Face repo id or a local directory with Qwen3 safetensors (default `Qwen/Qwen3-1.7B`). */
  model?: string;
  /** Name reported as `model` in responses (default `cev-<model name>`). */
  name?: string;
  /** Default `auto`: Metal, then CUDA, then CPU, of those compiled in. */
  device?: 'auto' | 'cpu' | 'metal' | 'cuda';
  /** Default `auto`: f32 on CPU and for checkpoints up to 4 GB on Metal, else bf16. */
  dtype?: 'auto' | 'f32' | 'f16' | 'bf16';
  /** Longest prompt in tokens (default 32768, capped by the model). */
  maxContext?: number;
  /** Tokens of state prefixes kept for reuse across requests (default 65536). */
  prefixCacheTokens?: number;
  /**
   * CPU threads for the tensor kernels. Defaults to `RAYON_NUM_THREADS`, else
   * the performance cores. Process-wide: only the first load's value counts.
   */
  threads?: number;
  /** Forward passes that may run at once (default 1; keep 1 on a GPU). */
  concurrency?: number;
}

export type MockOptions = RuntimeOptions;
