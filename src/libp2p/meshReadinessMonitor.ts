import { EventEmitter } from 'events';
import { logger } from '../utils/logger';

export class MeshReadinessMonitor extends EventEmitter {
  private _ready: boolean = false;
  private _intervalId: ReturnType<typeof setInterval>;

  constructor(private _node: any, private _topic: string, private _min: number = 1) {
    super();
    // Deferred initial check: let pubsub settle before first evaluation
    setTimeout(() => this._updateState(), 100);
    // Re-evaluate shortly after a peer connects (subscription announcements trail the connection)
    _node.addEventListener('peer:connect', () => setTimeout(() => this._updateState(), 500));
    _node.addEventListener('peer:disconnect', () => this._updateState());
    // Background heartbeat catches subscription changes not surfaced by peer events
    this._intervalId = setInterval(() => this._updateState(), 1000);
  }

  private _updateState(): void {
    const count = this._node.services.pubsub.getSubscribers(this._topic).length;
    const nowReady = count >= this._min;
    if (nowReady && !this._ready) {
      this._ready = true;
      logger.info(`✅ Mesh ready on topic "${this._topic}" (${count} subscriber(s))`);
      this.emit('ready');
    } else if (!nowReady && this._ready) {
      this._ready = false;
      logger.warn(`⚠️  Mesh degraded on topic "${this._topic}" (${count} subscriber(s))`);
      this.emit('degraded');
    }
  }

  isReady(): boolean {
    return this._ready;
  }

  stop(): void {
    clearInterval(this._intervalId);
  }
}
