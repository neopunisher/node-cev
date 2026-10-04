// cev for Node.js: typed, calibrated decisions in one forward pass, in-process.
import { native, type NativeCev } from './native.ts';
import type {
  DecideRequest,
  DecideResponse,
  DecisionDetail,
  DecisionRecord,
  DecisionsPage,
  Example,
  ExampleResult,
  ExportFilter,
  ExportRow,
  FeedbackRequest,
  FeedbackResponse,
  Info,
  LoadOptions,
  MockOptions,
  ModelInfo,
  Questions,
  Stats,
  TaskInfo,
} from './types.ts';

export type * from './types.ts';

export type CevErrorCode = 'bad_request' | 'not_found' | 'closed' | 'internal';

const CODES: readonly string[] = ['bad_request', 'not_found', 'closed', 'internal'] satisfies CevErrorCode[];

/** Every failure of this module. `code` says whose fault it was. */
export class CevError extends Error {
  /**
   * - `bad_request`: the call was malformed (unknown option, empty questions, ...)
   * - `not_found`: no such decision
   * - `closed`: the instance was closed
   * - `internal`: everything else (missing weights, I/O, ...)
   */
  readonly code: CevErrorCode;

  constructor(code: CevErrorCode, message: string) {
    super(message);
    this.name = 'CevError';
    this.code = code;
  }
}

/** The addon reports errors as `<code>: <message>`. */
function wrap(e: unknown): CevError {
  const message = e instanceof Error ? e.message : String(e);
  const split = message.indexOf(': ');
  const code = message.slice(0, split);
  return CODES.includes(code) ? new CevError(code as CevErrorCode, message.slice(split + 2)) : new CevError('internal', message);
}

async function call<T>(run: () => Promise<string>): Promise<T> {
  try {
    return JSON.parse(await run()) as T;
  } catch (e) {
    throw wrap(e);
  }
}

/** What was compiled into the native addon, and the machine it runs on. */
export function info(): Info {
  return JSON.parse(native.info()) as Info;
}

/**
 * A loaded model with its decision log. Nothing here blocks the event loop:
 * the work happens on native threads and every method returns a promise.
 */
export class Cev {
  readonly #native: NativeCev;
  /** The loaded model and how it runs. */
  readonly model: ModelInfo;

  private constructor(handle: NativeCev) {
    this.#native = handle;
    this.model = JSON.parse(handle.model()) as ModelInfo;
  }

  /**
   * Load a Qwen3 checkpoint from a directory or the Hugging Face cache,
   * downloading it into `~/.cache/cev/models` on first use.
   */
  static async load(options: LoadOptions = {}): Promise<Cev> {
    return Cev.#open(options);
  }

  /**
   * A keyword-overlap stand-in for the model: no weights, instant, and the
   * whole API works, including learning. For tests and wiring.
   */
  static async mock(options: MockOptions = {}): Promise<Cev> {
    return Cev.#open({ ...options, mock: true });
  }

  static async #open(options: object): Promise<Cev> {
    try {
      return new Cev(await native.open(JSON.stringify(options)));
    } catch (e) {
      throw wrap(e);
    }
  }

  /**
   * Answer every question about `state` in one forward pass. Concurrent calls
   * queue; `concurrency` of them run at a time.
   */
  decide<const Q extends Questions>(request: DecideRequest<Q>): Promise<DecideResponse<Q>> {
    return call(() => this.#native.decide(JSON.stringify(request)));
  }

  /** Attach a label or a comment to a past answer, and learn from the label. */
  feedback(request: FeedbackRequest): Promise<FeedbackResponse> {
    return call(() => this.#native.feedback(JSON.stringify(request)));
  }

  /** Decide each example, then apply its labels as feedback. */
  examples<const Q extends Questions>(examples: readonly Example<Q>[]): Promise<ExampleResult<Q>[]> {
    return call(() => this.#native.examples(JSON.stringify({ examples })));
  }

  /** The online adapter of every task that has labels. */
  tasks(): Promise<TaskInfo[]> {
    return call(() => this.#native.tasks());
  }

  /** Drop a task's adapter. Its labels stay in the log. Resolves to whether there was one. */
  resetTask(task: string): Promise<boolean> {
    return call(() => this.#native.resetTask(task));
  }

  /** Recent decisions, newest first. */
  decisions(page: DecisionsPage = {}): Promise<DecisionRecord[]> {
    return call(() => this.#native.decisions(JSON.stringify(page)));
  }

  /** One decision with its state, the exact prompt and all its feedback; `null` if unknown. */
  decision(id: string): Promise<DecisionDetail | null> {
    return call(() => this.#native.decision(id));
  }

  /** Training rows: one per labelled decision, or per decision with `labeled: false`. */
  async export(filter: ExportFilter = {}): Promise<ExportRow[]> {
    const text = await this.exportNdjson(filter);
    return text ? text.trimEnd().split('\n').map((line) => JSON.parse(line) as ExportRow) : [];
  }

  /** The same rows as newline-delimited JSON, the file `training/train_lora.py` reads. */
  async exportNdjson(filter: ExportFilter = {}): Promise<string> {
    try {
      return await this.#native.export(JSON.stringify(filter));
    } catch (e) {
      throw wrap(e);
    }
  }

  /** Counts of what is in the log. */
  stats(): Promise<Stats> {
    return call(() => this.#native.stats());
  }

  /**
   * Free the model once the calls already made have settled. Later calls
   * reject with code `closed`.
   */
  close(): void {
    this.#native.close();
  }
}
