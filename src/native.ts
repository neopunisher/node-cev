// Finds and loads the compiled addon (native/src/lib.rs). Everything crosses
// the boundary as JSON text; index.ts adds the types.
import { createRequire } from 'node:module';

export interface NativeCev {
  model(): string;
  decide(request: string): Promise<string>;
  examples(request: string): Promise<string>;
  feedback(request: string): Promise<string>;
  tasks(): Promise<string>;
  resetTask(task: string): Promise<string>;
  decisions(page: string): Promise<string>;
  decision(id: string): Promise<string>;
  export(filter: string): Promise<string>;
  stats(): Promise<string>;
  close(): void;
}

export interface Native {
  info(): string;
  open(options: string): Promise<NativeCev>;
}

/** `darwin-arm64`, `linux-x64-gnu`, ... Keep in step with scripts/build-native.mjs. */
export function target(): string {
  const { platform, arch } = process;
  if (platform !== 'linux') return `${platform}-${arch}`;
  const header = process.report.getReport() as unknown as { header?: { glibcVersionRuntime?: string } };
  return `linux-${arch}-${header.header?.glibcVersionRuntime ? 'gnu' : 'musl'}`;
}

function load(): Native {
  const require = createRequire(import.meta.url);
  const name = target();
  // CEV_NATIVE points at another build (say, one with CUDA); otherwise the
  // binary built into the package root, then a prebuilt platform package.
  const candidates = process.env.CEV_NATIVE ? [process.env.CEV_NATIVE] : [`../cev.${name}.node`, `node-cev-${name}`];
  const errors: string[] = [];
  for (const id of candidates) {
    try {
      return require(id) as Native;
    } catch (e) {
      const { code, message } = e as NodeJS.ErrnoException;
      // A binary that exists but will not load is the error worth showing.
      if (code !== 'MODULE_NOT_FOUND') throw e;
      errors.push(message.split('\n')[0]!);
    }
  }
  throw new Error(
    `node-cev: no native binary for ${name}. Build one with \`npm run build:native\` ` +
      `(needs Rust; see "Building from source" in the README).\n  ${errors.join('\n  ')}`,
  );
}

export const native: Native = load();
