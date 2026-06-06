import { PubSubMessage } from '../types/messages';
import { MessageRouter } from './messageRouter';
import { MeshReadinessMonitor } from '../libp2p/meshReadinessMonitor';
import { logger } from '../utils/logger';

interface QueueEntry {
  message: PubSubMessage;
  targetPeerId?: string;
  resolve: () => void;
  reject: (err: Error) => void;
  expires: number;
}

export class MeshMessageQueue {
  private _queue: QueueEntry[] = [];
  private _expireIntervalId: ReturnType<typeof setInterval>;

  constructor(
    private _monitor: MeshReadinessMonitor,
    private _router: MessageRouter,
    private _ttlMs: number = 8000
  ) {
    _monitor.on('ready', () => this._drain());
    // Reject stale entries that outlive the TTL without the mesh recovering
    this._expireIntervalId = setInterval(() => this._expireStale(), 1000);
  }

  async enqueue(message: PubSubMessage, targetPeerId?: string): Promise<void> {
    if (this._monitor.isReady()) {
      await this._router.sendMessage(message, targetPeerId);
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this._queue.push({ message, targetPeerId, resolve, reject, expires: Date.now() + this._ttlMs });
      logger.debug(`📥 Queued ${message.role} (mesh not ready, TTL ${this._ttlMs}ms)`);
    });
  }

  private async _drain(): Promise<void> {
    const entries = this._queue.splice(0);
    const now = Date.now();
    for (const entry of entries) {
      if (entry.expires <= now) {
        entry.reject(new Error(`Mesh not ready: TTL expired for "${entry.message.role}"`));
        continue;
      }
      try {
        await this._router.sendMessage(entry.message, entry.targetPeerId);
        entry.resolve();
      } catch (err: any) {
        entry.reject(err);
      }
    }
  }

  private _expireStale(): void {
    const now = Date.now();
    const stale = this._queue.filter(e => e.expires <= now);
    this._queue = this._queue.filter(e => e.expires > now);
    for (const e of stale) {
      e.reject(new Error(`Mesh not ready: TTL expired for "${e.message.role}"`));
    }
  }

  stop(): void {
    clearInterval(this._expireIntervalId);
  }
}
