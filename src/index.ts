// Imports
import hasFlag from "has-flag";
import { getArgValue } from "./utils/argv";
import PeerId, * as peerId from 'peer-id';
import environment from "./environment/environment";
import path from "path";
import fs from "fs";

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { multiaddr } from '@multiformats/multiaddr';
import { gossipsub } from '@libp2p/gossipsub';
import { identify } from '@libp2p/identify';
import { identifyPush } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { mplex } from '@libp2p/mplex';

import { OpenAIInferenceModel } from "./utils/models";
import OpenAI from "openai";

import { encode, decode } from "msgpackr";
import algorand from "./utils/algorand";

import express from 'express';
import { requireBearer } from "./utils/endpoint";
import { sha256 } from "js-sha256";
import { EventEmitter } from 'events';
import quoteEngine from "./utils/quoteEngine";

// Get the ID for the Node
const loadPeerId = (): peerId.JSONPeerId | undefined => {
  try {
    const peerIdData = fs.readFileSync('./environment/peerId.json', 'utf-8');
    return JSON.parse(peerIdData) as peerId.JSONPeerId;
  } catch (error) {
    return undefined;
  }
};

const getPeerId = async (): Promise<PeerId> => {
  const loadedPeerId: peerId.JSONPeerId | undefined = loadPeerId();
  if (loadedPeerId) {
    console.log("✅ Loaded PeerID from environment/peerId.json:", loadedPeerId.id);
    return peerId.createFromJSON(loadedPeerId);
  } else {
    const newPeerId = await peerId.create({ bits: 1024, keyType: 'RSA' });
    const newPeerIdJSON = {
      id: newPeerId.toJSON().id,
      privKey: newPeerId.toJSON().privKey,
      pubKey: newPeerId.toJSON().pubKey
    };
    const peerIDJSON = JSON.stringify(newPeerIdJSON, null, 2);
    fs.writeFileSync(new URL('./environment/peerId.json', import.meta.url), peerIDJSON);
    
    console.log("👋 New PeerID Created and saved to environment/peerId.json");
    console.log("✅ Created PeerID:", newPeerIdJSON.id);

    return newPeerId;
  }
};

const createNode = async () => {
  const node = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/4321']
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    peerDiscovery: [mdns()],
    streamMuxers: [mplex()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true
      })
    }
  });

  await node.start()
  console.log('✅ Node started with id:', node.peerId.toString());

  // Show multiaddresses
  console.log('👂 Listening on:');
  node.getMultiaddrs().forEach(addr => console.log(`   ${addr.toString()}`));
  return node;
};

// Wait until someone else is actually subscribed to our topic
export async function waitForMesh(node: any, topic: string, { min = 1, timeoutMs = 10000 } = {}) {
  const start = Date.now()
  for (;;) {
    const subs = node.services.pubsub.getSubscribers(topic)
    if (subs.length >= min) return subs
    if (Date.now() - start > timeoutMs) throw new Error(`No peers in topic "${topic}"`)
    await new Promise(r => setTimeout(r, 300))
  }
}

