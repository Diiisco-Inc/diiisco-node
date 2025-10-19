import environment from '../environment/environment'
import { EventEmitter } from 'events'

export default class quoteEngine {
  quoteQueue: {[key: string]: any};
  waitTime: number;
  nodeEventEmitter: EventEmitter;

  constructor(nodeEvents: EventEmitter) {
    this.quoteQueue = {};
    this.waitTime = environment.quoteEngine.waitTime || 5000; // default wait time 5 seconds
    this.nodeEventEmitter = nodeEvents;
  }

  async addQuote(quoteEvent: any){
    if (!Object.keys(this.quoteQueue).includes(quoteEvent.msg.id)) {
      this.quoteQueue[quoteEvent.msg.id] = {
        quotes: [quoteEvent],
        timeout: setTimeout(() => {
          // Emit event that quote is ready
          this.nodeEventEmitter.emit(`quote-selected-${quoteEvent.msg.id}`, this.quoteQueue[quoteEvent.msg.id].quotes.sort((a: any, b: any) => a.msg.payload.quote.totalPrice - b.msg.payload.quote.totalPrice)[0]);
          // Clean up
          delete this.quoteQueue[quoteEvent.msg.id];
        }, this.waitTime)
      };
    } else {
      this.quoteQueue[quoteEvent.msg.id].quotes.push(quoteEvent);
    }
  }
}