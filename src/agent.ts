// The only module that talks to the Agent SDK for runs (DESIGN §5.4). Everything else goes through RunAgent,
// so the scheduler can be tested with a scripted fake.
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type { Options, SDKMessage, SDKUserMessage };

// interrupt() is present on the real Query; fakes may implement it to exercise the interrupt path.
export type AgentRun = AsyncIterable<SDKMessage> & { interrupt?(): Promise<unknown> };
export type RunAgent = (req: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AgentRun;

export const sdkRunAgent: RunAgent = ({ prompt, options }) => query({ prompt, options });

// Pushable prompt stream: the SDK keeps the session open until this iterable ends, which is how we steer.
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;
  private pushedCount = 0;
  private takenCount = 0;

  get isClosed(): boolean {
    return this.closed;
  }
  // Messages pushed / handed to the SDK so far; the scheduler uses them to tell which steered messages were read.
  get pushed(): number {
    return this.pushedCount;
  }
  get taken(): number {
    return this.takenCount;
  }

  push(text: string): void {
    if (this.closed) throw new Error('InputQueue is closed');
    const msg: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    this.pushedCount++;
    const w = this.waiters.shift();
    if (w) {
      this.takenCount++;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) {
          this.takenCount++;
          return Promise.resolve({ value: m, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.waiters.push(r));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