//Define the Main Function
const main = async () => {
  //Create the Algorand Object
  const algo = new algorand();

  // Create the Node
  const node = await createNode();
  const topics: string[] = [node.peerId.toString()]; //Always Subscribe to Your Own PeerID Topic
  node.services.pubsub.subscribe(node.peerId.toString());

  const nodeEvents: EventEmitter = new EventEmitter();
  const quoteMgr: quoteEngine = new quoteEngine(nodeEvents);

  if (hasFlag("api-access")) {
    //Create Express App
    const app = express();
    const port = environment.api.port || 8181;

    //Middleware
    app.use(express.json());

    if (environment.api.bearerAuthentication) {
      app.use("/v1", requireBearer);
    }

    //Define a Health Check Endpoint
    app.get('/health', (req, res) => {
      res.status(200).send('API is healthy');
    });

    // Define the Chat Completion Endpoint
    app.post(`/v1/chat/completions`, async (req, res) => {
      console.log("🚀 Received /v1/chat/completions request.");
      // Validate Request Body
      if (!req.body || !req.body.model || !req.body.inputs) {
        return res.status(400).send({ error: "Missing model or messages in request body." });
      };

      // Create the Quote Request Message
      const quoteMessage = {
        role: "quote-request",
        from: node.peerId.toString(),
        paymentSourceAddr: environment.algorand.addr,
        timestamp: Date.now(),
        id: `${Date.now()}-${sha256(JSON.stringify(req.body))}`,
        payload: {
          ...req.body
        }
      };
      
      // Publish the Quote Request to the Model Topic
      //await waitForMesh(node, `models/${req.body.model}`, { min: 1, timeoutMs: 15000 })
      node.services.pubsub.publish(`models/${req.body.model}`, encode(quoteMessage));
      console.log(`📤 Published message to 'models/${req.body.model}'. ID: ${quoteMessage.id}`);

      // Wait for the Inference Response
      nodeEvents.once(`inference-response-${quoteMessage.id}`, (response: any) => {
        console.log(`🚀 Sending inference response for request ID ${quoteMessage.id}:`, response);
        res.status(200).send(response.payload.completion);
      });

      // Listen for a Quote Selection
      nodeEvents.once(`quote-selected-${quoteMessage.id}`, async (quote: any) => {
        console.log(`✅ Quote selected for request ID ${quoteMessage.id}:`, quote.msg);

        // Create the Quote Accepted Message
          let acceptance = {
            role: 'quote-accepted',
            timestamp: Date.now(),
            id: quote.msg.id,
            paymentSourceAddr: environment.algorand.addr,
            payload: {
              ...quote.msg.payload,
            }
          };


          // Send the quote-accepted back to the sender's topic
          node.services.pubsub.publish(quote.from.toString(), encode(acceptance));
          console.log(`📤 Sent quote-accepted to ${quote.from.toString()}: ${JSON.stringify(acceptance)}`);
      });
    });

    // Start the Express Server
    app.listen(port, () => {
      console.log(`🚀 API server listening at http://localhost:${port}`);
    });
  }

  if (hasFlag("serve-models")) {
    // See What Models are Available from the Inference Server
    const model = new OpenAIInferenceModel(`${environment.models.baseURL}:${environment.models.port}/v1`);
    const models = await model.getModels();
    // topics.push('models');  //General Models Topic

    // Prepare the Topics && Subscribe to a Topic for All Models
    node.services.pubsub.subscribe('models');

    // Subscribe to a topic for each model
    models.filter((m: OpenAI.Models.Model) => m.object == 'model').forEach((modelInfo: OpenAI.Models.Model) => {
      node.services.pubsub.subscribe(`models/${modelInfo.id}`);
      topics.push(`models/${modelInfo.id}`);
      console.log(`🤖 Serving Model: ${modelInfo.id}`);
    });


    //Listen to Requests
    node.services.pubsub.addEventListener('message', async (evt: any) => {
      if (topics.includes(evt.detail.topic)) {
        // Decode the Message
        const msg = decode(evt.detail.data);

        // Role: Quote Request
        if (msg.role == 'quote-request'){
          // Check the Requester has the means to Pay
          const x = await algo.checkIfOptedIn(msg.paymentSourceAddr, environment.algorand.paymentAssetId);
          if (!x.optedIn || Number(x.balance) <= 0) {
            console.log(`❌ Quote request from ${msg.paymentSourceAddr} cannot be fulfilled - not opted in or zero balance.`);
            return; //Cannot Fulfill Request
          }

          // Calculate a Quote
          const tokenCount: number = await model.countEmbeddings(msg.payload.model, msg.payload.inputs);
          const modelRate = environment.models.chargePer1KTokens[msg.payload.model] || environment.models.chargePer1KTokens.default || 0.000001; //Default Rate if Model Not Found
          let response = {
            role: 'quote-response',
            timestamp: Date.now(),
            id: msg.id,
            paymentSourceAddr: environment.algorand.addr,
            payload: {
              ...msg.payload,
              quote: {
                model: msg.payload.model,
                inputCount: msg.payload.inputs.length,
                tokenCount: tokenCount,
                pricePer1K: modelRate,
                totalPrice: (tokenCount / 1000) * modelRate,
                addr: algo.addr,
              },
              signature: ''
            }
          };

          //Sign the Quote
          response.payload.signature = await algo.signObject(response.payload.quote);

          // Send the quote-response back to the sender's topic
          node.services.pubsub.publish(evt.detail.from.toString(), encode(response));
          console.log(`📤 Sent quote-response to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
        }

        // Role: Quote Response
        if (msg.role == 'quote-response') {
          console.log(`📥 Received quote-response: ${JSON.stringify(msg)}`);
          quoteMgr.addQuote({msg: msg, from: evt.detail.from.toString()});  
        }

        // Role: Quote Accepted
        if (msg.role == 'quote-accepted') {
          const validQuote: boolean = await algo.verifySignature(msg.payload.quote, msg.payload.signature);
          if (validQuote) {
            const completion = await model.getResponse(msg.payload.model, msg.payload.inputs);
            let response = {
              role: 'inference-response',
              timestamp: Date.now(),
              id: msg.id,
              paymentSourceAddr: environment.algorand.addr,
              payload: {
                ...msg.payload,
                completion: completion,
              }
            };
            
            // Send the inference-response back to the sender's topic
            node.services.pubsub.publish(evt.detail.from.toString(), encode(response));
            console.log(`📤 Sent inference-response to ${evt.detail.from.toString()}: ${JSON.stringify(response)}`);
          }
        }

        // Role: Inference Response
        if (msg.role == 'inference-response') {
          console.log(`📥 Received inference-response: ${JSON.stringify(msg)}`);
          
          // Make the Payment
          const payment = await algo.makePayment(msg.payload.quote.addr, msg.payload.quote.totalPrice);
          nodeEvents.emit(`inference-response-${msg.id}`, { ...msg, payment: payment, quote: msg.payload.quote });
        }
      }
    });

    node.addEventListener('peer:discovery', async (e) => {
      const id = e.detail.id
      console.log('👋 Discovered Peer:', id.toString())
      try { await node.dial(id); console.log('✅ Connected to Peer:', id.toString()) } catch {}
    });
  }
};

// Start the Server
main();