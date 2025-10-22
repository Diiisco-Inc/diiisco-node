import environment from '../environment/environment'
import { EventEmitter } from 'events'
import { QuoteEvent, QuoteQueueEntry } from '../types/messages';
import { Environment } from '../environment/environment.types';

export default class quoteEngine {
  quoteQueue: { [key: string]: QuoteQueueEntry };
  waitTime: number;
  nodeEventEmitter: EventEmitter;

  constructor(nodeEvents: EventEmitter) {
    this.quoteQueue = {};
    this.waitTime = (environment as Environment).quoteEngine.waitTime || 5000; // default wait time 5 seconds
    this.nodeEventEmitter = nodeEvents;
  }

  async addQuote(quoteEvent: QuoteEvent) {
    if (!Object.keys(this.quoteQueue).includes(quoteEvent.msg.id)) {
      this.quoteQueue[quoteEvent.msg.id] = {
        quotes: [quoteEvent],
        timeout: setTimeout(() => {
          // Emit event that quote is ready
          this.nodeEventEmitter.emit(`quote-selected-${quoteEvent.msg.id}`, this.quoteQueue[quoteEvent.msg.id].quotes.sort((a: QuoteEvent, b: QuoteEvent) => a.msg.payload.quote.totalPrice - b.msg.payload.quote.totalPrice)[0]);
          // Clean up
          delete this.quoteQueue[quoteEvent.msg.id];
        }, this.waitTime)
      };
    } else {
      this.quoteQueue[quoteEvent.msg.id].quotes.push(quoteEvent);
    }
  }
}