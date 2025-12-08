import environment from '../environment/environment'
import { EventEmitter } from 'events'
import { QuoteEvent, QuoteQueueEntry, QuoteRequest } from '../types/messages';
import { Environment } from '../environment/environment.types';
import { selectHighestStakeQuote } from './quoteSelectionMethods';
import { OpenAIInferenceModel } from './models';
import { createQuoteFromInputTokens } from './quoteCreationMethods';
import { RawQuote } from '../types/quotes';

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
        timeout: setTimeout(async () => {
          // Select Quote based on selection function
          const selectionFunction = environment.quoteEngine.quoteSelectionFunction ?? selectHighestStakeQuote;
          const selectedQuote = await selectionFunction(this.quoteQueue[quoteEvent.msg.id].quotes);

          // Emit event that quote is ready
          this.nodeEventEmitter.emit(`quote-selected-${quoteEvent.msg.id}`, selectedQuote);

          // Clean up
          delete this.quoteQueue[quoteEvent.msg.id];
        }, this.waitTime)
      };
    } else {
      this.quoteQueue[quoteEvent.msg.id].quotes.push(quoteEvent);
    }
  }

  async createQuote(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel){
    const creationFunctionSetting = environment.quoteEngine.quoteCreationFunction ?? [createQuoteFromInputTokens];
    const creationFunctionArray: Function[] = Array.isArray(creationFunctionSetting) ? creationFunctionSetting : [creationFunctionSetting];
    
    for (const func of creationFunctionArray){
      const result: RawQuote = await func(quoteRequestMsg, model);
      if (result !== null){
        return result;
      }
    }

    return null
  }
}